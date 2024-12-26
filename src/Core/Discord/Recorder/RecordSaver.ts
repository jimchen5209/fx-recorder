import { createWriteStream, mkdirSync as mkDir, unlinkSync as deleteFile, existsSync as exists, rmSync as rmDir, WriteStream } from 'fs'
import { Logger, ILogObj } from 'tslog'

import dayjs from 'dayjs'
import utc from 'dayjs/plugin/utc'
import timezone from 'dayjs/plugin/timezone'
import customParseFormat from 'dayjs/plugin/customParseFormat'

import LicsonMixer, { Readable } from '../../../Libs/LicsonMixer/mixer'
import AudioUtils from '../../../Libs/audio'

import { instances } from '../../../Utils/Instances'
import { DiscordChannel } from '../../../Utils/Config'

export interface IUserRecordFile {
  user: string
  audioFilePath: string
  audioFileName: string
  tag: string
}

export interface IRecordFile {
  start: string
  end: string
  tags: string[]
  audioFilePath: string
  audioFileName: string
  perUserFiles: IUserRecordFile[]
}

export class RecordSaver {
  private channelConfig: DiscordChannel
  private recvMixer?: LicsonMixer
  private userMixers?: { [key: string]: LicsonMixer }

  private logger: Logger<ILogObj>
  private mp3Stream?: Readable
  private perUserMp3Stream: { [key: string]: Readable } = {}


  private mp3Start = ''
  private finalMp3Start = ''
  private writeStream?: WriteStream
  private perUserWriteStream: { [key: string]: WriteStream } = {}

  constructor(channelConfig: DiscordChannel) {
    this.channelConfig = channelConfig
    this.logger = instances.mainLogger.getSubLogger({ name: 'RecordSaver', prefix: [`[${channelConfig.id}]`] })

    if (exists(`temp/${this.channelConfig.id}`)) rmDir(`temp/${this.channelConfig.id}`, { recursive: true })
    mkDir(`temp/${this.channelConfig.id}`)

    // setup dayjs
    dayjs.extend(utc)
    dayjs.extend(timezone)
    dayjs.extend(customParseFormat)
  }

  public setRecvMixer(recvMixer: LicsonMixer) {
    this.recvMixer = recvMixer
    this.mp3Stream = AudioUtils.generatePCMtoMP3Stream(this.recvMixer, instances.config.logging.debug)
  }

  public setUserMixers(userMixers: { [key: string]: LicsonMixer }) {
    this.userMixers = userMixers

    for (const user of Object.keys(this.userMixers)) {
      if (!this.userMixers[user]) continue

      this.perUserMp3Stream[user] = AudioUtils.generatePCMtoMP3Stream(this.userMixers[user], instances.config.logging.debug)
    }
  }

  private endStream(user: string | undefined = undefined) {
    if (!user) {
      this.logger.debug(`End recording stream from ${this.mp3Start} to temp/${this.channelConfig.id}/${this.mp3Start}.mp3`)
      this.mp3Stream?.unpipe()
      this.writeStream?.end()

      if (this.userMixers) {
        for (const element of Object.keys(this.userMixers)) {
          if (!this.userMixers[element]) continue
          this.logger.debug(`End recording stream for ${element} from ${this.mp3Start} to temp/${this.channelConfig.id}/${element}-${this.mp3Start}.mp3`)
          if (this.perUserMp3Stream[element]) this.perUserMp3Stream[element].unpipe()
          if (this.perUserWriteStream[element]) this.perUserWriteStream[element].end()
          delete this.perUserWriteStream[element]
        }
      }

      this.finalMp3Start = this.mp3Start
      this.mp3Start = ''
    }
    else
    {
      this.logger.debug(`End recording stream for ${user} from ${this.mp3Start} to temp/${this.channelConfig.id}/${user}-${this.mp3Start}.mp3`)
      if (this.perUserMp3Stream[user]) this.perUserMp3Stream[user].unpipe()
      if (this.perUserWriteStream[user]) this.perUserWriteStream[user].end()
      delete this.perUserWriteStream[user]
    }
  }

