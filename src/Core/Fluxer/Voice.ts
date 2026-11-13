import { EventEmitter } from 'node:events'
import { readdirSync, statSync, unlinkSync } from 'node:fs'
import { setTimeout as sleep } from 'node:timers/promises'
import { TimeoutError, waitUntil } from 'async-wait-until'
import { debounce } from 'lodash'
import type { ILogObj, Logger } from 'tslog'
import type { MediaStreamTrack } from 'werift'
import type { FluxerChannel } from '../../Utils/Config'
import { instances } from '../../Utils/Instances'
import { Recorder } from '../Discord/Recorder/Recorder'
import type { IRecordFile } from '../Discord/Recorder/RecordSaver'
import * as Destinations from '../Output/Destinations'
import type { VoicePresenceTracker } from './Presence'
import { LiveKitSession, type RemoteTrackInfo } from './Voice/LiveKitSession'
import type { FluxerVoiceConnection, FluxerVoiceManager, VoiceGrant } from './Voice/Manager'
import { TrackReceiver } from './Voice/TrackReceiver'

// Backoff 1 s to 30 s, about a minute in total (as VoiceLog)
const RECONNECT_ATTEMPTS = 6

// One recorded Fluxer voice channel: joins and records while someone is in it. The recording lifecycle is copied from
// DiscordVoice on purpose; restructure R3 merges both into one RecordingSession (plan §8).
// Fluxer shows the bot in the channel only once it is in the LiveKit room. A lost LiveKit session is reconnected while
// the recording goes on; the recording ends with the gateway connection (left, kicked, moved, or reconnecting failed).
/**
 * @emits status - the recording started or stopped
 */
export class FluxerVoice extends EventEmitter {
  private channelConfig: FluxerChannel
  private logger: Logger<ILogObj>
  private manager: FluxerVoiceManager
  private tracker: VoicePresenceTracker
  private selfId: () => string
  private notifyAdmins: (message: string) => Promise<void>
  private recorder: Recorder
  private connection: FluxerVoiceConnection | undefined
  private session: LiveKitSession | undefined
  private endpoint = ''
  // The latest LiveKit access token, from the gateway grant or a LiveKit refresh; a secret: never log it
  private token = ''
  // A new connection or a close makes the work of the earlier one stale
  private generation = 0
  private reconnecting = false
  // The first session of a connection is being opened; a grant meanwhile must not open another
  private opening = false
  private sendInterval: NodeJS.Timeout | undefined
  private cleanupInterval: NodeJS.Timeout | undefined
  private _active = false
  private readyToDelete = true
  // Set on shutdown: the bot's own leave is a change in the channel, which must not join again
  private stopped = false

  constructor(
    instanceId: string,
    channelConfig: FluxerChannel,
    manager: FluxerVoiceManager,
    tracker: VoicePresenceTracker,
    selfId: () => string,
    notifyAdmins: (message: string) => Promise<void>,
    logger: Logger<ILogObj>
  ) {
    super()
    this.channelConfig = channelConfig
    this.notifyAdmins = notifyAdmins
    this.manager = manager
    this.tracker = tracker
    this.selfId = selfId
    this.logger = logger.getSubLogger({ name: 'Voice', prefix: [`[${channelConfig.id}]`] })
    const storageKey = `fluxer-${instanceId}-${channelConfig.id}`
    this.recorder = new Recorder({ ...channelConfig, storageKey })
    this.startStaleCleanup(`temp/${storageKey}`)
  }

  public get guildId() {
    return this.channelConfig.guildId
  }

  public get active() {
    return this._active
  }

  // Someone entered or left the channel, or the guild's voice states were reloaded
  public update = debounce(() => {
    if (this.stopped) return
    const users = this.tracker.usersIn(this.channelConfig.guildId, this.channelConfig.id)
    // The guild is not known yet (no snapshot) or was lost: wait for the next snapshot
    if (!users) return
    // As DiscordVoice: everyone but ignored users and the bot itself counts, other bots too
    const present = users.filter((user) => !this.channelConfig.ignoreUsers.includes(user) && user !== this.selfId())
    this.logger.debug(`Users in channel: ${present.join(', ') || '(none)'}`)

    if (present.length === 0) {
      if (!this.connection) return
      this.logger.info('No user in the channel, leaving...')
      if (this._active) {
        this.sendMessage('No user in the channel, pausing...')
        this.sendAdminMessage(`No user in ${this.channelConfig.id}, recorder pausing...`)
      }
      this.connection.leave()
    } else if (!this.connection) {
      this.join()
    }
  }, 500)

