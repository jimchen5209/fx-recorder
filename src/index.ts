import { Config } from './Core/Config'
import { Telegram } from './Components/Telegram/Core'
import { Discord } from './Components/Discord/Core'
import { Status } from 'status-client'
import { ILogObj, Logger } from 'tslog'

export class Core {
  public readonly mainLogger: Logger<ILogObj> = new Logger({
    name: 'Main',
    prettyLogTimeZone: 'local',
    hideLogPositionForProduction: true,
    minLevel: 3 // Info
  })
  public readonly config = new Config(this)
  private _telegram: Telegram | undefined
  private _discord: Discord | undefined
  private readonly status = new Status('fx-recorder')

  constructor() {
    if (this.config.logging.debug) this.mainLogger.settings.minLevel = 0 // Silly

    try {
      this._telegram = new Telegram(this)
    } catch (error) {
      if (error instanceof Error) {
        this.mainLogger.error('Error occurred when connecting to telegram:', error)
      }
    }
    try {
      this._discord = new Discord(this)
    } catch (error) {
      if (error instanceof Error) {
        this.mainLogger.error('Error occurred when connecting to discord:', error)
      }
    }

    setInterval(() => {
      Object.entries(process.memoryUsage()).forEach(item => this.mainLogger.debug(`${item[0]}: ${(item[1] / 1024 / 1024).toFixed(4)} MiB`))
    }, 30 * 1000)

    this.status.set_status()

    // Enable graceful stop
    process.once('SIGINT', () => this.stop('SIGINT'))
    process.once('SIGTERM', () => this.stop('SIGTERM'))
  }

  public get telegram() {
    return this._telegram
  }

  public get discord() {
    return this._discord
  }

  private async stop(reason: string) {
    this.mainLogger.info(`Stopping! Reason: ${reason}`)
    await this._discord?.disconnect()
    this._telegram?.disconnect()

    process.exit(0)
  }
}

new Core()
