import { CommandClient, TextChannel } from 'eris'; //MessageFile, MessageContent, Message,, PossiblyUncachedTextableChannel
import { Category } from 'logging-ts';

export class DiscordText {
    private bot: CommandClient;
    private logger: Category;

    constructor(bot: CommandClient, logger: Category) {
        this.bot = bot;
        this.logger = logger;

        this.bot.on('messageCreate', msg => {

            if (!msg.member) return;

            const channelName = ((msg.channel) as TextChannel).name;
            const channelID = msg.channel.id;

            const userNick = (msg.member.nick) ? msg.member.nick : '';
            const userName = msg.member.user.username;
            const userID = msg.member.user.id;

            const messageContent = msg.content;
            messageContent.split('\n').forEach(content => {
                this.logger.info(`${userNick}[${userName}, ${userID}] => ${channelName} (${channelID}): ${content}`);
            });
        });
    }
}
