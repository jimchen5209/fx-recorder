import { Client, VoiceConnection, VoiceChannel } from 'eris'
import { ILogObj, Logger } from 'tslog'
import { EventEmitter } from 'events'
import { readFileSync as readFile } from 'fs'
import { waitUntil, TimeoutError }  from 'async-wait-until'
import { debounce } from 'lodash'

import { Silence } from './Silence'
import { instances } from '../../../Utils/Instances'
import { DiscordChannel } from '../../../Utils/Config'
import { Recorder } from '../Recorder/Recorder'
import { IRecordFile } from '../Recorder/RecordSaver'

export class DiscordVoice extends EventEmitter {
  private client: Client
  private channelConfig: DiscordChannel
  private logger: Logger<ILogObj>
  private recorder: Recorder
  private sendInterval: NodeJS.Timeout | undefined

  private active = true
  private readyToDelete = false

  private maxWarning = 5
  private warningCount = 0
  private warningResetTimer: NodeJS.Timeout | undefined

  private maxReconnect = 5
  private reconnectCount = 0
  private reconnectResetTimer: NodeJS.Timeout | undefined

  constructor(
    client: Client,
    channelConfig: DiscordChannel,
    logger: Logger<ILogObj>
  ) {
    super()

    this.client = client
    this.channelConfig = channelConfig
    this.logger = logger.getSubLogger({ name: 'Voice', prefix: [`[${channelConfig.id}]`] })
    this.recorder = new Recorder(channelConfig)

    this.startAudioSession(channelConfig.id)
  }

  private async startAudioSession(channelID: string) {
    for (let retryCount = 1; retryCount <= 5; ++retryCount) {
      const connection = await this.joinVoiceChannel(channelID)
      if (connection !== undefined) {
        this.logger.info('Connected, start recording...')
        connection.play(new Silence(), { format: 'opusPackets' })
        this.startRecording(connection)
        return
      }
      this.logger.error(`Connecting to voice channel failed. Retrying (${retryCount} / 5)...`)
    }
    this.active = false
    this.logger.fatal('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')

    await this.sendMessage('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')
  }

  private startRecording(connection: VoiceConnection) {
    this.setEndStreamEvents(connection)
    connection.receive('pcm').on('data', (data, user) => {
      if (!this.active) return
      this.recorder.storeBuffer(data, user)
    })
    this.recorder.startStream()
    this.startSendRecord()

    this.sendMessage('Record session started')
  }

  private async sendMessage(message: string) {
    for (const element of this.channelConfig.fileDest) {
      if (element.type === 'telegram' && element.id !== '' && instances.telegram) {
        await instances.telegram.sendMessage(element.id, message)
      }
      if (element.type === 'discord' && element.id !== '') {
        await this.client.createMessage(element.id, message)
      }
    }
  }

  private async sendAdminMessage(message: string) {
    if (instances.config.discord.logErrorsToAdmin) {
      for (const admin of instances.config.discord.admins) {
        try {
          const dmChannel = await this.client.getDMChannel(admin)
          await this.client.createMessage(dmChannel.id, message)
        } catch (error) {
          if (error instanceof Error) {
            this.logger.error(`Message "${message}" send to discord admin ${admin} failed: ${error.message}`, error)
          }
        }
      }
    }
    if (instances.config.telegram.logErrorsToAdmin && instances.telegram) {
      for (const admin of instances.config.telegram.admins) {
        try {
          await instances.telegram.sendMessage(admin, message)
        } catch (error) {
          if (error instanceof Error) {
            this.logger.error(`Message "${message}" send to telegram admin ${admin} failed: ${error.message}`, error)
          }
        }
      }
    }
  }

  private async sendRecord(file: IRecordFile) {
    for (const element of this.channelConfig.fileDest) {
      if (element.type === 'telegram' && element.id !== '' && instances.telegram) {
        if (element.sendAll) {
          this.logger.info(`Sending ${file.audioFileName} of ${this.channelConfig.id} to telegram ${element.id}`)
          const caption = `Start:${file.start}\nEnd:${file.end}\n\n${file.tags.join(' ')}`
          await instances.telegram.sendAudio(element.id, file.audioFilePath, caption)
        }
        if (element.sendPerUser) {
          for (const userFile of file.perUserFiles) {
            this.logger.info(`Sending ${userFile.audioFileName} of ${this.channelConfig.id} to telegram ${element.id}`)
            const caption = `Start:${file.start}\nEnd:${file.end}\nUser:${userFile.user}\n\n${[...file.tags, userFile.tag].join(' ')}`
            await instances.telegram.sendAudio(element.id, userFile.audioFilePath, caption)

          }
        }
      }
      if (element.type === 'discord' && element.id !== '') {
        if (element.sendAll) {
          this.logger.info(`Sending ${file.audioFileName} of ${this.channelConfig.id} to discord ${element.id}`)
          const caption = `Start:${file.start}\nEnd:${file.end}\n\n${file.tags.join(' ')}`
          await this.client.createMessage(element.id, caption, { name: file.audioFileName, file: readFile(file.audioFilePath) })
        }
        if (element.sendPerUser) {
          for (const userFile of file.perUserFiles) {
            this.logger.info(`Sending ${userFile.audioFileName} of ${this.channelConfig.id} to discord ${element.id}`)
            const caption = `Start:${file.start}\nEnd:${file.end}\nUser:${userFile.user}\n\n${[...file.tags, userFile.tag].join(' ')}`
            await this.client.createMessage(element.id, caption, { name: userFile.audioFileName, file: readFile(userFile.audioFilePath) })
          }
        }
      }
    }
  }

