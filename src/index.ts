import { existsSync, mkdirSync, rmSync } from 'node:fs'
import { Status } from 'status-client'
import { createApp } from './App/App'

let quitting = false

const app = createApp()
const logger = app.mainLogger
logger.info('Starting...')
if (app.config.logging.debug) app.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('fx-recorder')

// Recordings left from the last run, cleared once before any platform starts recording
if (existsSync('temp')) rmSync('temp', { recursive: true })
mkdirSync('temp')

// Start the bot. Discord is off only when its token is empty and a Fluxer instance is enabled
if (app.discord) {
  app.discord.start()
} else {
  logger.info('Discord is off: no discord.token')
}

const fluxerInstances = app.config.fluxer.filter((instance) => instance.enabled)
if (fluxerInstances.length > 0) {
  // Loaded only when used, so the Fluxer and LiveKit packages stay out otherwise
  import('./Core/Fluxer/Core').then(
    ({ Fluxer }) => {
      for (const config of fluxerInstances) {
        const fluxer = new Fluxer(config)
        app.fluxer.push(fluxer)
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
  app.discord?.disconnect()
  for (const fluxer of app.fluxer) fluxer.disconnect()
  app.telegram.disconnect()
  clearInterval(debugMemoryInterval)
  quitting = true
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
