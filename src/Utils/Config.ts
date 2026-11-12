import { constants, copyFileSync as copyFile, existsSync as exists, readFileSync as readFile, writeFileSync as writeFile } from 'node:fs'
import type { ILogObj, ISettingsParam, Logger } from 'tslog'

export interface FileDestination {
  type: string
  id: string
  sendAll: boolean
  sendPerUser: boolean
  // type "fluxer": the id of the Fluxer instance the channel is on
  instance?: string
}

export interface DiscordChannel {
  id: string
  fileDest: FileDestination[]
  timeZone: string
  sendIntervalSecond: number
  ignoreUsers: string[]
}
export interface DiscordConfig {
  token: string
  channels: DiscordChannel[]
  admins: string[]
  logErrorsToAdmin: boolean
}

// A voice channel on a Fluxer instance; guild_id is needed to join it
export interface FluxerChannel extends DiscordChannel {
  guildId: string
}

// One Fluxer instance, official or self-hosted. id names its folders under temp/: never derive it from the origin,
// never change it once used.
export interface FluxerInstanceConfig {
  id: string
  enabled: boolean
  origin: string
  botToken: string
  admins: string[]
  logErrorsToAdmin: boolean
  channels: FluxerChannel[]
}

export interface TelegramConfig {
  token: string
  admins: string[]
  logErrorsToAdmin: boolean
  baseApiUrl: string | undefined
}

export interface LogConfig {
  debug: boolean
  raw: boolean
}

interface MergeLogConfig extends LogConfig {
  // biome-ignore lint/style/useNamingConvention: Legacy Config
  Debug?: boolean
}

interface ConfigValue {
  configVersion: string | number
  discord: DiscordConfig
  fluxer: FluxerInstanceConfig[]
  telegram: TelegramConfig
  logging: LogConfig
}

// Lowercase letters, digits and dashes: the id is part of a folder name
const FLUXER_INSTANCE_ID = /^[a-z0-9-]+$/

function isHttpsOrigin(origin: string) {
  try {
    return new URL(origin).protocol === 'https:'
  } catch {
    return false
  }
}

export const loggerOptions: ISettingsParam<ILogObj> = {
  name: 'Main',
  prettyLogTimeZone: 'local',
  hideLogPositionForProduction: true,
  minLevel: 3 // Info
}

export class Config {
  private configVersion = 2.3
  private _discord: DiscordConfig
  private _fluxer: FluxerInstanceConfig[] = []
  private _telegram: TelegramConfig
  private _logging: LogConfig
  private logger: Logger<ILogObj>

  private readonly discordDefault = {
    token: '',
    channels: [{ id: '', fileDest: [{ type: 'telegram', id: '', sendAll: true, sendPerUser: true }], timeZone: 'Asia/Taipei', sendIntervalSecond: 60, ignoreUsers: [] }],
    admins: [],
    logErrorsToAdmin: false
  }
  // Used when the file has no fluxer; an empty list stays empty (as VoiceLog does)
  private readonly fluxerDefault: FluxerInstanceConfig[] = [
    {
      id: 'official',
      enabled: false,
      origin: 'https://fluxer.com',
      botToken: '',
      admins: [],
      logErrorsToAdmin: false,
      channels: [{ ...this.discordDefault.channels[0], guildId: '' }]
    }
  ]
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
  constructor(mainLogger: Logger<ILogObj>) {
    this.logger = mainLogger.getSubLogger({ name: 'Config' })
    this.logger.info('Loading Config...')

    let versionChanged = false

    if (exists('./config.json')) {
      const config = JSON.parse(readFile('config.json', { encoding: 'utf-8' }))

      versionChanged = this.checkVersion(config.configVersion)

      // take and merge config
      if (!config.discord) config.discord = {}
      this._discord = this.mergeDiscordConfig(config.discord)

      this._fluxer = Array.isArray(config.fluxer) ? config.fluxer.map((instance: FluxerInstanceConfig) => this.mergeFluxerInstance(instance)) : this.fluxerDefault

      if (!config.telegram) config.telegram = {}
      this._telegram = this.mergeTelegramConfig(config.telegram)

      if (!config.logging) config.logging = {}
      this._logging = this.mergeLogConfig(config.logging)

      if (versionChanged) {
        this.backupAndQuit(config)
      }

      const problems = this.validate()
      if (problems.length > 0) {
        for (const problem of problems) this.logger.fatal(`config.json: ${problem}`)
        process.exit(1)
      }

      // save to make sure config is correct
      this.save()
    } else {
      this.logger.error("Can't load config.json: File not found.")

      this.logger.info('Generating empty config...')
      this._discord = this.discordDefault
      this._fluxer = this.fluxerDefault
      this._telegram = this.telegramDefault
      this._logging = this.loggingDefault

      this.save()

      this.logger.warn('Empty config generated, go ahead and fill your config.')
      process.exit(1)
    }
  }

