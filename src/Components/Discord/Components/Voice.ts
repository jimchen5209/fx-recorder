import { CommandClient, VoiceConnection, VoiceChannel } from 'eris'
import { Logger } from 'tslog-helper'
import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import { Core } from '../../..'
import LicsonMixer, { Readable } from '../../../Libs/LicsonMixer/mixer'
import { EventEmitter } from 'events'
import AudioUtils from '../../../Libs/audio'
import AbortStream from '../../../Libs/abort'
import { createWriteStream, mkdirSync, unlinkSync, existsSync, rmSync, WriteStream, readFileSync } from 'fs'
import { Silence } from './Silence'
import { waitUntil, TimeoutError }  from 'async-wait-until'
import { debounce } from 'lodash'

export class DiscordVoice extends EventEmitter {
    private core: Core
    private bot: CommandClient
    private logger: Logger
    private channelConfig: { id: string, fileDest: { type: string, id: string, sendAll: boolean, sendPerUser: boolean }[], timeZone: string, sendIntervalSecond: number, ignoreUsers: string[] }
    private recvMixer = new LicsonMixer(16, 2, 48000)
    private userMixers: { [key: string]: LicsonMixer } = {}
    private active = true
    private readyToDelete = false
    private maxWarning = 5
    private warningCount = 0
    private warningResetTimer: NodeJS.Timeout | undefined
    private maxReconnect = 5
    private reconnectCount = 0
    private reconnectResetTimer: NodeJS.Timeout | undefined

    constructor (
        core: Core,
        bot: CommandClient,
        logger: Logger,
        channelConfig: { id: string, fileDest: { type: string, id: string, sendAll: boolean, sendPerUser: boolean }[], timeZone: string, sendIntervalSecond: number, ignoreUsers: string[] }
    ) {
        super()

        this.core = core
        this.bot = bot
        this.logger = logger
        this.channelConfig = channelConfig

        // setup dayjs
        dayjs.extend(utc)
        dayjs.extend(timezone)
        dayjs.extend(customParseFormat)

        this.startAudioSession(this.channelConfig.id)
    }

    private async startAudioSession (channelID: string) {
        for (let retryCount = 1; retryCount <= 5; ++retryCount) {
            const connection = await this.joinVoiceChannel(channelID)
            if (connection !== undefined) {
                this.logger.info(`Connected to ${channelID}, start recording...`)
                connection.play(new Silence(), { format: 'opusPackets' })
                this.startRecording(connection)
                this.startSendRecord()
                this.setEndStreamEvents(connection)
                return
            }
            this.logger.error(`Connecting to voice channel ${channelID} failed. Retrying (${retryCount} / 5)...`)
        }
        this.active = false
        this.logger.fatal(`Connecting to voice channel ${channelID} failed after retrying 5 times. Channel recording aborted.`)

        await this.sendMessage('Connecting to voice channel failed after retrying 5 times. Channel recording aborted.')
    }

    private startRecording (connection: VoiceConnection) {
        this.recvMixer.on('error', error => {
            this.logger.error(`Error on mixer of ${this.channelConfig.id}: ${error.message}`, error)
        })

        connection.receive('pcm').on('data', (data, user) => {
            if (!user || this.channelConfig.ignoreUsers.includes(user)) return
            if (!this.active) return

            let source = this.recvMixer.getSources(user)[0]
            if (!source) {
                this.logger.info(`New user ${user} to record mixer ${this.channelConfig.id}.`)
                source = this.recvMixer.addSource(new AbortStream(64 * 1000 * 8, 64 * 1000 * 4), user)
            }
            source.stream.write(data)

            if (!this.userMixers[user]) this.newPerUserMixer(user)

            let perUserSource = this.userMixers[user].getSources(user)[0]
            if (!perUserSource) perUserSource = this.userMixers[user].addSource(new AbortStream(64 * 1000 * 8, 64 * 1000 * 4), user)
            perUserSource.stream.write(data)
        })
    }