  private startSendRecord() {
    this.sendInterval = setInterval(() => {
      const file = this.recorder.saver.getFilePeriod()
      this.sendRecord(file).then(() => {
        this.recorder.saver.removeRecordFile(file.start)
      })
    }, this.channelConfig.sendIntervalSecond * 1000)
  }

  private stopSession(channelID:string, connection: VoiceConnection) {
    connection.stopPlaying()

    clearInterval(this.sendInterval)

    this.logger.info('Sending rest of recording...')
    const file = this.recorder.stop()
    this.sendRecord(file).then(async () => {
      await this.sendMessage('The record session has ended.')
      if (!this.active) this.readyToDelete = true
    })

    this.client.leaveVoiceChannel(channelID)
  }

  public async stop(connection: VoiceConnection) {
    this.active = false

    this.logger.info('Shutting down...')
    this.sendMessage('Recorder shutting down.')
    this.sendAdminMessage(`Recorder ${this.channelConfig.id} shutting down.`)

    this.stopSession(this.channelConfig.id, connection)

    try {
      await waitUntil(() => this.readyToDelete, { timeout: 30 * 1000 })
    } catch (error) {
      if (error instanceof TimeoutError) {
        this.logger.error('Timed out waiting for 30 seconds.', error)
      } else {
        throw(error)
      }
    }
  }

  private isWarningExceed() {
    if (this.warningResetTimer) {
      clearTimeout(this.warningResetTimer)
      this.warningResetTimer = undefined
    }
    const tempTimer = setTimeout(() => {
      this.warningResetTimer = undefined
      this.warningCount = 0
    }, 1 * 1000)
    this.warningResetTimer = tempTimer

    this.warningCount++
    return this.warningCount >= this.maxWarning
  }

  private isReconnectExceed() {
    if (this.reconnectResetTimer) {
      clearTimeout(this.reconnectResetTimer)
      this.reconnectResetTimer = undefined
    }
    const tempTimer = setTimeout(() => {
      this.reconnectResetTimer = undefined
      this.reconnectCount = 0
    }, 1 * 1000)
    this.reconnectResetTimer = tempTimer

    this.reconnectCount++
    return this.reconnectCount >= this.maxReconnect
  }

  private async joinVoiceChannel(channelID: string): Promise<VoiceConnection | undefined> {
    this.logger.info('Connecting...')
    try {
      const connection = await this.client.joinVoiceChannel(channelID)
      const reconnect = debounce(() => {
        this.stopSession(channelID, connection)
        if (this.isReconnectExceed()) {
          this.logger.error(`Reconnect count exceeded ${this.maxReconnect}. Trying to reconnect bot...`)
          if (this.active) this.sendAdminMessage(`Reconnect count exceeded ${this.maxReconnect}. Trying to reconnect bot...`)
          instances.discord?.disconnect(true)
        }
        setTimeout(() => {
          this.startAudioSession(channelID)
        }, 5 * 1000)
      }, 500)
      connection.on('warn', (message: string) => {
        this.logger.warn(message)
        if (this.active) this.sendAdminMessage(`Warning from ${channelID}: ${message}`)
        if (this.isWarningExceed()) {
          this.logger.error(`Warning count exceeded ${this.maxWarning}. Reconnecting...`)
          if (this.active) this.sendAdminMessage(`Warning count exceeded ${this.maxWarning}. Reconnecting...`)
          reconnect()
        }
      })
      connection.on('error', err => {
        this.logger.error(err.message, err)
        if (this.active) this.sendAdminMessage(`Error from voice connection ${channelID}: ${err.message}`)
      })
      connection.on('ready', () => {
        this.logger.warn('Voice connection reconnected.')
        this.warningResetTimer = undefined
        this.warningCount = 0
      })
      connection.once('disconnect', err => {
        this.logger.error(`Error from voice connection: ${err?.message}`, err)
        if (this.active) {
          this.sendAdminMessage(`Error from voice connection ${channelID}: ${err?.message}`)
          this.sendMessage('There is an error with the voice connection.')
          reconnect()
        }
      })
      return connection
    } catch (e) {
      if (e instanceof Error) {
        this.logger.error(`${e.name} ${e.message}`, e)
        this.sendAdminMessage(`Error from ${channelID}: ${e.name} ${e.message}`)
      }
    }
    return undefined
  }

  private setEndStreamEvents(connection: VoiceConnection) {
    const guildID = (this.client.getChannel(this.channelConfig.id) as VoiceChannel).guild.id
    connection.on('userDisconnect', user => {
      this.recorder.endStream(user)
    })

    this.client.on('voiceChannelSwitch', (member, newChannel) => {
      if (newChannel.guild.id !== guildID) return
      if (newChannel.id !== this.channelConfig.id) {
        this.recorder.endStream(member.id)
      }
    })
  }
}
