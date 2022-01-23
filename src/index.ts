import { Config } from './Core/Config';
import { LogHelper } from 'tslog-helper';
import { Telegram } from './Components/Telegram/Core';
import { Discord } from './Components/Discord/Core';
import { Status } from 'status-client';

export class Core {
    private readonly logHelper = new LogHelper();
    public readonly mainLogger = this.logHelper.logger;
    public readonly config = new Config(this);
    private _telegram: Telegram | undefined;
    private readonly status = new Status('fx-recorder');

    constructor() {
        try {
            this._telegram = new Telegram(this);
        } catch (error) {
            if (error instanceof Error) {
                this.mainLogger.error('Error occurred when connecting to telegram:', error);
            }
        }
        try {
            new Discord(this);
        } catch (error) {
            if (error instanceof Error) {
                this.mainLogger.error('Error occurred when connecting to discord:', error);
            }
        }

        setInterval(() => {
            Object.entries(process.memoryUsage()).forEach(item => { if (this.config.debug) console.log(`${item[0]}: ${(item[1] / 1024 / 1024).toFixed(4)} MiB`); });
        }, 30 * 1000);

        this.status.set_status();
    }

    public get telegram() {
        return this._telegram;
    }
}

new Core();