  // Ends the recording, sends the rest, and waits up to 30 s for it, as DiscordVoice.stop
  public async stop() {
    this.stopped = true
    this.update.cancel()
    clearInterval(this.cleanupInterval)
    if (!this.connection) return
    this.logger.info('Shutting down...')
    if (this._active) {
      this.sendMessage('Recorder shutting down.')
      this.sendAdminMessage(`Recorder ${this.channelConfig.id} shutting down.`)
    }
    this.connection.leave()
    try {
      await waitUntil(() => this.readyToDelete, { timeout: 30 * 1000 })
    } catch (error) {
      if (error instanceof TimeoutError) this.logger.error('Timed out waiting for 30 seconds.', error)
      else throw error
    }
  }

  private join() {
    const connection = this.manager.join(this.channelConfig.guildId, this.channelConfig.id)
    this.connection = connection
    const generation = ++this.generation
    this.endpoint = ''
    connection.on('grant', (grant: VoiceGrant) => this.onGrant(generation, grant))
    // After a kick or a lost session the bot's own leave changes the channel, so update() joins again while someone is there, as Discord reconnects
    connection.once('closed', () => {
      if (this.connection !== connection) return
      this.connection = undefined
      this.generation++
      this.reconnecting = false
      this.session?.close()
      this.session = undefined
      this.stopRecording()
    })
  }

  private onGrant(generation: number, grant: VoiceGrant) {
    if (generation !== this.generation) return
    const moved = this.endpoint !== '' && grant.endpoint !== this.endpoint
    this.endpoint = grant.endpoint
    this.token = grant.token
    if (!this.session && !this.reconnecting && !this.opening) {
      // The first grant of the connection
      this.opening = true
      this.openSession(generation)
        .then(
          () => this.startRecording(),
          (error) => {
            this.logger.error(`Joining the LiveKit room failed: ${error instanceof Error ? error.message : error}`)
            if (generation === this.generation) this.connection?.leave()
          }
        )
        .finally(() => {
          this.opening = false
        })
    } else if (moved && this.session) {
      // A new voice server for the connection; a token refresh alone keeps the session
      this.logger.warn('The voice server changed, reconnecting...')
      this.onSessionLost(this.session, false, true)
    }
  }

  private async openSession(generation: number) {
    const session = new LiveKitSession(this.endpoint, this.token)
    session.on('event', (type: string, data: object) => {
      if (type === 'refresh-token') this.token = session.token
      this.logger.debug(`LiveKit ${type} ${JSON.stringify(data)}`)
    })
    session.on('track', (track: MediaStreamTrack, info: RemoteTrackInfo | undefined) => this.onTrack(track, info))
    session.on('trackEnded', (info: RemoteTrackInfo) => {
      if (info.userId && info.connectionId && info.source === 'MICROPHONE') this.recorder.endSource(`${info.userId}-${info.connectionId}`, `${info.connectionId}:${info.trackSid}`)
    })
    session.once('lost', (fatal: boolean, reason: string) => {
      this.logger.warn(`LiveKit session lost: ${reason}`)
      this.onSessionLost(session, fatal)
    })
    try {
      await session.open()
    } catch (error) {
      session.close()
      throw error
    }
    if (generation !== this.generation || session.lost) {
      session.close()
      throw new Error(session.lost ? 'the session dropped right after opening' : 'the connection ended meanwhile')
    }
    this.session = session
    this.logger.info(`In the LiveKit room for connection ${this.connection?.connectionId}`)
    return session
  }

  // Reconnecting gives each track a new receiver on the same source, so the recording goes on where it stopped
  private onTrack(track: MediaStreamTrack, info: RemoteTrackInfo | undefined) {
    if (!info?.userId || !info.connectionId) {
      // Not guessed: a track nobody can be named for is left out
      this.logger.warn(`A track could not be matched to a user (${info?.identity ?? `ssrc ${track.ssrc}`}), not recorded`)
      return
    }
    // Checked here: the Recorder only sees the per-connection name below
    if (this.channelConfig.ignoreUsers.includes(info.userId)) return
    this.logger.info(`Receiving ${info.userId} (connection ${info.connectionId}, track ${info.trackSid})`)
    // Per-user files are per connection: <userId>-<connectionId>-<start>.mp3, so one person on two devices gets two files
    new TrackReceiver(track, { ...info, userId: `${info.userId}-${info.connectionId}` }, this.recorder, () => this._active, this.logger)
  }

