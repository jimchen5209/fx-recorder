import { EventEmitter } from 'node:events'
import { type Client, DiscordRESTError, type VoiceChannel, type VoiceConnection } from '@projectdysnomia/dysnomia'
import { debounce } from 'lodash'
import type { ILogObj, Logger } from 'tslog'
import { getApp } from '../App/App'
import * as Destinations from '../Delivery/Delivery'
import { RecordingSession } from '../Recording/RecordingSession'
import type { DiscordChannel } from '../Shared/Config'
import { FailSafe } from '../Shared/FailSafe'
import { MessageQueue } from '../Shared/MessageQueue'
import { Silence } from './Silence'

export class DiscordVoice extends EventEmitter {
  private client: Client
  private channelConfig: DiscordChannel
  private logger: Logger<ILogObj>
  private recording: RecordingSession
  private delivery: Destinations.Delivery
  private rejoinTimer: NodeJS.Timeout | undefined

  private _active = false
  // Set on shutdown: nothing joins the channel again
  private stopped = false
  // A join is running: member events meanwhile must not start another one
  private joining = false
  // The connection being recorded; a second start on it would add a second receiver and record every packet twice
  private recordingOn: VoiceConnection | undefined

  private warningQueue = new MessageQueue(1000)
  private errorQueue = new MessageQueue(1000)
  private errorFailSafe = new FailSafe()
  private reconnectFailSafe = new FailSafe()

  constructor(client: Client, channelConfig: DiscordChannel, logger: Logger<ILogObj>) {
    super()

    this.client = client
    this.channelConfig = channelConfig
    this.logger = logger.getSubLogger({ name: 'Voice', prefix: [`[${channelConfig.id}]`] })
    // Admins hear of a recording that could not be sent only while recording
    this.delivery = new Destinations.Delivery(channelConfig, this.logger, (message) => {
      if (this._active) this.sendAdminMessage(message)
    })
    const app = getApp()
    this.recording = new RecordingSession(
      { ...channelConfig, storageKey: channelConfig.id },
      {
        mainLogger: app.mainLogger,
        logger: this.logger,
        debug: app.config.logging.debug,
        deliver: (file) => this.delivery.deliver(file),
        announce: (message) => this.sendMessage(message)
      }
    )

    this.warningQueue.on('process', (messages, queueTime) => {
      const combinedMessage = `${messages.length} warning${messages.length > 1 ? 's' : ''} from ${this.channelConfig.id} in ${queueTime / 1000} seconds:\n\`\`\`\n${messages.slice(-10).join('\n')}\n\`\`\``

      this.sendAdminMessage(combinedMessage)
    })

    this.errorQueue.on('process', (messages, queueTime) => {
      const combinedMessage = `${messages.length} error${messages.length > 1 ? 's' : ''} from ${this.channelConfig.id} in ${queueTime / 1000} seconds:\n\`\`\`\n${messages.slice(-10).join('\n')}\n\`\`\``
      this.sendAdminMessage(combinedMessage)
    })

    this.autoLeaveOrJoinChannel()
  }

  private async startAudioSession(channelID: string) {
    // The connection is not listed until the join ends, so the check in autoLeaveOrJoinChannel cannot see it
    if (this.joining) return
    this.joining = true
    try {
      for (let retryCount = 1; retryCount <= 5; ++retryCount) {
        const connection = await this.joinVoiceChannel(channelID)
        if (connection !== undefined) {
          this.logger.info('Connected, start recording...')
          connection.play(new Silence(), { format: 'opusPackets' })
          this.startRecording(connection)
          return
        }
        this.logger.error(`Connecting to voice channel failed. Retrying (${retryCount} / 5)...`)
      }
    } finally {
      this.joining = false
    }
    this._active = false
    this.logger.fatal('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')

    await this.sendMessage('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')
  }

  private onPcm = (data: Buffer, user: string) => {
    if (!this._active) return
    this.recording.recorder.storeBuffer(data, user)
  }

  private onUserDisconnect = (user: string) => this.handleUserDisconnect(user)

  private startRecording(connection: VoiceConnection) {
    if (this.recordingOn === connection) return
    this.recordingOn = connection
    this._active = true
    connection.on('userDisconnect', this.onUserDisconnect)
    this.recording.start()
    connection.receive('pcm').on('data', this.onPcm)

    this.updateStatus()
  }

  private updateStatus() {
    const guild = (this.client.getChannel(this.channelConfig.id) as VoiceChannel).guild

    guild.editMember('@me', { nick: this._active ? `🔴 ${this.client.user.username}` : '' }).catch((error) => {
      if (error instanceof DiscordRESTError) {
        this.logger.warn(`Failed to update nickname: ${error.message}`)
      } else if (error instanceof Error) {
        this.logger.error(`Failed to update status: ${error.message}`, error)
      }
    })
    this.emit('status')
  }

  private sendMessage(message: string) {
    return this.delivery.sendMessage(message)
  }

  private sendAdminMessage(message: string) {
    return Destinations.sendAdminMessage(this.client, this.logger, message)
  }

