import { Client, VoiceConnection, VoiceChannel, DiscordRESTError } from '@projectdysnomia/dysnomia'
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
import { FailSafe } from '../../../Utils/FailSafe'

export class DiscordVoice extends EventEmitter {
  private client: Client
  private channelConfig: DiscordChannel
  private logger: Logger<ILogObj>
  private recorder: Recorder
  private sendInterval: NodeJS.Timeout | undefined

  private _active = false
  private readyToDelete = false

  private warningFailSafe = new FailSafe()
  private errorFailSafe = new FailSafe()
  private reconnectFailSafe = new FailSafe()

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

    this.autoLeaveOrJoinChannel()
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
    this._active = false
    this.logger.fatal('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')

    await this.sendMessage('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')
  }

  private startRecording(connection: VoiceConnection) {
    this._active = true
    connection.on('userDisconnect', user => {
      this.handleUserDisconnect(user)
    })
    this.recorder.startStream()
    connection.receive('pcm').on('data', (data, user) => {
      if (!this._active) return
      this.recorder.storeBuffer(data, user)
    })
    this.startSendRecord()

    this.sendMessage('Record session started')
    this.updateStatus()
  }

  private updateStatus() {
    const guild = (this.client.getChannel(this.channelConfig.id) as VoiceChannel).guild

    guild.editMember('@me', {nick: this._active ? `🔴 ${this.client.user.username}` : ''})
      .catch(error => {
        if (error instanceof DiscordRESTError) {
          this.logger.warn(`Failed to update nickname: ${error.message}`)
        }
        else if (error instanceof Error) {
          this.logger.error(`Failed to update status: ${error.message}`, error)
        }
      })
    this.emit('status')
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
    try {
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
            await this.client.createMessage(element.id, {
              content: caption, 
              attachments: [{ filename: file.audioFileName, file: readFile(file.audioFilePath) }]
            })
          }
          if (element.sendPerUser) {
            for (const userFile of file.perUserFiles) {
              this.logger.info(`Sending ${userFile.audioFileName} of ${this.channelConfig.id} to discord ${element.id}`)
              const caption = `Start:${file.start}\nEnd:${file.end}\nUser:${userFile.user}\n\n${[...file.tags, userFile.tag].join(' ')}`
              await this.client.createMessage(element.id, {
                content: caption, 
                attachments: [{ filename: userFile.audioFileName, file: readFile(userFile.audioFilePath) }]
              })
            }
          }
        }
      }
    } catch (error) {
      this.logger.error(`Error sending record file ${file.audioFileName}:`, error)
      if (this._active) this.sendAdminMessage(`Error sending record file ${file.audioFileName}`)
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
      if (!this._active) this.readyToDelete = true
    })

    this.client.leaveVoiceChannel(channelID)
  }

  public async stop(connection: VoiceConnection) {
    this._active = false
    this.updateStatus()

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

  private tryReconnect = debounce((channelID: string, connection: VoiceConnection) => {
    this.stopSession(channelID, connection)
    if (this.reconnectFailSafe.checkHitExceed()) {
      this.logger.error(`Reconnect count exceeded ${this.reconnectFailSafe.maxTimes}. Trying to reconnect bot...`)
      if (this._active) this.sendAdminMessage(`Reconnect count exceeded ${this.reconnectFailSafe.maxTimes}. Trying to reconnect bot...`)
      instances.discord?.disconnect(true)
    }
    setTimeout(() => {
      this.startAudioSession(channelID)
    }, 5 * 1000)
  }, 500)

  private async joinVoiceChannel(channelID: string): Promise<VoiceConnection | undefined> {
    this.logger.info('Connecting...')
    try {
      const connection = await this.client.joinVoiceChannel(channelID)
      connection.on('warn', (message: string) => {
        this.logger.warn(message)
        if (this._active) this.sendAdminMessage(`Warning from ${channelID}: ${message}`)
        if (this.warningFailSafe.checkHitExceed()) {
          this.logger.error(`Warning count exceeded ${this.warningFailSafe.maxTimes}. Reconnecting...`)
          if (this._active) this.sendAdminMessage(`Warning count exceeded ${this.warningFailSafe.maxTimes}. Reconnecting...`)
          this._active = false
          this.tryReconnect(channelID, connection)
        }
      })
      connection.on('error', err => {
        this.logger.error(err.message, err)
        if (this._active) this.sendAdminMessage(`Error from voice connection ${channelID}: ${err.message}`)
        if (this.errorFailSafe.checkHitExceed()) {
          this.logger.error(`Error count exceeded ${this.errorFailSafe.maxTimes}. Reconnecting...`)
          if (this._active) this.sendAdminMessage(`Error count exceeded ${this.errorFailSafe.maxTimes}. Reconnecting...`)
          this._active = false
          this.tryReconnect(channelID, connection)
        }
      })
      connection.on('debug', (message) => this.logger.debug(message))
      connection.on('ready', () => {
        this.logger.warn('Voice connection reconnected.')
        this.warningFailSafe.resetError()
        this.errorFailSafe.resetError()
        this.reconnectFailSafe.resetError()
      })
      connection.once('disconnect', err => {
        this.logger.error(`Error from voice connection: ${err?.message}`, err)
        if (this._active) {
          this.sendAdminMessage(`Error from voice connection ${channelID}: ${err?.message}`)
          this.sendMessage('There is an error with the voice connection.')
          this.tryReconnect(channelID, connection)
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

  public handleUserConnect() {
    this.autoLeaveOrJoinChannel()
  }

  public handleUserDisconnect(userID: string) {
    this.recorder.endStream(userID)
    this.autoLeaveOrJoinChannel()
  }

  private autoLeaveOrJoinChannel= debounce(() => {
    const voiceChannel = this.client.getChannel(this.channelConfig.id) as VoiceChannel
    let noUser = true

    this.logger.debug(`Members in channel : ${voiceChannel.voiceMembers?.map(user => user.id).join(', ')}`)
    voiceChannel.voiceMembers?.forEach(user => {
      if (!this.channelConfig.ignoreUsers.includes(user.id) && user.id !== this.client.user.id) {
        this.logger.debug(`User in channel : ${user.id}`)
        noUser = false
      }
    })
    this.logger.debug(`No user in channel : ${noUser}`)

    const connection = this.client.voiceConnections.find(connection => connection.channelID === this.channelConfig.id)
    this.logger.debug(`Connection in channel exist : ${connection !== undefined}`)
    if (noUser) {
      if (connection) {
        this._active = false
        this.updateStatus()

        this.logger.info('Pausing...')
        this.sendMessage('No user in the channel, pausing...')
        this.sendAdminMessage(`No user in ${this.channelConfig.id}, recorder pausing...`)

        this.stopSession(this.channelConfig.id, connection)
      }
    } else {
      if (!connection) {
        this.startAudioSession(this.channelConfig.id)
      }
    }
  }, 500)

  public get active() {
    return this._active
  }
}
