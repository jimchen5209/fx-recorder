import { CommandClient, TextChannel } from 'eris'
import { ILogObj, Logger } from 'tslog'

export class DiscordText {
    private bot: CommandClient
    private logger: Logger<ILogObj>

    constructor (bot: CommandClient, logger: Logger<ILogObj>) {
        this.bot = bot
        this.logger = logger

        this.bot.on('messageCreate', msg => {

            if (!msg.member) return

            const channelName = ((msg.channel) as TextChannel).name
            const channelID = msg.channel.id

            const userNick = (msg.member.nick) ? msg.member.nick : ''
            const userName = msg.member.user.username
            const userID = msg.member.user.id

            const messageContent = msg.content
            messageContent.split('\n').forEach(content => {
                this.logger.info(`${userNick}[${userName}, ${userID}] => ${channelName} (${channelID}): ${content}`)
            })
        })
    }
}
