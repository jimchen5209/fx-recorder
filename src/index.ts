import { Status } from 'status-client'
import { Discord } from './Core/Discord/Core'
import { Telegram } from './Core/Telegram/Core'
import { instances } from './Utils/Instances'

let quitting = false

const logger = instances.mainLogger
logger.info('Starting...')
if (instances.config.logging.debug) instances.mainLogger.settings.minLevel = 0 // Silly

const status = new Status('fx-recorder')

// Initialize the bot
const discord = new Discord()
instances.discord = discord
instances.telegram = new Telegram()

discord.start()
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
  instances.telegram?.disconnect()
  clearInterval(debugMemoryInterval)
  quitting = true
}

process.on('SIGINT', () => stop())
process.on('SIGTERM', () => stop())
