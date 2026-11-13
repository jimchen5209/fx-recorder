import { debounce } from 'lodash'
import type { ILogObj, Logger } from 'tslog'
import type { FluxerChannel } from '../../Utils/Config'
import type { VoicePresenceTracker } from './Presence'
import { LiveKitSession } from './Voice/LiveKitSession'
import type { FluxerVoiceConnection, FluxerVoiceManager, VoiceGrant } from './Voice/Manager'

// One recorded Fluxer voice channel: joins while someone is in it, as DiscordVoice does. Recording comes in P4.
// Fluxer shows the bot in the channel only once it is in the LiveKit room, so each grant opens a session.
export class FluxerVoice {
  private channelConfig: FluxerChannel
  private logger: Logger<ILogObj>
  private manager: FluxerVoiceManager
  private tracker: VoicePresenceTracker
  private selfId: () => string
  private connection: FluxerVoiceConnection | undefined
  private session: LiveKitSession | undefined

  constructor(channelConfig: FluxerChannel, manager: FluxerVoiceManager, tracker: VoicePresenceTracker, selfId: () => string, logger: Logger<ILogObj>) {
    this.channelConfig = channelConfig
    this.manager = manager
    this.tracker = tracker
    this.selfId = selfId
    this.logger = logger.getSubLogger({ name: 'Voice', prefix: [`[${channelConfig.id}]`] })
  }

  public get guildId() {
    return this.channelConfig.guildId
  }

  // Someone entered or left the channel, or the guild's voice states were reloaded
  public update = debounce(() => {
    const users = this.tracker.usersIn(this.channelConfig.guildId, this.channelConfig.id)
    // The guild is not known yet (no snapshot) or was lost: wait for the next snapshot
    if (!users) return
    // As DiscordVoice: everyone but ignored users and the bot itself counts, other bots too
    const present = users.filter((user) => !this.channelConfig.ignoreUsers.includes(user) && user !== this.selfId())
    this.logger.debug(`Users in channel: ${present.join(', ') || '(none)'}`)

    if (present.length === 0) {
      if (!this.connection) return
      this.logger.info('No user in the channel, leaving...')
      this.connection.leave()
    } else if (!this.connection) {
      const connection = this.manager.join(this.channelConfig.guildId, this.channelConfig.id)
      this.connection = connection
      connection.on('grant', (grant: VoiceGrant) => this.openSession(connection, grant))
      connection.once('closed', () => {
        // Not joined again right away (e.g. after a kick): the next change in the channel does it
        if (this.connection === connection) this.connection = undefined
        this.session?.close()
        this.session = undefined
      })
    }
  }, 500)

  // shortcut: a later grant (token refresh, new voice server) keeps the open session and a lost session ends the connection; P4 reconnects
  private openSession(connection: FluxerVoiceConnection, grant: VoiceGrant) {
    if (this.session || this.connection !== connection) return
    const session = new LiveKitSession(grant.endpoint, grant.token, false)
    this.session = session
    session.on('event', (type: string, data: object) => this.logger.debug(`LiveKit ${type} ${JSON.stringify(data)}`))
    session.once('lost', (reason: string) => {
      this.logger.warn(`LiveKit session lost: ${reason}`)
      if (this.session === session) connection.leave()
    })
    session.open().then(
      () => this.logger.info(`In the LiveKit room for connection ${grant.connectionId}`),
      (error) => {
        this.logger.error(`Joining the LiveKit room failed: ${error instanceof Error ? error.message : error}`)
        if (this.session === session) connection.leave()
      }
    )
  }

  public stop() {
    this.update.cancel()
    this.connection?.leave()
  }
}
