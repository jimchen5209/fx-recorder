import { readFileSync as readFile } from 'node:fs'
import type { Client } from '@projectdysnomia/dysnomia'
import type { ILogObj, Logger } from 'tslog'
import type { FileDestination } from '../../Utils/Config'
import { instances } from '../../Utils/Instances'
import type { IRecordFile, IUserRecordFile } from '../Discord/Recorder/RecordSaver'

// Delivery to a channel's fileDest, moved out of DiscordVoice as it was, known defects included (plan §8: S1/S4 fix them).
// discord: the Discord client for discord destinations and admins; without it they are skipped.

// The channel id comes first, so recordings of several channels sent to one place can be told apart
function recordCaption(channelId: string, file: IRecordFile, userFile?: IUserRecordFile) {
  const user = userFile ? `\nUser:${userFile.user}` : ''
  const tags = userFile ? [...file.tags, userFile.tag] : file.tags
  return `Channel:${channelId}\nStart:${file.start}\nEnd:${file.end}${user}\n\n${tags.join(' ')}`
}

// A fluxer destination goes through the running instance it names
async function sendToFluxer(dest: FileDestination, content: string, file?: { name: string; path: string }) {
  const fluxer = instances.fluxer.find((instance) => instance.instance.id === dest.instance)
  if (!fluxer) throw new Error(`Fluxer instance ${dest.instance} is not running`)
  await fluxer.send(dest.id, content, file)
}

export async function sendMessage(fileDest: FileDestination[], discord: Client | undefined, message: string) {
  for (const element of fileDest) {
    if (element.type === 'telegram' && element.id !== '' && instances.telegram) {
      await instances.telegram.sendMessage(element.id, message)
    }
    if (element.type === 'discord' && element.id !== '' && discord) {
      await discord.createMessage(element.id, message)
    }
    // Logged, not thrown: callers send messages without waiting, and a throw there would crash the bot
    if (element.type === 'fluxer' && element.id !== '') {
      await sendToFluxer(element, message).catch((error) =>
        instances.mainLogger.error(`Message to fluxer ${element.instance}/${element.id} failed: ${error instanceof Error ? error.message : error}`)
      )
    }
  }
}

export async function sendAdminMessage(discord: Client | undefined, logger: Logger<ILogObj>, message: string) {
  if (instances.config.discord.logErrorsToAdmin && discord) {
    for (const admin of instances.config.discord.admins) {
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
  if (instances.config.telegram.logErrorsToAdmin && instances.telegram) {
    for (const admin of instances.config.telegram.admins) {
      try {
        await instances.telegram.sendMessage(admin, message, true)
      } catch (error) {
        if (error instanceof Error) {
          logger.error(`Message "${message}" send to telegram admin ${admin} failed: ${error.message}`, error)
        }
      }
    }
  }
}

// One attempt at every destination; the caller retries.
// A failed fluxer destination does not hold back the others: its error is thrown once they are done.
export async function sendRecord(fileDest: FileDestination[], discord: Client | undefined, logger: Logger<ILogObj>, channelId: string, file: IRecordFile) {
  let fluxerError: unknown
  for (const element of fileDest) {
    if (element.type === 'telegram' && element.id !== '' && instances.telegram) {
      if (element.sendAll) {
        logger.info(`Sending ${file.audioFileName} of ${channelId} to telegram ${element.id}`)
        const caption = recordCaption(channelId, file)
        await instances.telegram.sendAudio(element.id, file.audioFilePath, caption)
      }
      if (element.sendPerUser) {
        for (const userFile of file.perUserFiles) {
          logger.info(`Sending ${userFile.audioFileName} of ${channelId} to telegram ${element.id}`)
          const caption = recordCaption(channelId, file, userFile)
          await instances.telegram.sendAudio(element.id, userFile.audioFilePath, caption)
        }
      }
    }
    if (element.type === 'discord' && element.id !== '' && discord) {
      if (element.sendAll) {
        logger.info(`Sending ${file.audioFileName} of ${channelId} to discord ${element.id}`)
        const caption = recordCaption(channelId, file)
        await discord.createMessage(element.id, {
          content: caption,
          attachments: [{ filename: file.audioFileName, file: readFile(file.audioFilePath) }]
        })
      }
      if (element.sendPerUser) {
        for (const userFile of file.perUserFiles) {
          logger.info(`Sending ${userFile.audioFileName} of ${channelId} to discord ${element.id}`)
          const caption = recordCaption(channelId, file, userFile)
          await discord.createMessage(element.id, {
            content: caption,
            attachments: [{ filename: userFile.audioFileName, file: readFile(userFile.audioFilePath) }]
          })
        }
      }
    }
    if (element.type === 'fluxer' && element.id !== '') {
      try {
        if (element.sendAll) {
          logger.info(`Sending ${file.audioFileName} of ${channelId} to fluxer ${element.instance}/${element.id}`)
          const caption = recordCaption(channelId, file)
          await sendToFluxer(element, caption, { name: file.audioFileName, path: file.audioFilePath })
        }
        if (element.sendPerUser) {
          for (const userFile of file.perUserFiles) {
            logger.info(`Sending ${userFile.audioFileName} of ${channelId} to fluxer ${element.instance}/${element.id}`)
            const caption = recordCaption(channelId, file, userFile)
            await sendToFluxer(element, caption, { name: userFile.audioFileName, path: userFile.audioFilePath })
          }
        }
      } catch (error) {
        logger.error(`Sending ${file.audioFileName} to fluxer ${element.instance}/${element.id} failed: ${error instanceof Error ? error.message : error}`)
        fluxerError ??= error
      }
    }
  }
  if (fluxerError) throw fluxerError
}
