import { Client } from 'eris'
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
      { restMode: true, intents: ['guilds', 'guildIntegrations', 'guildMessages', 'guildVoiceStates', 'guildMembers'] }
    )

    this.client.once('ready', async () => {
      this.logger.info(`Logged in as ${this.client.user.username} (${this.client.user.id})`)

      if (existsSync('temp')) rmSync('temp', { recursive: true })
      mkdirSync('temp')

      instances.config.discord.channels.forEach(channel => {
        this.audios[channel.id] = new DiscordVoice(this.client, channel, this.logger)
      })
    })
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