  private checkVersion(version: number) {
    if (!version || version < this.configVersion) return true
    if (version > this.configVersion) {
      this.logger.fatal('This config version is newer than me! Consider upgrading to the latest version or reset your configuration.')
      process.exit(1)
    }
    return false
  }

  private mergeDiscordConfig(config: DiscordConfig) {
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

  private mergeFileDest(dest: FileDestination) {
    return {
      type: dest.type ?? this.discordDefault.channels[0].fileDest[0].type,
      id: dest.id ?? this.discordDefault.channels[0].fileDest[0].id,
      sendAll: dest.sendAll ?? this.discordDefault.channels[0].fileDest[0].sendAll,
      sendPerUser: dest.sendPerUser ?? this.discordDefault.channels[0].fileDest[0].sendPerUser,
      instance: dest.instance
    } as FileDestination
  }

  private mergeFluxerInstance(instance: FluxerInstanceConfig) {
    return {
      id: instance.id ?? '',
      enabled: instance.enabled ?? false,
      origin: instance.origin ?? '',
      botToken: instance.botToken ?? '',
      admins: instance.admins ?? [],
      logErrorsToAdmin: instance.logErrorsToAdmin ?? false,
      channels: (instance.channels ?? []).map((channel) => {
        const fileDest = channel.fileDest ? channel.fileDest.map((dest) => this.mergeFileDest(dest)) : this.discordDefault.channels[0].fileDest
        return { ...this.mergeDiscordChannel(channel, fileDest), guildId: channel.guildId ?? '' }
      })
    } as FluxerInstanceConfig
  }

  // Problems that would break recording or send a token to the wrong place. Never includes a token.
  private validate() {
    const problems: string[] = []
    const seen = new Set<string>()
    const enabled = new Set<string>()
    this._fluxer.forEach((instance, index) => {
      const name = `fluxer[${index}]`
      if (!FLUXER_INSTANCE_ID.test(instance.id)) problems.push(`${name}.id ${JSON.stringify(instance.id)} must use only a-z, 0-9 and -`)
      else if (seen.has(instance.id)) problems.push(`${name}.id "${instance.id}" is used twice`)
      seen.add(instance.id)
      if (!isHttpsOrigin(instance.origin)) problems.push(`${name}.origin ${JSON.stringify(instance.origin)} must be an https:// URL`)
      if (!instance.enabled) return
      enabled.add(instance.id)
      if (!instance.botToken) problems.push(`${name} is enabled but has no botToken`)
      instance.channels.forEach((channel, channelIndex) => {
        if (!channel.id) problems.push(`${name}.channels[${channelIndex}] has no id`)
        if (!channel.guildId) problems.push(`${name}.channels[${channelIndex}] has no guildId`)
      })
    })

    const channels: [string, DiscordChannel][] = []
    if (this.discordEnabled) {
      for (const [index, channel] of this._discord.channels.entries()) channels.push([`discord.channels[${index}]`, channel])
    }
    for (const [index, instance] of this._fluxer.entries()) {
      if (!instance.enabled) continue
      for (const [channelIndex, channel] of instance.channels.entries()) channels.push([`fluxer[${index}].channels[${channelIndex}]`, channel])
    }
    for (const [name, channel] of channels) {
      channel.fileDest.forEach((dest, destIndex) => {
        if (dest.type === 'discord' && !this.discordEnabled) problems.push(`${name}.fileDest[${destIndex}] sends to discord, but Discord is off (no discord.token)`)
        if (dest.type === 'fluxer' && !enabled.has(dest.instance ?? '')) {
          problems.push(`${name}.fileDest[${destIndex}] sends to fluxer instance ${JSON.stringify(dest.instance ?? '')}, which is not an enabled instance`)
        }
      })
    }
    return problems
  }

  private mergeDiscordChannel(channel: DiscordChannel, fileDest: FileDestination[]) {
    return {
      id: channel.id ?? this.discordDefault.channels[0].id,
      fileDest: fileDest,
      timeZone: channel.timeZone ?? this.discordDefault.channels[0].timeZone,
      sendIntervalSecond: channel.sendIntervalSecond ?? this.discordDefault.channels[0].sendIntervalSecond,
      ignoreUsers: channel.ignoreUsers ?? this.discordDefault.channels[0].ignoreUsers
    } as DiscordChannel
  }

  private mergeTelegramConfig(config: TelegramConfig) {
    return {
      token: config.token ?? this.telegramDefault.token,
      admins: config.admins ?? this.telegramDefault.admins,
      logErrorsToAdmin: config.logErrorsToAdmin ?? this.telegramDefault.logErrorsToAdmin,
      baseApiUrl: config.baseApiUrl ?? this.telegramDefault.baseApiUrl
    } as TelegramConfig
  }

  private mergeLogConfig(config: MergeLogConfig) {
    return {
      debug: config.Debug ?? config.debug ?? this.loggingDefault.debug,
      raw: config.raw ?? this.loggingDefault.raw
    } as LogConfig
  }

  private backupAndQuit(config: ConfigValue) {
    if (!config.configVersion) config.configVersion = 'legacy'
    let copyConfigName = `./config-${config.configVersion}.json`
    if (exists(copyConfigName)) {
      let copyNumber = 1
      copyConfigName = `./config-${config.configVersion}-${copyNumber}.json`
      while (exists(copyConfigName)) {
        copyNumber++
        copyConfigName = `./config-${config.configVersion}-${copyNumber}.json`
      }
    }

    // backup old config
    copyFile('./config.json', copyConfigName, constants.COPYFILE_EXCL)
    // save new config
    this.save()

    this.logger.warn('Detected config version change and we have tried to backup and migrate into it! Consider checking your config file.')
    process.exit(1)
  }

  /**
   * Configs for logging
   */
  public get discord() {
    return this._discord
  }

  /**
   * Fluxer instances
   */
  public get fluxer() {
    return this._fluxer
  }

  /**
   * Discord runs unless its token is empty and a Fluxer instance is enabled, so Fluxer can run alone
   */
  public get discordEnabled() {
    return this._discord.token !== '' || !this._fluxer.some((instance) => instance.enabled)
  }

  /**
   * Configs for telegram
   */
  public get telegram() {
    return this._telegram
  }

  /**
   * Configs for logging
   */
  public get logging() {
    return this._logging
  }

  /**
   * Save cached config into file
   */
  private save() {
    const json = JSON.stringify(
      {
        '//configVersion': 'DO NOT MODIFY THIS UNLESS YOU KNOW WHAT YOU ARE DOING!!!!!',
        configVersion: this.configVersion,
        discord: this._discord,
        fluxer: this._fluxer,
        telegram: this._telegram,
        logging: this._logging
      },
      null,
      4
    )
    writeFile('./config.json', json, 'utf8')
  }
}
