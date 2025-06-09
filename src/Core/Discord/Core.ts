import { Client } from '@projectdysnomia/dysnomia'
import { ILogObj, Logger } from 'tslog'
import { DiscordVoice } from './Core/Voice'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { instances } from '../../Utils/Instances'

const ERR_MISSING_TOKEN = Error('Discord token missing')

export class Discord {
  private client: Client
  private logger: Logger<ILogObj>
  public audios: { [key: string]: DiscordVoice } = {}

  constructor() {
    this.logger = instances.mainLogger.getSubLogger({ name: 'Discord' })

    if (instances.config.discord.token === '') throw ERR_MISSING_TOKEN

    this.client = new Client(
      instances.config.discord.token,
      { restMode: true, gateway: { intents: ['guilds', 'guildIntegrations', 'guildMessages', 'guildVoiceStates', 'guildMembers'] } }
    )

    this.client.on('voiceChannelJoin', (member, channel) => {
      if (member.id === this.client.user.id) return
      this.handleUserConnect(channel.id)
    })

    this.client.on('voiceChannelLeave', (member, channel) => {
      if (member.id === this.client.user.id) return
      this.handleUserDisconnect(channel.id, member.id)
    })

    this.client.on('voiceChannelSwitch', (member, newChannel, oldChannel) => {
      if (member.id === this.client.user.id) return
      this.handleUserDisconnect(oldChannel.id, member.id)
      this.handleUserConnect(newChannel.id)
    })

    this.client.on('warn', (message, id) => {
      this.logger.warn(`Warn on shard ${id}: ${message}`)
    })

    this.client.on('error', (error, id) => {
      this.logger.error(`Error on shard ${id}: ${error.message}`, error)
    })

    this.client.once('ready', async () => {
      this.logger.info(`Logged in as ${this.client.user.username} (${this.client.user.id})`)

      if (existsSync('temp')) rmSync('temp', { recursive: true })
      mkdirSync('temp')

      this.updateStatus()

      instances.config.discord.channels.forEach(channel => {
        this.audios[channel.id] = new DiscordVoice(this.client, channel, this.logger)
        this.audios[channel.id].on('status', () => this.updateStatus())
      })
    })
  }

  private updateStatus() {
    const recordingCount = Object.values(this.audios).filter(audio => audio.active).length
    this.logger.debug(`Recording ${recordingCount} channel${recordingCount > 1 ? 's' : ''}`)

    if (recordingCount > 0) {
      return this.client.editStatus('dnd', {
        name: 'Recorder',
        state: `Recording ${recordingCount} channel${recordingCount > 1 ? 's' : ''}`,
        type: 4
      })
    }
    this.client.editStatus('idle', {
      name: 'Recorder',
      state: 'Idle',
      type: 4
    })
  }

  // Leave or Switch out of the channel
  private handleUserDisconnect(channelID: string, userID: string) {
    if (!this.audios[channelID]) return

    this.audios[channelID].handleUserDisconnect(userID)
  }

  // Join or Switch into the channel
  private handleUserConnect(channelID: string) {
    if (!this.audios[channelID]) return

    this.audios[channelID].handleUserConnect()
  }

  public start() {
    this.client.connect()
  }

  public async disconnect(reconnect = false) {
    this.logger.info('Shutting down...')

    for (const connection of this.client.voiceConnections.values()) {
      if (!connection.channelID) continue
      if (!this.audios[connection.channelID]) continue

      await this.audios[connection.channelID].stop(connection)
      delete this.audios[connection.channelID]
    }

    this.client.removeAllListeners()

    this.client.disconnect({ reconnect })
  }
}