  private startStream(user: string | undefined = undefined) {
    if (!user) {
      this.mp3Start = dayjs.utc().tz(this.channelConfig.timeZone).format('YYYY-MM-DD HH-mm-ss')
      this.logger.debug(`Start recording stream from ${this.mp3Start} to temp/${this.channelConfig.id}/${this.mp3Start}.mp3`)
      this.writeStream = createWriteStream(`temp/${this.channelConfig.id}/${this.mp3Start}.mp3`)
      this.mp3Stream?.pipe(this.writeStream)

      if (!this.userMixers) return
      for (const element of Object.keys(this.userMixers)) {
        if (!this.userMixers[element] || !this.perUserMp3Stream[element]) continue
        if (this.userMixers[element].getSources(user).length === 0) continue
        this.logger.debug(`Start recording stream for ${element} from ${this.mp3Start} to temp/${this.channelConfig.id}/${element}-${this.mp3Start}.mp3`)
        this.perUserWriteStream[element] = createWriteStream(`temp/${this.channelConfig.id}/${element}-${this.mp3Start}.mp3`)
        this.perUserMp3Stream[element].pipe(this.perUserWriteStream[element])
      }
    }
    else {
      if (!this.perUserMp3Stream[user]) return
      this.logger.debug(`Start recording stream for ${user} from ${this.mp3Start} to temp/${this.channelConfig.id}/${user}-${this.mp3Start}.mp3`)
      this.perUserWriteStream[user] = createWriteStream(`temp/${this.channelConfig.id}/${user}-${this.mp3Start}.mp3`)
      this.perUserMp3Stream[user].pipe(this.perUserWriteStream[user])
    }
  }

  public addUser(user: string) {
    if (this.userMixers) this.perUserMp3Stream[user] = AudioUtils.generatePCMtoMP3Stream(this.userMixers[user], instances.config.logging.debug)
    this.startStream(user)
  }

  public removeUser(user: string) {
    this.endStream(user)
  }

  private getRecordFile() {
    const mp3StartToSend = this.finalMp3Start
    const mp3End = dayjs.utc().tz(this.channelConfig.timeZone).format('YYYY-MM-DD HH-mm-ss')
    const time = dayjs.tz(mp3StartToSend, 'YYYY-MM-DD HH-mm-ss', this.channelConfig.timeZone)

    this.logger.debug(`Record file from ${mp3StartToSend} to ${mp3End}: temp/${this.channelConfig.id}/${mp3StartToSend}.mp3`)
    return {
      start: mp3StartToSend,
      end: mp3End,
      tags: [`#Date${time.format('YYYYMMDD')}`, `#Time${time.format('HHmm')}`, `#Year${time.format('YYYY')}`],
      audioFilePath: `temp/${this.channelConfig.id}/${mp3StartToSend}.mp3`,
      audioFileName: `${mp3StartToSend}.mp3`,
      perUserFiles: this.userMixers ? Object.keys(this.userMixers)
        .filter(user => exists(`temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`))
        .map(user => {
          this.logger.debug(`Record file for ${user} from ${mp3StartToSend} to ${mp3End}: temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`)
          return {
            user,
            audioFilePath: `temp/${this.channelConfig.id}/${user}-${mp3StartToSend}.mp3`,
            audioFileName: `${user}-${mp3StartToSend}.mp3`,
            tag: `#User${user}`
          }
        }): []
    } as IRecordFile
  }

  public getFilePeriod() {
    this.endStream()
    this.startStream()
    return this.getRecordFile()
  }

  public removeRecordFile = (mp3Start: string) => {
    this.logger.debug(`Removing record file temp/${this.channelConfig.id}/${mp3Start}.mp3`)
    deleteFile(`temp/${this.channelConfig.id}/${mp3Start}.mp3`)

    if (!this.userMixers) return
    for (const user of Object.keys(this.userMixers)) {
      if (exists(`temp/${this.channelConfig.id}/${user}-${mp3Start}.mp3`)) {
        this.logger.debug(`Removing record file temp/${this.channelConfig.id}/${user}-${mp3Start}.mp3`)
        deleteFile(`temp/${this.channelConfig.id}/${user}-${mp3Start}.mp3`)
      }
    }
  }

  public startSession() {
    this.startStream()
  }

  public endSession() {
    this.endStream()
    return this.getRecordFile()
  }
}
