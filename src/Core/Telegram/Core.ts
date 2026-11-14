import TelegramBot from 'node-telegram-bot-api'
import type { ILogObj, Logger } from 'tslog'
import type { TelegramConfig } from '../../Utils/Config'

const ERR_MISSING_TOKEN = Error('Telegram bot api token not found!')

export class Telegram {
  private bot: TelegramBot
  private logger: Logger<ILogObj>

  // Made in createApp(), before getApp() works
  constructor(config: TelegramConfig, mainLogger: Logger<ILogObj>) {
    this.logger = mainLogger.getSubLogger({ name: 'Telegram' })

    if (config.token === '') throw ERR_MISSING_TOKEN

    this.bot = new TelegramBot(config.token, { baseApiUrl: config.baseApiUrl })

    // biome-ignore lint/style/useNamingConvention: Package Specific Format
    this.bot.onText(/\/ping(?:@\w+)?/, (msg) => this.bot.sendMessage(msg.chat.id, 'pong', { reply_parameters: { message_id: msg.message_id } }))
  }

  // Sent as audio. Throws when the upload fails, so the caller retries and keeps the file
  public async sendFile(chatID: string, caption: string, file: { path: string }) {
    try {
      await this.bot.sendAudio(chatID, file.path, { caption })
      this.logger.info(`File sent to ${chatID}: ${file.path}`)
    } catch (err) {
      if (err instanceof Error) {
        this.logger.error(`File ${file.path} send failed:${err.message}`)
      }
      throw err
    }
  }

  public async sendMessage(chatID: string, text: string, useMarkdown: boolean = false) {
    try {
      // biome-ignore lint/style/useNamingConvention: api library naming
      await this.bot.sendMessage(chatID, text, { parse_mode: useMarkdown ? 'Markdown' : undefined })
    } catch (err) {
      if (err instanceof Error) {
        this.logger.error(`Message ${text} send failed:${err.message}`)
      }
    }
  }

  public disconnect() {
    this.logger.info('Shutting down...')

    this.bot.stopPolling()
  }
}
