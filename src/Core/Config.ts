import { readFileSync, existsSync, writeFileSync, copyFileSync, constants } from 'fs'
import { Logger } from 'tslog-helper'
import { Core } from '..'

export class Config {
    private configVersion = 2.2
    private _discord: { token: string, channels: { id: string, fileDest: { type: string, id: string, sendAll: boolean, sendPerUser: boolean }[], timeZone: string, sendIntervalSecond: number, ignoreUsers: string[] }[], admins: string[], logErrorsToAdmin: boolean }
    private _telegram: { token: string, admins: string[], logErrorsToAdmin: boolean, baseApiUrl: string | undefined }
    private _logging: { debug: boolean, raw: boolean }
    private logger: Logger

    /**
     * Config Manager Core
     */
    constructor (core: Core) {
        this.logger = core.mainLogger.getChildLogger({ name: 'Config' })
        this.logger.info('Loading Config...')
        const discordDefault = { token: '', channels: [{ id: '', fileDest: [{ type: 'telegram', id: '', sendAll: true, sendPerUser: true }], timeZone: 'Asia/Taipei', sendIntervalSecond: 60, ignoreUsers: [] }], admins: [], logErrorsToAdmin: false }
        const telegramDefault = { token: '', admins: [], logErrorsToAdmin: false, baseApiUrl: undefined }
        const loggingDefault = { debug: false, raw: false }

        let versionChanged = false

        if (existsSync('./config.json')) {
            const config = JSON.parse(readFileSync('config.json', { encoding: 'utf-8' }))

            if (!config.configVersion || config.configVersion < this.configVersion) versionChanged = true
            if (config.configVersion > this.configVersion) {
                this.logger.fatal('This config version is newer than me! Consider upgrading to the latest version or reset your configuration.')
                process.exit(1)
            }

            // take and merge config
            if (!config.discord) config.discord = {}
            this._discord = {
                token: config.discord.token || discordDefault.token,
                channels: [],
                admins: config.discord.admins || discordDefault.admins,
                logErrorsToAdmin: (config.discord.logErrorsToAdmin !== undefined) ? config.discord.logErrorsToAdmin : discordDefault.logErrorsToAdmin
            }
            if (config.discord.channels) {
                for (const channel of config.discord.channels) {
                    let fileDest = []
                    if (channel.fileDest) {
                        for (const dest of channel.fileDest) {
                            fileDest.push({
                                type: dest.type || discordDefault.channels[0].fileDest[0].type,
                                id: dest.id || discordDefault.channels[0].fileDest[0].id,
                                sendAll: (dest.sendAll !== undefined) ? dest.sendAll : discordDefault.channels[0].fileDest[0].sendAll,
                                sendPerUser: (dest.sendPerUser !== undefined) ? dest.sendPerUser : discordDefault.channels[0].fileDest[0].sendPerUser
                            })
                        }
                    } else {
                        fileDest = discordDefault.channels[0].fileDest
                    }

                    this._discord.channels.push({
                        id: channel.id || discordDefault.channels[0].id,
                        fileDest: fileDest,
                        timeZone: channel.timeZone || discordDefault.channels[0].timeZone,
                        sendIntervalSecond: channel.sendIntervalSecond || discordDefault.channels[0].sendIntervalSecond,
                        ignoreUsers: channel.ignoreUsers || discordDefault.channels[0].ignoreUsers
                    })
                }
            } else {
                this._discord.channels = discordDefault.channels
            }

            if (!config.telegram) config.telegram = {}
            this._telegram = {
                token: config.telegram.token || telegramDefault.token,
                admins: config.telegram.admins || telegramDefault.admins,
                logErrorsToAdmin: (config.telegram.logErrorsToAdmin !== undefined) ? config.telegram.logErrorsToAdmin : telegramDefault.logErrorsToAdmin,
                baseApiUrl: config.telegram.baseApiUrl || telegramDefault.baseApiUrl
            }

            if (!config.logging) config.logging = {}
            this._logging = {
                debug: (config.Debug !== undefined) ? config.Debug : ((config.logging.debug !== undefined) ? config.logging.debug : loggingDefault.debug),
                raw: (config.logging.raw !== undefined) ? config.logging.raw : loggingDefault.raw
            }

            if (versionChanged) {
                if (!config.configVersion) config.configVersion = 'legacy'
                let copyConfigName = `./config-${config.configVersion}.json`
                if (existsSync(copyConfigName)) {
                    let copyNumber = 1
                    copyConfigName = `./config-${config.configVersion}-${copyNumber}.json`
                    while (existsSync(copyConfigName)) {
                        copyNumber++
                        copyConfigName = `./config-${config.configVersion}-${copyNumber}.json`
                    }
                }

                // backup old config
                copyFileSync('./config.json', copyConfigName, constants.COPYFILE_EXCL)
                // save new config
                this.save()

                this.logger.warn('Detected config version change and we have tried to backup and migrate into it! Consider checking your config file.')
                process.exit(1)
            }
            // save to make sure config is correct
            this.save()
        } else {
            this.logger.error('Can\'t load config.json: File not found.')
            this.logger.info('Generating empty config...')
            this._discord = discordDefault
            this._telegram = telegramDefault
            this._logging = loggingDefault
            this.save()
            this.logger.warn('Empty config generated, go ahead and fill your config.')
            process.exit(1)
        }

    }

    /**
     * Configs for logging
     */
    public get discord () {
        return this._discord
    }

    /**
     * Configs for telegram
     */
    public get telegram () {
        return this._telegram
    }

    /**
     * Configs for logging
     */
    public get logging () {
        return this._logging
    }

    /**
     * Save cached config into file
     */
    private save () {
        const json = JSON.stringify({
            '//configVersion': 'DO NOT MODIFY THIS UNLESS YOU KNOW WHAT YOU ARE DOING!!!!!',
            configVersion: this.configVersion,
            discord: this._discord,
            telegram: this._telegram,
            logging: this._logging
        }, null, 4)
        writeFileSync('./config.json', json, 'utf8')
    }
}
