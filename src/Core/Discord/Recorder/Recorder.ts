import { Logger, ILogObj } from 'tslog'

import LicsonMixer from '../../../Libs/LicsonMixer/mixer'
import AbortStream from '../../../Libs/abort'

import { RecordSaver } from './RecordSaver'
import { DiscordChannel } from '../../../Utils/Config'
import { instances } from '../../../Utils/Instances'

export class Recorder {
  private channelConfig: DiscordChannel
  private logger: Logger<ILogObj>
  private _saver: RecordSaver

  // Mixer
  private recvMixer = new LicsonMixer(16, 2, 48000)
  private userMixers: { [key: string]: LicsonMixer } = {}

  constructor(channelConfig: DiscordChannel) {
    this.channelConfig = channelConfig
    this.logger = instances.mainLogger.getSubLogger({ name: 'Recorder', prefix: [`[${channelConfig.id}]`] })
    this._saver = new RecordSaver(channelConfig, this.recvMixer, this.userMixers)

    this.recvMixer.on('error', error => {
      this.logger.error(`Error on mixer: ${error.message}`, error)
    })
  }

  public storeBuffer(data: Buffer, user: string) {
    if (!user || this.channelConfig.ignoreUsers.includes(user)) return

    let source = this.recvMixer.getSources(user)[0]
    if (!source) {
      this.logger.info(`Add new user ${user} to record mixer`)
      source = this.recvMixer.addSource(new AbortStream(64 * 1000 * 8, 64 * 1000 * 4), user)
    }
    source.stream.write(data)

    if (!this.userMixers[user]) this.newPerUserMixer(user)

    let perUserSource = this.userMixers[user].getSources(user)[0]
    if (!perUserSource) perUserSource = this.userMixers[user].addSource(new AbortStream(64 * 1000 * 8, 64 * 1000 * 4), user)
    perUserSource.stream.write(data)
  }

  private newPerUserMixer(user: string) {
    this.logger.info(`Created new per user mixer ${user}`)
    this.userMixers[user] = new LicsonMixer(16, 2, 48000)
    this.userMixers[user].on('error', error => {
      this.logger.error(`Error on new per user mixer ${user}: ${error.message}`, error)
    })
    this._saver.addUser(user)
  }

  public cleanUpPerUserMixer() {
    for (const user of Object.keys(this.userMixers)) {
      if (this.userMixers[user]?.getSources(user).length === 0) {
        this.logger.info(`Remove unused per user mixer ${user}`)
        delete this.userMixers[user]
      }
    }
  }

  public startStream() {
    this._saver.startSession()
  }

  public endStream(user: string) {
    this.recvMixer.getSources(user)[0]?.stream.end()
    this.userMixers[user]?.stop()
    this._saver.removeUser(user)
  }

  public stop() {
    this.logger.info('Stop recording and saving file')
    this.recvMixer.stop()

    const restFiles = this._saver.endSession()

    this.recvMixer = new LicsonMixer(16, 2, 48000)

    for (const key of Object.keys(this.userMixers)) {
      if (!this.userMixers[key]) continue
      this.userMixers[key].stop()
      delete this.userMixers[key]
    }

    return restFiles
  }

  public get saver() {
    return this._saver
  }
}