  private stopSession(channelID: string, connection: VoiceConnection) {
    // Off with the session, so a connection used again gets one receiver
    connection.off('userDisconnect', this.onUserDisconnect)
    connection.receive('pcm').off('data', this.onPcm)
    if (this.recordingOn === connection) this.recordingOn = undefined
    connection.stopPlaying()
    this.recording.stop()
    this.client.leaveVoiceChannel(channelID)
  }

  // Ends the recording if one is running, and resolves once every segment still being finished or sent is done, also
  // for a channel that is paused. Calling it again sends nothing twice. The caller sets the deadline.
  public async stop() {
    this.stopped = true
    this.autoLeaveOrJoinChannel.cancel()
    this.tryReconnect.cancel()
    clearTimeout(this.rejoinTimer)

    const connection = this.client.voiceConnections.find((connection) => connection.channelID === this.channelConfig.id)
    if (connection) {
      this._active = false
      this.updateStatus()

      this.logger.info('Shutting down...')
      this.recording.track(this.sendMessage('Recorder shutting down.'))
      this.recording.track(this.sendAdminMessage(`Recorder ${this.channelConfig.id} shutting down.`))

      this.stopSession(this.channelConfig.id, connection)
    }

    await this.recording.close()
  }

  private tryReconnect = debounce((channelID: string, connection: VoiceConnection) => {
    this.stopSession(channelID, connection)
    if (this.reconnectFailSafe.checkHitExceed()) {
      this.logger.error(`Reconnect count exceeded ${this.reconnectFailSafe.maxTimes}. Trying to reconnect bot...`)
      if (this._active) this.sendAdminMessage(`Reconnect count exceeded ${this.reconnectFailSafe.maxTimes}. Trying to reconnect bot...`)
      getApp().discord?.reconnect()
    }
    this.rejoinTimer = setTimeout(() => {
      if (!this.stopped) this.startAudioSession(channelID)
    }, 5 * 1000)
  }, 500)

  private async joinVoiceChannel(channelID: string): Promise<VoiceConnection | undefined> {
    this.logger.info('Connecting...')
    try {
      const connection = await this.client.joinVoiceChannel(channelID)
      connection.on('warn', (message: string) => {
        this.logger.warn(message)
        if (this._active) this.warningQueue.addMessage(message)
      })
      connection.on('error', (err) => {
        this.logger.error(err.message, err)
        if (this._active) this.errorQueue.addMessage(err.message)
        if (this.errorFailSafe.checkHitExceed()) {
          this.logger.error(`Error count exceeded ${this.errorFailSafe.maxTimes}. Reconnecting...`)
          if (this._active) this.sendAdminMessage(`Error count exceeded ${this.errorFailSafe.maxTimes}. Reconnecting...`)
          this._active = false
          this.tryReconnect(channelID, connection)
        }
      })
      if (getApp().config.logging.debug) {
        connection.on('debug', (message) => this.logger.debug(message))
      }
      connection.on('ready', () => {
        this.logger.warn('Voice connection reconnected.')
        this.errorFailSafe.resetError()
        this.reconnectFailSafe.resetError()
      })
      connection.once('disconnect', (err) => {
        this.logger.error(`Error from voice connection: ${err?.message}`, err)
        if (this._active) {
          this.sendAdminMessage(`Error from voice connection ${channelID}: ${err?.message}`)
          this.sendMessage('There is an error with the voice connection.')
          this.tryReconnect(channelID, connection)
        }
      })
      return connection
    } catch (e) {
      if (e instanceof Error) {
        this.logger.error(`${e.name} ${e.message}`, e)
        this.sendAdminMessage(`Error from ${channelID}: ${e.name} ${e.message}`)
      }
    }
    return undefined
  }

  public handleUserConnect() {
    this.autoLeaveOrJoinChannel()
  }

  public handleUserDisconnect(userID: string) {
    this.recording.recorder.endStream(userID)
    this.autoLeaveOrJoinChannel()
  }

  private autoLeaveOrJoinChannel = debounce(() => {
    if (this.stopped) return
    const voiceChannel = this.client.getChannel(this.channelConfig.id) as VoiceChannel
    let noUser = true

    this.logger.debug(`Members in channel : ${voiceChannel.voiceMembers?.map((user) => user.id).join(', ')}`)
    voiceChannel.voiceMembers?.forEach((user) => {
      if (!this.channelConfig.ignoreUsers.includes(user.id) && user.id !== this.client.user.id) {
        this.logger.debug(`User in channel : ${user.id}`)
        noUser = false
      }
    })
    this.logger.debug(`No user in channel : ${noUser}`)

    const connection = this.client.voiceConnections.find((connection) => connection.channelID === this.channelConfig.id)
    this.logger.debug(`Connection in channel exist : ${connection !== undefined}`)
    if (noUser) {
      if (connection) {
        this._active = false
        this.updateStatus()

        this.logger.info('Pausing...')
        this.sendMessage('No user in the channel, pausing...')
        this.sendAdminMessage(`No user in ${this.channelConfig.id}, recorder pausing...`)

        this.stopSession(this.channelConfig.id, connection)
      }
    } else {
      if (!connection) {
        this.startAudioSession(this.channelConfig.id)
      }
    }
  }, 500)

  public get active() {
    return this._active
  }
}
