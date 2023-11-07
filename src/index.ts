import { Config } from './Core/Config'
import { LogHelper } from 'tslog-helper'
import { Telegram } from './Components/Telegram/Core'
import { Discord } from './Components/Discord/Core'
import { Status } from 'status-client'

export class Core {
    private readonly logHelper = new LogHelper()
    public readonly mainLogger = this.logHelper.logger
    public readonly config = new Config(this)
    private _telegram: Telegram | undefined
    private discord: Discord | undefined
    private readonly status = new Status('fx-recorder')

    constructor () {
        this.logHelper.setDebug(this.config.logging.debug)
        this.logHelper.setLogRaw(this.config.logging.raw)
        try {
            this._telegram = new Telegram(this)
        } catch (error) {
            if (error instanceof Error) {
                this.mainLogger.error('Error occurred when connecting to telegram:', error)
            }
        }
        try {
            this.discord = new Discord(this)
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

    public get telegram () {
        return this._telegram
    }

    private async stop (reason: string) {
        this.mainLogger.info(`Stopping! Reason: ${reason}`)
        await this.discord?.stop()
        this._telegram?.stop()

        process.exit(0)
    }
}

new Core()