    private newPerUserMixer (user: string) {
        this.logger.info(`New per user mixer ${user} for ${this.channelConfig.id} created.`)
        this.userMixers[user] = new LicsonMixer(16, 2, 48000)
        this.userMixers[user].on('error', error => {
            this.logger.error(`Error on new per user mixer ${user} of ${this.channelConfig.id}: ${error.message}`, error)
        })
        this.emit('newUserStream', user)
    }

    private startSendRecord () {
        const mp3Stream = AudioUtils.generatePCMtoMP3Stream(this.recvMixer, this.core.config.logging.debug)
        const perUserMp3Stream: { [key: string]: Readable } = {}

        for (const user of Object.keys(this.userMixers)) {
            if (!this.userMixers[user]) continue

            perUserMp3Stream[user] = AudioUtils.generatePCMtoMP3Stream(this.userMixers[user], this.core.config.logging.debug)
        }

        let mp3Start = ''
        let finalMp3Start = ''
        let writeStream: WriteStream
        const perUserWriteStream: { [key: string]: WriteStream } = {}

        if (existsSync(`temp/${this.channelConfig.id}`)) rmSync(`temp/${this.channelConfig.id}`, { recursive: true })
        mkdirSync(`temp/${this.channelConfig.id}`)

        const endStream = (user: string | undefined = undefined) => {
            if (!user) {
                mp3Stream.unpipe()
                writeStream.end()

                for (const element of Object.keys(this.userMixers)) {
                    if (!this.userMixers[element]) continue
                    if (perUserMp3Stream[element]) perUserMp3Stream[element].unpipe()
                    if (perUserWriteStream[element]) perUserWriteStream[element].end()
                    delete perUserWriteStream[element]
                }

                finalMp3Start = mp3Start
                mp3Start = ''
            }
            else
            {
                if (perUserMp3Stream[user]) perUserMp3Stream[user].unpipe()
                if (perUserWriteStream[user]) perUserWriteStream[user].end()
                delete perUserWriteStream[user]
            }
        }

        const startStream = (user: string | undefined = undefined) => {
            if (!user) {
                mp3Start = dayjs.utc().tz(this.channelConfig.timeZone).format('YYYY-MM-DD HH-mm-ss')
                writeStream = createWriteStream(`temp/${this.channelConfig.id}/${mp3Start}.mp3`)
                mp3Stream.pipe(writeStream)

                for (const element of Object.keys(this.userMixers)) {
                    if (!this.userMixers[element] || !perUserMp3Stream[element]) continue
                    if (this.userMixers[element].getSources(user).length === 0) continue
                    perUserWriteStream[element] = createWriteStream(`temp/${this.channelConfig.id}/${element}-${mp3Start}.mp3`)
                    perUserMp3Stream[element].pipe(perUserWriteStream[element])
                }
            }
            else {
                if (!perUserMp3Stream[user]) return
                perUserWriteStream[user] = createWriteStream(`temp/${this.channelConfig.id}/${user}-${mp3Start}.mp3`)
                perUserMp3Stream[user].pipe(perUserWriteStream[user])
            }
        }

        const sendRecordFile = async () => {
            const mp3StartToSend = finalMp3Start
            const mp3End = dayjs.utc().tz(this.channelConfig.timeZone).format('YYYY-MM-DD HH-mm-ss')
            const time = dayjs.tz(mp3StartToSend, 'YYYY-MM-DD HH-mm-ss', this.channelConfig.timeZone)

            for (const element of this.channelConfig.fileDest) {
                if (element.type === 'telegram' && element.id !== '' && this.core.telegram) {
                    if (element.sendAll) {
                        this.logger.info(`Sending ${mp3StartToSend}.mp3 of ${this.channelConfig.id} to telegram ${element.id}`)
                        const caption = `Start:${mp3StartToSend}\nEnd:${mp3End}\n\n#Date${time.format('YYYYMMDD')} #Time${time.format('HHmm')} #Year${time.format('YYYY')}`
                        await this.core.telegram.sendAudio(element.id, `temp/${this.channelConfig.id}/${mp3StartToSend}.mp3`, caption)
                    }
                    if (element.sendPerUser) {
                        for (const user of Object.keys(this.userMixers)) {
                            if (existsSync(`temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`)) {
                                this.logger.info(`Sending ${user}-${mp3StartToSend}.mp3 of ${this.channelConfig.id} to telegram ${element.id}`)
                                const caption = `Start:${mp3StartToSend}\nEnd:${mp3End}\nUser:${user}\n\n#Date${time.format('YYYYMMDD')} #Time${time.format('HHmm')} #Year${time.format('YYYY')} #User${user}`
                                await this.core.telegram.sendAudio(element.id, `temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`, caption)
                            }
                        }
                    }
                }
                if (element.type === 'discord' && element.id !== '') {
                    if (element.sendAll) {
                        this.logger.info(`Sending ${mp3StartToSend}.mp3 of ${this.channelConfig.id} to discord ${element.id}`)
                        const caption = `Start:${mp3StartToSend}\nEnd:${mp3End}`
                        await this.bot.createMessage(element.id, caption, { name: `${mp3StartToSend}.mp3`, file: readFileSync(`temp/${this.channelConfig.id}/${mp3StartToSend}.mp3`) })
                    }
                    if (element.sendPerUser) {
                        for (const user of Object.keys(this.userMixers)) {
                            if (existsSync(`temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`)) {
                                this.logger.info(`Sending ${user}-${mp3StartToSend}.mp3 of ${this.channelConfig.id} to discord ${element.id}`)
                                const caption = `Start:${mp3StartToSend}\nEnd:${mp3End}\nUser:${user}`
                                await this.bot.createMessage(element.id, caption, { name: `${user}-${mp3StartToSend}.mp3`, file: readFileSync(`temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`) })
                            }
                        }
                    }
                }
            }

            unlinkSync(`temp/${this.channelConfig.id}/${mp3StartToSend}.mp3`)
            for (const user of Object.keys(this.userMixers)) {
                if (existsSync(`temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`)) {
                    unlinkSync(`temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`)
                }
                if (this.userMixers[user]?.getSources(user).length === 0) {
                    this.logger.info(`Remove unused per user mixer ${user} for ${this.channelConfig.id}`)
                    delete this.userMixers[user]
                }
            }
        }

        const sendInterval = setInterval(() => {
            endStream()
            startStream()
            sendRecordFile()
        }, this.channelConfig.sendIntervalSecond * 1000)

        this.on('endSession', () => {
            clearInterval(sendInterval)
            this.logger.info('Sending rest of recording...')
            endStream()
            sendRecordFile().then(async () => {
                await this.sendMessage('The record session has ended.')
                this.removeAllListeners()
                if (!this.active) this.readyToDelete = true
            })
        })

        this.on('newUserStream', (user: string) => {
            perUserMp3Stream[user] = AudioUtils.generatePCMtoMP3Stream(this.userMixers[user], this.core.config.logging.debug)
            startStream(user)
        })

        this.on('userEndStream', (user: string) => {
            endStream(user)
        })

        this.sendMessage('Record session started')
        startStream()
    }

