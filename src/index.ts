import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { Status } from 'status-client'
import { Discord } from './Core/Discord/Core'
import { Telegram } from './Core/Telegram/Core'
import { instances } from './Utils/Instances'

let quitting = false

const logger = instances.mainLogger
logger.info('Starting...')
if (instances.config.logging.debug) instances.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('fx-recorder')

// Recordings left from the last run, cleared once before any platform starts recording
if (existsSync('temp')) rmSync('temp', { recursive: true })
mkdirSync('temp')

// Initialize the bot
instances.telegram = new Telegram()
// Off only when its token is empty and a Fluxer instance is enabled
if (instances.config.discordEnabled) {
  instances.discord = new Discord()
  instances.discord.start()
} else {
  logger.info('Discord is off: no discord.token')
}

const fluxerInstances = instances.config.fluxer.filter((instance) => instance.enabled)
if (fluxerInstances.length > 0) {
  // Loaded only when used, so the Fluxer and LiveKit packages stay out otherwise
  import('./Core/Fluxer/Core').then(
    ({ Fluxer }) => {
      for (const config of fluxerInstances) {
        const fluxer = new Fluxer(config)
        instances.fluxer.push(fluxer)
        fluxer.start().catch((error) => logger.error(`Fluxer instance ${config.id} failed to start:`, error))
      }
    },
    (error) => logger.error('Fluxer support failed to load (is @discordjs/opus installed?):', error)
  )
}
status.set_status()

process.on('warning', (e) => {
  logger.warn(e.message)
})

const debugMemoryInterval = setInterval(() => {
  Object.entries(process.memoryUsage()).forEach((item) => {
    logger.debug(`${item[0]}: ${(item[1] / 1024 / 1024).toFixed(4)} MiB`)
  })
}, 30 * 1000)

// Graceful shutdown
const stop = () => {
  console.log()
  if (quitting) {
    logger.warn('Force quitting...')
    process.exit(1)
  }

  logger.info('Shutting down...')
  instances.discord?.disconnect()
  for (const fluxer of instances.fluxer) fluxer.disconnect()
  instances.telegram?.disconnect()
  clearInterval(debugMemoryInterval)
  quitting = true
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
