import { Client } from 'eris'
import { ILogObj, Logger } from 'tslog'
import { DiscordVoice } from './Components/Voice'
import { mkdirSync, existsSync, rmSync } from 'fs'
import { instances } from '../../Utils/Instances'

const ERR_MISSING_TOKEN = Error('Discord token missing')

export class Discord {
  private bot: Client
  private logger: Logger<ILogObj>
  public audios: { [key: string]: DiscordVoice } = {}

  constructor() {
    this.logger = instances.mainLogger.getSubLogger({ name: 'Discord' })

    if (instances.config.discord.token === '') throw ERR_MISSING_TOKEN

    this.bot = new Client(
      instances.config.discord.token,
      { restMode: true, intents: ['guilds', 'guildIntegrations', 'guildMessages', 'guildVoiceStates', 'guildMembers'] }
    )

    this.bot.once('ready', async () => {
      this.logger.info(`Logged in as ${this.bot.user.username} (${this.bot.user.id})`)

      if (existsSync('temp')) rmSync('temp', { recursive: true })
      mkdirSync('temp')

      instances.config.discord.channels.forEach(channel => {
        this.audios[channel.id] = new DiscordVoice(this.bot, this.logger, channel)
      })
    })
  }

  public start() {
    this.bot.connect()
  }

  public async disconnect(reconnect = false) {
    this.logger.info('Shutting down...')

    for (const connection of this.bot.voiceConnections.values()) {
      if (!connection.channelID) continue
      if (!this.audios[connection.channelID]) continue

      await this.audios[connection.channelID].stop(connection)
      delete this.audios[connection.channelID]
    }

    this.bot.disconnect({ reconnect })
  }
}