    private async sendMessage (message: string) {
        for (const element of this.channelConfig.fileDest) {
            if (element.type === 'telegram' && element.id !== '' && this.core.telegram) {
                await this.core.telegram.sendMessage(element.id, message)
            }
            if (element.type === 'discord' && element.id !== '') {
                await this.bot.createMessage(element.id, message)
            }
        }
    }

    private async sendAdminMessage (message: string) {
        if (this.core.config.discord.logErrorsToAdmin) {
            for (const admin of this.core.config.discord.admins) {
                try {
                    const dmChannel = await this.bot.getDMChannel(admin)
                    await this.bot.createMessage(dmChannel.id, message)
                } catch (error) {
                    if (error instanceof Error) {
                        this.logger.error(`Message "${message}" send to discord admin ${admin} failed: ${error.message}`, error)
                    }
                }
            }
        }
        if (this.core.config.telegram.logErrorsToAdmin && this.core.telegram) {
            for (const admin of this.core.config.telegram.admins) {
                try {
                    await this.core.telegram.sendMessage(admin, message)
                } catch (error) {
                    if (error instanceof Error) {
                        this.logger.error(`Message "${message}" send to telegram admin ${admin} failed: ${error.message}`, error)
                    }
                }
            }
        }
    }

    private stopSession (channelID:string, connection: VoiceConnection) {
        connection.stopPlaying()
        this.recvMixer.stop()

        this.emit('endSession')

        this.recvMixer = new LicsonMixer(16, 2, 48000)

        for (const key of Object.keys(this.userMixers)) {
            if (!this.userMixers[key]) continue
            this.userMixers[key].stop()
            delete this.userMixers[key]
        }

        this.bot.leaveVoiceChannel(channelID)
    }

