import { mkdirSync, readdirSync, renameSync, rmSync, statfsSync, statSync } from 'node:fs'
import { type ILogObj, Logger } from 'tslog'
import { Discord } from '../Discord/Discord'
import type { Fluxer } from '../Fluxer/Fluxer'
import { Config, loggerOptions } from '../Shared/Config'
import { Telegram } from '../Telegram/Telegram'

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

// Kept recordings are removed after this long, at startup (the same age stale cleanup uses)
const KEEP_MS = 7 * 24 * 60 * 60 * 1000

// Recordings an earlier run left in temp/ (not sent, or cut off) move to temp/kept/<time>/: not deleted at startup and
// never sent again. Kept folders older than 7 days are removed. Returns the folder and the files moved there.
export function keepLeftovers(temp = 'temp', now = Date.now()) {
  const kept = `${temp}/kept`
  mkdirSync(kept, { recursive: true })
  for (const old of readdirSync(kept)) {
    if (now - statSync(`${kept}/${old}`).mtimeMs > KEEP_MS) rmSync(`${kept}/${old}`, { recursive: true })
  }
  const dir = `${kept}/${new Date(now).toISOString().replace(/[:.]/g, '-')}`
  const files: string[] = []
  for (const entry of readdirSync(temp, { withFileTypes: true })) {
    if (entry.name === 'kept') continue
    const path = `${temp}/${entry.name}`
    const inside = entry.isDirectory() ? readdirSync(path).map((name) => `${entry.name}/${name}`) : [entry.name]
    // An empty channel folder has nothing to keep
    if (inside.length === 0) {
      rmSync(path, { recursive: true })
      continue
    }
    mkdirSync(dir, { recursive: true })
    renameSync(path, `${dir}/${entry.name}`)
    files.push(...inside)
  }
  return { dir, files }
}

export interface DiskWatch {
  path: string
  minFreeBytes: number
  everyMs: number
}

// Checks the disk with temp/ every 10 minutes. Below 1 GiB free it warns and calls notify once, and again only after
// the space came back. Recording goes on: nothing unsent is deleted to make room. Returns the timer, for shutdown.
export function watchDiskSpace(
  logger: Logger<ILogObj>,
  notify: (message: string) => unknown,
  watch: DiskWatch = { path: 'temp', minFreeBytes: 1024 ** 3, everyMs: 10 * 60 * 1000 }
) {
  let low = false
  return setInterval(() => {
    let free: number
    try {
      const stats = statfsSync(watch.path)
      free = stats.bavail * stats.bsize
    } catch (error) {
      logger.warn(`Could not check the free disk space for ${watch.path}: ${error instanceof Error ? error.message : error}`)
      return
    }
    if (free >= watch.minFreeBytes) {
      low = false
      return
    }
    if (low) return
    low = true
    const message = `Only ${(free / 1024 ** 3).toFixed(2)} GiB of disk space left for recordings in ${watch.path}`
    logger.warn(message)
    notify(message)
  }, watch.everyMs)
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
