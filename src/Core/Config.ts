import { readFileSync, existsSync, writeFileSync, copyFileSync, constants } from 'fs'
import { ILogObj, Logger } from 'tslog'
import { Core } from '..'

export interface FileDestination {
    type: string,
    id: string,
    sendAll: boolean,
    sendPerUser: boolean
}

export interface DiscordChannel {
    id: string,
    fileDest: FileDestination[],
    timeZone: string,
    sendIntervalSecond: number,
    ignoreUsers: string[]
}
export interface DiscordConfig {
    token: string,
    channels: DiscordChannel[],
    admins: string[],
    logErrorsToAdmin: boolean
}

export interface TelegramConfig {
    token: string,
    admins: string[],
    logErrorsToAdmin: boolean,
    baseApiUrl: string | undefined
}

export interface LogConfig {
    debug: boolean,
    raw: boolean
}

interface MergeLogConfig extends LogConfig {
    Debug?: boolean,
}

interface ConfigValue {
    configVersion: string | number,
    discord: DiscordConfig,
    telegram: TelegramConfig,
    logging: LogConfig
}

export class Config {
    private configVersion = 2.2
    private _discord: DiscordConfig
    private _telegram: TelegramConfig
    private _logging: LogConfig
    private logger: Logger<ILogObj>

    private readonly discordDefault = {
        token: '',
        channels: [{ id: '', fileDest: [{ type: 'telegram', id: '', sendAll: true, sendPerUser: true }], timeZone: 'Asia/Taipei', sendIntervalSecond: 60, ignoreUsers: [] }],
        admins: [],
        logErrorsToAdmin: false
    }
    private readonly telegramDefault = {
        token: '',
        admins: [],
        logErrorsToAdmin: false,
        baseApiUrl: undefined
    }
    private readonly loggingDefault = {
        debug: false,
        raw: false
    }

    /**
     * Config Manager Core
     */
    constructor (core: Core) {
        this.logger = core.mainLogger.getSubLogger({ name: 'Config' })
        this.logger.info('Loading Config...')

        let versionChanged = false

        if (existsSync('./config.json')) {
            const config = JSON.parse(readFileSync('config.json', { encoding: 'utf-8' }))

            versionChanged = this.checkVersion(config.configVersion)

            // take and merge config
            if (!config.discord) config.discord = {}
            this._discord = this.mergeDiscordConfig(config.discord)

            if (!config.telegram) config.telegram = {}
            this._telegram = this.mergeTelegramConfig(config.telegram)

            if (!config.logging) config.logging = {}
            this._logging = this.mergeLogConfig(config.logging)

            if (versionChanged) {
                this.backupAndQuit(config)
            }

            // save to make sure config is correct
            this.save()
        } else {
            this.logger.error('Can\'t load config.json: File not found.')

            this.logger.info('Generating empty config...')
            this._discord = this.discordDefault
            this._telegram = this.telegramDefault
            this._logging = this.loggingDefault

            this.save()

            this.logger.warn('Empty config generated, go ahead and fill your config.')
            process.exit(1)
        }
    }

    private checkVersion (version: number) {
        if (!version || version < this.configVersion) return true
        if (version > this.configVersion) {
            this.logger.fatal('This config version is newer than me! Consider upgrading to the latest version or reset your configuration.')
            process.exit(1)
        }
        return false
    }

    private mergeDiscordConfig (config: DiscordConfig) {
        const merged = {
            token: config.token ?? this.discordDefault.token,
            channels: [],
            admins: config.admins ?? this.discordDefault.admins,
            logErrorsToAdmin: config.logErrorsToAdmin ?? this.discordDefault.logErrorsToAdmin
        } as DiscordConfig
        if (config.channels) {
            for (const channel of config.channels) {
                let fileDest = []
                if (channel.fileDest) {
                    for (const dest of channel.fileDest) {
                        fileDest.push(this.mergeFileDest(dest))
                    }
                } else {
                    fileDest = this.discordDefault.channels[0].fileDest
                }

                merged.channels.push(this.mergeDiscordChannel(channel, fileDest))
            }
        } else {
            merged.channels = this.discordDefault.channels
        }

        return merged
    }

    private mergeFileDest (dest: FileDestination) {
        return {
            type: dest.type ?? this.discordDefault.channels[0].fileDest[0].type,
            id: dest.id ?? this.discordDefault.channels[0].fileDest[0].id,
            sendAll: dest.sendAll ?? this.discordDefault.channels[0].fileDest[0].sendAll,
            sendPerUser: dest.sendPerUser ?? this.discordDefault.channels[0].fileDest[0].sendPerUser
        } as FileDestination
    }

    private mergeDiscordChannel (channel: DiscordChannel, fileDest: FileDestination[]) {
        return {
            id: channel.id ?? this.discordDefault.channels[0].id,
            fileDest: fileDest,
            timeZone: channel.timeZone ?? this.discordDefault.channels[0].timeZone,
            sendIntervalSecond: channel.sendIntervalSecond ?? this.discordDefault.channels[0].sendIntervalSecond,
            ignoreUsers: channel.ignoreUsers ?? this.discordDefault.channels[0].ignoreUsers
        } as DiscordChannel
    }

    private mergeTelegramConfig (config: TelegramConfig) {
        return {
            token: config.token ?? this.telegramDefault.token,
            admins: config.admins ?? this.telegramDefault.admins,
            logErrorsToAdmin: config.logErrorsToAdmin ?? this.telegramDefault.logErrorsToAdmin,
            baseApiUrl: config.baseApiUrl ?? this.telegramDefault.baseApiUrl
        } as TelegramConfig
    }

    private mergeLogConfig (config: MergeLogConfig) {
        return {
            debug: config.Debug ?? (config.debug ?? this.loggingDefault.debug),
            raw: config.raw ?? this.loggingDefault.raw
        } as LogConfig
    }

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    private backupAndQuit (config: ConfigValue) {
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