    public async stop (connection: VoiceConnection) {
        this.active = false

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

    private isWarningExceed () {
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

    private isReconnectExceed () {
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

    private async joinVoiceChannel (channelID: string): Promise<VoiceConnection | undefined> {
        this.logger.info(`Connecting to ${channelID}...`)
        try {
            const connection = await this.bot.joinVoiceChannel(channelID)
            const reconnect = debounce(() => {
                this.stopSession(channelID, connection)
                if (this.isReconnectExceed()) {
                    this.logger.error(`Reconnect count exceeded ${this.maxReconnect}. Trying to reconnect bot...`)
                    if (this.active) this.sendAdminMessage(`Reconnect count exceeded ${this.maxReconnect}. Trying to reconnect bot...`)
                    this.core.discord?.disconnect(true)
                }
                setTimeout(() => {
                    this.startAudioSession(channelID)
                }, 5 * 1000)
            }, 500)
            connection.on('warn', (message: string) => {
                this.logger.warn(`Warning from ${channelID}: ${message}`)
                if (this.active) this.sendAdminMessage(`Warning from ${channelID}: ${message}`)
                if (this.isWarningExceed()) {
                    this.logger.error(`Warning count exceeded ${this.maxWarning}. Reconnecting...`)
                    if (this.active) this.sendAdminMessage(`Warning count exceeded ${this.maxWarning}. Reconnecting...`)
                    reconnect()
                }
            })
            connection.on('error', err => {
                this.logger.error(`Error from voice connection ${channelID}: ${err.message}`, err)
                if (this.active) this.sendAdminMessage(`Error from voice connection ${channelID}: ${err.message}`)
            })
            connection.on('ready', () => {
                this.logger.warn('Voice connection reconnected.')
                this.warningResetTimer = undefined
                this.warningCount = 0
            })
            connection.once('disconnect', err => {
                this.logger.error(`Error from voice connection ${channelID}: ${err?.message}`, err)
                if (this.active) {
                    this.sendAdminMessage(`Error from voice connection ${channelID}: ${err?.message}`)
                    this.sendMessage('There is an error with the voice connection.')
                    reconnect()
                }
            })
            return connection
        } catch (e) {
            if (e instanceof Error) {
                this.logger.error(`Error from ${channelID}: ${e.name} ${e.message}`, e)
                this.sendAdminMessage(`Error from ${channelID}: ${e.name} ${e.message}`)
            }
        }
        return undefined
    }

    private endStream (user: string) {
        this.recvMixer.getSources(user)[0]?.stream.end()
        this.userMixers[user]?.stop()
        this.emit('userEndStream', user)
    }

    private setEndStreamEvents (connection: VoiceConnection) {
        const guildID = (this.bot.getChannel(this.channelConfig.id) as VoiceChannel).guild.id
        connection.on('userDisconnect', user => {
            this.endStream(user)
        })

        this.bot.on('voiceChannelSwitch', (member, newChannel) => {
            if (newChannel.guild.id !== guildID) return
            if (newChannel.id !== this.channelConfig.id) {
                this.endStream(member.id)
            }
        })
    }
}
