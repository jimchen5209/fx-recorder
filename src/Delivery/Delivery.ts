import { existsSync, unlinkSync } from 'node:fs'
import type { Client } from '@projectdysnomia/dysnomia'
import type { ILogObj, Logger } from 'tslog'
import { getApp } from '../App/App'
import type { IRecordFile, IUserRecordFile } from '../Recording/RecordSaver'
import type { DiscordChannel, FileDestination } from '../Shared/Config'

// A place messages and recordings can go: Telegram, Discord, or one Fluxer instance (through Fluxer.send)
export interface Sink {
  sendMessage(id: string, text: string): Promise<unknown>
  // Throws when the upload fails
  sendFile(id: string, caption: string, file: { name: string; path: string }): Promise<unknown>
}

const MAX_ATTEMPTS = 3
const RETRY_DELAY_MS = 5000

// The sink a destination goes to; undefined skips it (no id, Discord off, or an unknown type)
function sinkFor(dest: FileDestination): Sink | undefined {
  if (dest.id === '') return undefined
  const app = getApp()
  if (dest.type === 'telegram') return app.telegram
  if (dest.type === 'discord') return app.discord
  if (dest.type !== 'fluxer') return undefined
  // Looked up when used: an instance that is not running fails like a failed upload
  const fluxer = () => {
    const instance = app.fluxer.find((running) => running.instance.id === dest.instance)
    if (!instance) throw new Error(`Fluxer instance ${dest.instance} is not running`)
    return instance
  }
  return {
    sendMessage: async (id, text) => fluxer().send(id, text),
    sendFile: async (id, caption, file) => fluxer().send(id, caption, file)
  }
}

const describe = (dest: FileDestination) => (dest.type === 'fluxer' ? `fluxer ${dest.instance}/${dest.id}` : `${dest.type} ${dest.id}`)

// The channel id comes first, so recordings of several channels sent to one place can be told apart
function recordCaption(channelId: string, file: IRecordFile, userFile?: IUserRecordFile) {
  const user = userFile ? `\nUser:${userFile.user}` : ''
  const tags = userFile ? [...file.tags, userFile.tag] : file.tags
  return `Channel:${channelId}\nStart:${file.start}\nEnd:${file.end}${user}\n\n${tags.join(' ')}`
}

// Telegram, Discord and Fluxer admins who asked for error messages. Discord admins only when discord is given (Discord channels).
export async function sendAdminMessage(discord: Client | undefined, logger: Logger<ILogObj>, message: string) {
  if (getApp().config.discord.logErrorsToAdmin && discord) {
    for (const admin of getApp().config.discord.admins) {
      try {
        const dmChannel = await discord.getDMChannel(admin)
        await discord.createMessage(dmChannel.id, message)
      } catch (error) {
        if (error instanceof Error) {
          logger.error(`Message "${message}" send to discord admin ${admin} failed: ${error.message}`, error)
        }
      }
    }
  }
  if (getApp().config.telegram.logErrorsToAdmin && getApp().telegram) {
    for (const admin of getApp().config.telegram.admins) {
      try {
        await getApp().telegram.sendMessage(admin, message, true)
      } catch (error) {
        if (error instanceof Error) {
          logger.error(`Message "${message}" send to telegram admin ${admin} failed: ${error.message}`, error)
        }
      }
    }
  }
}

// Messages and recordings of one channel to its fileDest, in config order
export class Delivery {
  private channelConfig: DiscordChannel
  private logger: Logger<ILogObj>
  // Told when a recording could not be sent after every attempt
  private notifyAdmins: (message: string) => unknown

  constructor(channelConfig: DiscordChannel, logger: Logger<ILogObj>, notifyAdmins: (message: string) => unknown) {
    this.channelConfig = channelConfig
    this.logger = logger
    this.notifyAdmins = notifyAdmins
  }

  // Prefixed with the channel id. Telegram and Discord failures are thrown; a fluxer one is logged, as callers do not wait
  public async sendMessage(message: string) {
    const text = `[${this.channelConfig.id}] ${message}`
    for (const dest of this.channelConfig.fileDest) {
      const sink = sinkFor(dest)
      if (!sink) continue
      if (dest.type !== 'fluxer') {
        await sink.sendMessage(dest.id, text)
        continue
      }
      await sink.sendMessage(dest.id, text).catch((error) => getApp().mainLogger.error(`Message to ${describe(dest)} failed: ${error instanceof Error ? error.message : error}`))
    }
  }

  // Sends a finished segment, trying 3 times 5 s apart, and deletes its files once every destination has them. A retry
  // sends only the uploads that failed, not the ones a destination already has. Rejects when every attempt failed; the
  // files stay then.
  public async deliver(file: IRecordFile) {
    // `${destination index}:${path}` of every upload that went through
    const sent = new Set<string>()
    for (let attempt = 1; ; attempt++) {
      try {
        await this.sendRecord(file, sent)
        break
      } catch (error) {
        this.logger.error(`Error sending ${file.audioFileName} (attempt ${attempt}/${MAX_ATTEMPTS}):`, error)
        if (attempt === MAX_ATTEMPTS) {
          this.notifyAdmins(`Failed to send ${file.audioFileName} after ${MAX_ATTEMPTS} attempts`)
          throw error
        }
        await new Promise((resolve) => setTimeout(resolve, RETRY_DELAY_MS))
      }
    }
    for (const path of [file.audioFilePath, ...file.perUserFiles.map((userFile) => userFile.audioFilePath)]) {
      this.logger.debug(`Removing record file ${path}`)
      if (existsSync(path)) unlinkSync(path)
    }
  }

  // One attempt at every upload not in sent yet. Telegram and Discord failures stop the rest; a failed fluxer
  // destination does not hold back the others: its error is thrown once they are done.
  private async sendRecord(file: IRecordFile, sent: Set<string>) {
    const channelId = this.channelConfig.id
    let fluxerError: unknown
    for (const [index, dest] of this.channelConfig.fileDest.entries()) {
      const sink = sinkFor(dest)
      if (!sink) continue
      const files = [
        ...(dest.sendAll ? [{ name: file.audioFileName, path: file.audioFilePath, caption: recordCaption(channelId, file) }] : []),
        ...(dest.sendPerUser
          ? file.perUserFiles.map((userFile) => ({ name: userFile.audioFileName, path: userFile.audioFilePath, caption: recordCaption(channelId, file, userFile) }))
          : [])
      ]
      try {
        for (const { caption, ...upload } of files) {
          const key = `${index}:${upload.path}`
          if (sent.has(key)) continue
          this.logger.info(`Sending ${upload.name} of ${channelId} to ${describe(dest)}`)
          await sink.sendFile(dest.id, caption, upload)
          sent.add(key)
        }
      } catch (error) {
        if (dest.type !== 'fluxer') throw error
        this.logger.error(`Sending ${file.audioFileName} to ${describe(dest)} failed: ${error instanceof Error ? error.message : error}`)
        fluxerError ??= error
      }
    }
    if (fluxerError) throw fluxerError
  }
}
