import { Config } from './Core/Config';
import { catService } from 'logging-ts';
import { Telegram } from './Components/Telegram/Core';
import { Discord } from './Components/Discord/Core';

export class Core {
    public readonly mainLogger = catService;
    public readonly config = new Config(this);
    public telegram: Telegram | undefined;

    constructor() {
        try {
            this.telegram = new Telegram(this);
        } catch (error) {
            this.mainLogger.error('Error occurred when connecting to telegram:', error);
        }
        try {
            // eslint-disable-next-line no-unused-expressions,@typescript-eslint/no-unused-expressions
            new Discord(this);
        } catch (error) {
            this.mainLogger.error('Error occurred when connecting to discord:', error);
        }
        setInterval(() => {
        //     global.gc();
            Object.entries(process.memoryUsage()).forEach(item => console.log(`${item[0]}: ${(item[1] / 1024 / 1024).toFixed(4)} MiB`));
        }, 30 * 1000);
    }
}

// eslint-disable-next-line no-unused-expressions,@typescript-eslint/no-unused-expressions
new Core();
