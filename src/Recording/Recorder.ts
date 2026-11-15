import type { ILogObj, Logger } from 'tslog'
import AbortStream from '../Libs/abort'
import LicsonMixer from '../Libs/LicsonMixer/mixer'
import { RecordSaver } from './RecordSaver'
import type { RecordingChannel } from './Types'

export class Recorder {
  private channelConfig: RecordingChannel
  private logger: Logger<ILogObj>
  private _saver: RecordSaver

  // Mixer
  private recvMixer?: LicsonMixer
  private userMixers?: { [key: string]: LicsonMixer }
  // Sources each user still has open; the user's file ends with the last one (see endSource)
  private userSources: { [user: string]: Set<string> } = {}

  // mainLogger: the app's main logger; debug: config.logging.debug
  constructor(channelConfig: RecordingChannel, mainLogger: Logger<ILogObj>, debug: boolean) {
    this.channelConfig = channelConfig
    this.logger = mainLogger.getSubLogger({ name: 'Recorder', prefix: [`[${channelConfig.id}]`] })

    this._saver = new RecordSaver(channelConfig, mainLogger, debug)
  }
  // sourceId tells apart one user's streams (Fluxer: one per connection and track); Discord has one per user
  public storeBuffer(data: Buffer, user: string, sourceId = user) {
    if (!user || this.channelConfig.ignoreUsers.includes(user)) return
    if (this.recvMixer) {
      // An ended source stays in the mixer until it drains; one who comes back gets a new one
      let source = this.recvMixer.getSources(sourceId).find((existing) => !existing.stream.writableEnded)
      if (!source) {
        this.logger.info(`Add new user ${user} to record mixer`)
        // Labeled by both, so a user's sources can be found by user too
        source = this.recvMixer.addSource(new AbortStream(64 * 1000 * 8, 64 * 1000 * 4), [sourceId, user])
      }
      source.stream.write(data)
    }

    if (this.userMixers) {
      if (!this.userMixers[user]) this.newPerUserMixer(user)

      let perUserSource = this.userMixers[user].getSources(sourceId).find((existing) => !existing.stream.writableEnded)
      if (!perUserSource) perUserSource = this.userMixers[user].addSource(new AbortStream(64 * 1000 * 8, 64 * 1000 * 4), sourceId)
      perUserSource.stream.write(data)
      if (!this.userSources[user]) this.userSources[user] = new Set()
      this.userSources[user].add(sourceId)
    }
  }

  // Ends one source; the user's per-user file ends only with their last source, as endStream does
  public endSource(user: string, sourceId: string) {
    const sources = this.userSources[user]
    if (sources) sources.delete(sourceId)
    if (!sources || sources.size === 0) {
      this.endStream(user)
      return
    }
    this.recvMixer?.getSources(sourceId)[0]?.stream.end()
    this.userMixers?.[user]?.getSources(sourceId)[0]?.stream.end()
  }

  private newPerUserMixer(user: string) {
    if (!this.userMixers) return
    this.logger.info(`Created new per user mixer ${user}`)
    this.userMixers[user] = new LicsonMixer(16, 2, 48000)
    this.userMixers[user].on('error', (error) => {
      this.logger.error(`Error on new per user mixer ${user}: ${error.message}`, error)
    })
    this._saver.addUser(user)
  }

  public startStream() {
    this.recvMixer = new LicsonMixer(16, 2, 48000)
    this.userMixers = {}
    this.recvMixer.on('error', (error) => {
      this.logger.error(`Error on mixer: ${error.message}`, error)
    })
    this._saver.setRecvMixer(this.recvMixer)
    this._saver.setUserMixers(this.userMixers)
    this._saver.startSession()
  }

  public endStream(user: string) {
    delete this.userSources[user]
    for (const source of this.recvMixer?.getSources(user) ?? []) source.stream.end()
    // Dropped, so one who comes back gets a new per-user mixer and file
    this.userMixers?.[user]?.stop()
    if (this.userMixers) delete this.userMixers[user]
    this._saver.removeUser(user)
  }

  public stop() {
    this.logger.info('Stop recording and saving file')
    // Every mixer stops before the session ends, so each encoder flushes into the last segment
    this.recvMixer?.stop()
    if (this.userMixers) {
      for (const key of Object.keys(this.userMixers)) {
        if (!this.userMixers[key]) continue
        this.userMixers[key].stop()
        delete this.userMixers[key]
      }
      this.userMixers = undefined
    }

    const restFiles = this._saver.endSession()

    this.recvMixer = undefined
    this.userSources = {}

    return restFiles
  }

  public get saver() {
    return this._saver
  }
}