  // immediate: reconnect without waiting first (a new voice server); fatal: removed by the server, so the recording ends
  private onSessionLost(session: LiveKitSession, fatal: boolean, immediate = false) {
    if (session !== this.session) return
    this.session = undefined
    session.close()
    if (fatal) {
      this.connection?.leave()
      return
    }
    this.reconnect(immediate)
  }

  private async reconnect(immediate: boolean) {
    if (this.reconnecting) return
    this.reconnecting = true
    const generation = this.generation
    for (let attempt = 0; attempt < RECONNECT_ATTEMPTS && generation === this.generation && !this.session; attempt++) {
      if (!immediate || attempt > 0) await sleep(Math.min(1000 * 2 ** attempt, 30 * 1000))
      if (generation !== this.generation) return
      try {
        await this.openSession(generation)
        this.logger.info(`Reconnected (attempt ${attempt + 1})`)
      } catch (error) {
        this.logger.warn(`Reconnect attempt ${attempt + 1} failed: ${error instanceof Error ? error.message : error}`)
      }
    }
    if (generation !== this.generation) return
    this.reconnecting = false
    if (!this.session) {
      this.logger.error('Reconnecting to the voice server failed')
      this.sendAdminMessage(`Reconnecting ${this.channelConfig.id} to the voice server failed, recorder stopping.`)
      this.connection?.leave()
    }
  }

  private startRecording() {
    if (this._active) return
    this._active = true
    this.readyToDelete = false
    this.recorder.startStream()
    this.startSendRecord()
    this.sendMessage('Record session started')
    this.emit('status')
  }

  private stopRecording() {
    if (!this._active) return
    this._active = false
    clearInterval(this.sendInterval)
    this.emit('status')
    this.logger.info('Sending rest of recording...')
    const file = this.recorder.stop()
    this.sendRecord(file)
      .then(() => this.sendMessage('The record session has ended.'))
      // Logged in sendRecord; caught so a failed upload does not crash the bot, and the file stays for stale cleanup
      .catch(() => undefined)
      .finally(() => {
        if (!this._active) this.readyToDelete = true
      })
  }

  private startSendRecord() {
    this.sendInterval = setInterval(() => {
      const file = this.recorder.saver.getFilePeriod()
      this.sendRecord(file)
        .then(() => this.recorder.saver.removeRecordFile(file.start))
        .catch(() => undefined)
    }, this.channelConfig.sendIntervalSecond * 1000)
  }

  private startStaleCleanup(dir: string) {
    const maxAge = 24 * 60 * 60 * 1000 // 24 hours
    this.cleanupInterval = setInterval(
      () => {
        try {
          for (const f of readdirSync(dir)) {
            if (!f.endsWith('.mp3')) continue
            const p = `${dir}/${f}`
            if (Date.now() - statSync(p).mtimeMs > maxAge) {
              unlinkSync(p)
              this.logger.warn(`Cleaned up stale recording: ${f}`)
            }
          }
        } catch {
          // temp dir may not exist yet
        }
      },
      60 * 60 * 1000
    )
  }

  private sendMessage(message: string) {
    return Destinations.sendMessage(this.channelConfig.fileDest, instances.discord?.client, message).catch((error) =>
      this.logger.error(`Message "${message}" failed to send:`, error)
    )
  }

  // Telegram admins and the instance's Fluxer admins; Discord admins only get Discord channels' messages, as before
  private sendAdminMessage(message: string) {
    return Promise.all([Destinations.sendAdminMessage(undefined, this.logger, message), this.notifyAdmins(message)])
  }

  private async sendRecord(file: IRecordFile) {
    const maxRetries = 3
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        await Destinations.sendRecord(this.channelConfig.fileDest, instances.discord?.client, this.logger, this.channelConfig.id, file)
        return // success
      } catch (error) {
        this.logger.error(`Error sending ${file.audioFileName} (attempt ${attempt}/${maxRetries}):`, error)
        if (attempt === maxRetries) {
          // Also after the session ended (DiscordVoice skips it then): the rest of a recording should not fail quietly
          this.sendAdminMessage(`Failed to send ${file.audioFileName} after ${maxRetries} attempts`)
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, 5000))
      }
    }
  }
}
