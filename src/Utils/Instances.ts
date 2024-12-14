import { ILogObj, Logger } from 'tslog'
import type { Discord } from '../Core/Discord/Core'
import { Config, loggerOptions } from './Config'
import { Telegram } from '../Core/Telegram/Core'

interface Instances {
  mainLogger: Logger<ILogObj>
  config: Config
  discord: Discord | undefined
  telegram: Telegram | undefined
}

// Static instances
const mainLogger = new Logger(loggerOptions)
const config = new Config(mainLogger)

export const instances: Instances = {
  mainLogger,
  config,
  discord: undefined,
  telegram: undefined
}
