import { CommandClient } from 'eris';
import { Category } from 'logging-ts';
import { Config } from '../../Core/Config';
import { Core } from '../..';
import { DiscordVoice } from './Components/Voice';
import { DiscordText } from './Components/Text';
import { mkdirSync ,existsSync, rmdirSync } from 'fs';

const ERR_MISSING_TOKEN = Error('Discord token missing');

export class Discord {
    private config: Config;
    private bot: CommandClient;
    private logger: Category;
    public audios: { [key: string]: DiscordVoice } = {};

    constructor(core: Core) {
        this.config = core.config;
        this.logger = new Category('Discord', core.mainLogger);

        if (this.config.discord.token === '') throw ERR_MISSING_TOKEN;

        this.bot = new CommandClient(
            this.config.discord.token,
            { restMode: true, intents: ['guilds', 'guildIntegrations', 'guildMessages', 'guildVoiceStates', 'guildMembers'] },
            { defaultCommandOptions: { caseInsensitive: true } }
        );

        this.bot.once('ready', async () => {
            this.logger.info(`Logged in as ${this.bot.user.username} (${this.bot.user.id})`);

            if (existsSync('temp')) rmdirSync('temp', { recursive: true });
            mkdirSync('temp');

            this.config.discord.channels.forEach(channel => {
                this.audios[channel.id] = new DiscordVoice(core, this.bot, this.logger, channel);
            });
        });

        // eslint-disable-next-line no-unused-expressions, @typescript-eslint/no-unused-expressions
        new DiscordText(this.bot, this.logger);

        this.bot.connect();
    }
}
