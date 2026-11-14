import { type ILogObj, Logger } from 'tslog'
import { Discord } from '../Core/Discord/Core'
import type { Fluxer } from '../Core/Fluxer/Core'
import { Telegram } from '../Core/Telegram/Core'
import { Config, loggerOptions } from '../Utils/Config'

// What the whole app shares. index.ts makes it once with createApp(); importing this module does nothing.
export interface App {
  mainLogger: Logger<ILogObj>
  config: Config
  telegram: Telegram
  // Undefined when Discord is off (no token and a Fluxer instance enabled)
  discord: Discord | undefined
  // Added by index.ts as each instance starts
  fluxer: Fluxer[]
}

let app: App | undefined

export function createApp(): App {
  if (app) throw new Error('createApp() called twice')

  const mainLogger = new Logger(loggerOptions)
  const config = new Config(mainLogger)
  const telegram = new Telegram(config.telegram, mainLogger)
  const discord = config.discordEnabled ? new Discord(config.discord, mainLogger) : undefined

  app = { mainLogger, config, telegram, discord, fluxer: [] }
  return app
}

export function getApp(): App {
  if (!app) throw new Error('getApp() called before createApp()')
  return app
}

// Stops every platform and waits for their recordings to be sent, then Telegram. False when that took longer than
// deadlineMs; what is not sent by then stays in temp/.
export async function stopApp(app: App, deadlineMs: number) {
  let timer: NodeJS.Timeout | undefined
  const timedOut = new Promise<false>((resolve) => {
    timer = setTimeout(() => resolve(false), deadlineMs)
  })
  const platforms = Promise.allSettled([app.discord?.disconnect(), ...app.fluxer.map((fluxer) => fluxer.disconnect())]).then(() => true)
  const drained = await Promise.race([platforms, timedOut])
  clearTimeout(timer)
  app.telegram.disconnect()
  return drained
}
