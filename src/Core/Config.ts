import fs from 'fs';
import { Logger } from 'tslog-helper';
import { Core } from '..';

export class Config {
    public discord: { token: string, channels: { id: string, fileDest: { type: string, id: string, sendAll: boolean, sendPerUser: boolean }[], timeZone: string, sendIntervalSecond: number, ignoreUsers: string[] }[], admins: string[] };
    public telegram: { token: string, admins: string[], baseApiUrl: string|undefined };
    public debug: boolean;
    private logger: Logger;

    constructor(core: Core) {
        this.logger = core.mainLogger.getChildLogger({ name: 'Config' });
        this.logger.info('Loading Config...');
        const discordDefaultConfig = { token: '', channels: [{ id: '', fileDest: [{ type: 'telegram', id: '', sendAll: true, sendPerUser: true }], timeZone: 'Asia/Taipei', sendIntervalSecond: 60, ignoreUsers: [] }], admins: [] };
        const telegramDefaultConfig = { token: '', admins: [], baseApiUrl: undefined };
        if (fs.existsSync('./config.json')) {
            const config = JSON.parse(fs.readFileSync('config.json', { encoding: 'utf-8' }));
            this.discord = (config.discord) ? config.discord : discordDefaultConfig;
            this.telegram = (config.telegram) ? config.telegram : telegramDefaultConfig;
            this.debug = (config.Debug) ? config.Debug : false;
            this.write();
        } else {
            this.logger.error('Can\'t load config.json: File not found.');
            this.logger.info('Generating empty config...');
            this.discord = discordDefaultConfig;
            this.telegram = telegramDefaultConfig;
            this.debug = false;
            this.write();
            this.logger.info('Fill your config and try again.');
            process.exit(-1);
        }

    }

    private write() {
        const json = JSON.stringify({
            discord: this.discord,
            telegram: this.telegram,
            Debug: this.debug
        }, null, 4);
        fs.writeFileSync('./config.json', json, 'utf8');
    }
}
