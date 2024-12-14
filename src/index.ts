import { Telegram } from './Core/Telegram/Core'
import { Discord } from './Core/Discord/Core'
import { Status } from 'status-client'
import { instances } from './Utils/Instances'

const logger = instances.mainLogger
logger.info('Starting...')
if (instances.config.logging.debug) instances.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('VoiceLog')

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
  logger.info('Shutting down...')
  instances.discord?.disconnect()
  instances.telegram?.disconnect()

  // Wait for 120 seconds before force quitting
  setTimeout(() => {
    logger.warn('Force quitting...')
    process.exit(0)
  }, 120 * 1000)
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
