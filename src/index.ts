import { Status } from 'status-client'
import { createApp, keepLeftovers, stopApp } from './App/App'
import { sendAdminMessage } from './Delivery/Delivery'

let quitting = false

const app = createApp()
const logger = app.mainLogger
logger.info('Starting...')
if (app.config.logging.debug) app.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('fx-recorder')

// Recordings left by an earlier run are set aside before any platform starts recording, not sent again
const leftovers = keepLeftovers()
if (leftovers.files.length > 0) {
  const message = `${leftovers.files.length} recording file(s) left by an earlier run were moved to ${leftovers.dir}, not sent`
  logger.warn(`${message}: ${leftovers.files.join(', ')}`)
  // Telegram admins only: Discord and Fluxer are not connected yet
  sendAdminMessage(undefined, logger, message)
}

// Start the bot. Discord is off only when its token is empty and a Fluxer instance is enabled
if (app.discord) {
  app.discord.start()
} else {
  logger.info('Discord is off: no discord.token')
}

const fluxerInstances = app.config.fluxer.filter((instance) => instance.enabled)
if (fluxerInstances.length > 0) {
  // Loaded only when used, so the Fluxer and LiveKit packages stay out otherwise
  import('./Fluxer/Fluxer').then(
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

// Graceful shutdown: up to a minute for the recordings to be sent; a second signal quits at once
const stop = () => {
  console.log()
  if (quitting) {
    logger.warn('Force quitting...')
    process.exit(1)
  }
  quitting = true

  logger.info('Shutting down...')
  clearInterval(debugMemoryInterval)
  stopApp(app, 60 * 1000).then((drained) => {
    if (drained) logger.info('All services shut down gracefully. Exiting.')
    else logger.warn('Graceful shutdown timed out. Force quitting...')
    process.exit(drained ? 0 : 1)
  })
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
