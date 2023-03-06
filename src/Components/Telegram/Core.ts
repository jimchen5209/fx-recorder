import TelegramBot from 'node-telegram-bot-api';
import { Core } from '../..';
import { Logger } from 'tslog-helper';
import { Config } from '../../Core/Config';

const ERR_MISSING_TOKEN = Error('Telegram bot api token not found!');

export class Telegram {
    private bot: TelegramBot;
    private config: Config;
    private logger: Logger;

    constructor(core: Core) {
        this.config = core.config;
        this.logger = core.mainLogger.getChildLogger({ name: 'Telegram' });

        if (this.config.telegram.token === '') throw ERR_MISSING_TOKEN;

        this.bot = new TelegramBot(core.config.telegram.token, { baseApiUrl: this.config.telegram.baseApiUrl });

        this.bot.onText(/\/ping(?:@\w+)?/, msg => this.bot.sendMessage(msg.chat.id, 'pong', { reply_to_message_id: msg.message_id }));
    }

    public async sendAudio(chatID: string, file: string, caption: string) {
        try {
            await this.bot.sendAudio(
                chatID,
                file,
                { caption }
            );
            this.logger.info(`File sent to ${chatID}: ${file}`);
        } catch (err) {
            if (err instanceof Error) {
                this.logger.error(`File ${file} send failed:${err.message}`);
            }
        }

        return file;
    }

    public async sendMessage(chatID: string, text: string) {
        try {
            await this.bot.sendMessage(chatID, text);
        } catch (err) {
            if (err instanceof Error) {
                this.logger.error(`Message ${text} send failed:${err.message}`);
            }
        }
    }

    public stop() {
        this.logger.info('Shutting down...');

        this.bot.stopPolling();
    }
}
