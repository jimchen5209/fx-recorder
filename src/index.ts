import { Status } from 'status-client'

import { Telegram } from './Core/Telegram/Core'
import { Discord } from './Core/Discord/Core'
import { instances } from './Utils/Instances'

let quitting = false

const logger = instances.mainLogger
logger.info('Starting...')
if (instances.config.logging.debug) instances.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('fx-recorder')

// Initialize the bot
const discord = (instances.discord = new Discord())
instances.telegram = new Telegram()

discord.start()
status.set_status()

process.on('warning', (e) => {
  logger.warn(e.message)
})

setInterval(() => {
  Object.entries(process.memoryUsage()).forEach((item) =>
    logger.debug(`${item[0]}: ${(item[1] / 1024 / 1024).toFixed(4)} MiB`)
  )
}, 30 * 1000)

// Graceful shutdown
const stop = () => {
  console.log()
  if (quitting) {
    logger.warn('Force quitting...')
    process.exit(0)
  }

  logger.info('Shutting down...')
  instances.discord?.disconnect()
  instances.telegram?.disconnect()
  quitting = true

  // Wait for 120 seconds before force quitting
  setTimeout(() => {
    logger.warn('Force quitting...')
    process.exit(0)
  }, 120 * 1000)
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
