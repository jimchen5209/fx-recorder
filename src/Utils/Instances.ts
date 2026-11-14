import { type ILogObj, Logger } from 'tslog'

import type { Discord } from '../Core/Discord/Core'
import type { Fluxer } from '../Core/Fluxer/Core'
import type { Telegram } from '../Core/Telegram/Core'
import { Config, loggerOptions } from './Config'

interface Instances {
  mainLogger: Logger<ILogObj>
  config: Config
  discord: Discord | undefined
  fluxer: Fluxer[]
  telegram: Telegram | undefined
}

// Static instances
const mainLogger = new Logger(loggerOptions)
const config = new Config(mainLogger)

export const instances: Instances = {
  mainLogger,
  config,
  discord: undefined,
  fluxer: [],
  telegram: undefined
}
