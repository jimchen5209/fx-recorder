import { createWriteStream, existsSync as exists, mkdirSync as mkDir, rmSync as rmDir, type WriteStream } from 'node:fs'
import type { Readable } from 'node:stream'
import { finished } from 'node:stream/promises'
import dayjs from 'dayjs'
import customParseFormat from 'dayjs/plugin/customParseFormat'
import timezone from 'dayjs/plugin/timezone'
import utc from 'dayjs/plugin/utc'
import type { ILogObj, Logger } from 'tslog'
import AudioUtils from '../../../Libs/audio'
import type LicsonMixer from '../../../Libs/LicsonMixer/mixer'
import type { RecordingChannel } from '../../Recording/Types'

export interface IUserRecordFile {
  readonly user: string
  readonly audioFilePath: string
  readonly audioFileName: string
  readonly tag: string
}

// One finished segment: exactly the files it wrote, all complete
export interface IRecordFile {
  readonly start: string
  readonly end: string
  readonly tags: readonly string[]
  readonly audioFilePath: string
  readonly audioFileName: string
  readonly perUserFiles: readonly IUserRecordFile[]
}

// An encoder's MP3 output; done settles when FFmpeg exits (Libs/audio)
type Mp3Stream = Readable & { done: Promise<void> }

interface SegmentFile {
  user?: string
  path: string
  name: string
  // Settles when the file is complete; rejects when it cannot be
  done: Promise<unknown>
}

interface Segment {
  start: string
  files: SegmentFile[]
}

// The mixed recording, or one user's: an encoder and the file it is writing now
interface Output {
  mp3: Mp3Stream
  writer?: WriteStream
  file?: SegmentFile
}

const TIME_FORMAT = 'YYYY-MM-DD HH-mm-ss'

export class RecordSaver {
  private channelConfig: RecordingChannel
  private userMixers?: { [key: string]: LicsonMixer }
  private logger: Logger<ILogObj>
  private debug: boolean

  private mixed?: Output
  private perUser: { [user: string]: Output } = {}
  private segment?: Segment
  // Files still being written, which exists() may not see yet: a new file never takes the name of one of them
  private usedPaths = new Set<string>()

  // mainLogger: the app's main logger; debug: config.logging.debug
  constructor(channelConfig: RecordingChannel, mainLogger: Logger<ILogObj>, debug: boolean) {
    this.channelConfig = channelConfig
    this.logger = mainLogger.getSubLogger({ name: 'RecordSaver', prefix: [`[${channelConfig.id}]`] })
    this.debug = debug

    if (exists(`temp/${this.channelConfig.storageKey}`)) rmDir(`temp/${this.channelConfig.storageKey}`, { recursive: true })
    mkDir(`temp/${this.channelConfig.storageKey}`)

    // setup dayjs
    dayjs.extend(utc)
    dayjs.extend(timezone)
    dayjs.extend(customParseFormat)
  }

  private encode(mixer: LicsonMixer) {
    return AudioUtils.generatePCMtoMP3Stream(mixer, this.debug) as Mp3Stream
  }

  private now() {
    return dayjs.utc().tz(this.channelConfig.timeZone).format(TIME_FORMAT)
  }

  private outputs(): [string | undefined, Output][] {
    return [...(this.mixed ? [[undefined, this.mixed] as [undefined, Output]] : []), ...Object.entries(this.perUser)]
  }

  public setRecvMixer(recvMixer: LicsonMixer) {
    this.mixed = { mp3: this.encode(recvMixer) }
  }

  public setUserMixers(userMixers: { [key: string]: LicsonMixer }) {
    this.userMixers = userMixers

    for (const user of Object.keys(this.userMixers)) {
      if (!this.userMixers[user]) continue
      this.perUser[user] = { mp3: this.encode(this.userMixers[user]) }
    }
  }

  // A new file in the current segment; the visible name gets -2, -3, ... only when it is taken
  private openFile(output: Output, user?: string) {
    if (!this.segment) return
    const base = `${user ? `${user}-` : ''}${this.segment.start}`
    const pathOf = (name: string) => `temp/${this.channelConfig.storageKey}/${name}`
    let name = `${base}.mp3`
    for (let n = 2; this.usedPaths.has(pathOf(name)) || exists(pathOf(name)); n++) name = `${base}-${n}.mp3`
    const path = pathOf(name)
    this.logger.debug(`Start recording ${user ? `for ${user} ` : ''}to ${path}`)

    this.usedPaths.add(path)
    const writer = createWriteStream(path)
    // pipe() lets go of a failed writer; keep reading so FFmpeg does not block on a full pipe
    writer.on('error', () => output.mp3.resume())
    const file: SegmentFile = { user, path, name, done: finished(writer) }
    // Awaited in finish(); once written, exists() guards the name
    const release = () => this.usedPaths.delete(path)
    file.done.then(release, release)
    this.segment.files.push(file)
    output.writer = writer
    output.file = file
    output.mp3.pipe(writer)
  }

  // Ends the output's file now; its encoder goes on into the next one
  private cutFile(output: Output) {
    if (!output.writer) return
    output.mp3.unpipe(output.writer)
    output.writer.end()
    output.writer = undefined
    output.file = undefined
  }

  // The output's mixer has stopped: its file takes what the encoder still holds and ends with it, failing if the encoder fails
  private closeOutput(output: Output) {
    if (!output.file) {
      // Read to the end, so FFmpeg is not left blocked on a full pipe
      output.mp3.resume()
      return
    }
    output.file.done = Promise.all([output.file.done, output.mp3.done])
    output.file.done.catch(() => undefined)
  }

  // Opens a file for the mixed recording and for each user who is still sending
  private openFiles() {
    for (const [user, output] of this.outputs()) {
      if (user && this.userMixers?.[user]?.getSources().length === 0) continue
      this.openFile(output, user)
    }
  }

  // Waits for every file of the segment; an unfinished or failed segment is never handed over
  private async finish(segment: Segment, end: string): Promise<IRecordFile> {
    try {
      await Promise.all(segment.files.map((file) => file.done))
    } catch (error) {
      this.logger.error(`Recording from ${segment.start} could not be finished, kept and not sent: ${error instanceof Error ? error.message : error}`)
      throw error
    }
    const mixed = segment.files.find((file) => !file.user)
    if (!mixed) throw new Error(`Recording from ${segment.start} has no mixed file`)
    const time = dayjs.tz(segment.start, TIME_FORMAT, this.channelConfig.timeZone)
    this.logger.debug(`Record file from ${segment.start} to ${end}: ${segment.files.map((file) => file.path).join(', ')}`)
    return Object.freeze({
      start: segment.start,
      end,
      tags: Object.freeze([`#Date${time.format('YYYYMMDD')}`, `#Time${time.format('HHmm')}`, `#Year${time.format('YYYY')}`]),
      audioFilePath: mixed.path,
      audioFileName: mixed.name,
      perUserFiles: Object.freeze(
        segment.files
          .filter((file): file is SegmentFile & { user: string } => file.user !== undefined)
          .map((file) => Object.freeze({ user: file.user, audioFilePath: file.path, audioFileName: file.name, tag: `#User${file.user}` }))
      )
    })
  }

  public addUser(user: string) {
    if (!this.userMixers) return
    const output: Output = { mp3: this.encode(this.userMixers[user]) }
    this.perUser[user] = output
    this.openFile(output, user)
  }

  // Call after stopping the user's mixer
  public removeUser(user: string) {
    const output = this.perUser[user]
    if (!output) return
    delete this.perUser[user]
    this.closeOutput(output)
  }

  // Starts the next segment at once and resolves with the last one when its files are complete; undefined without a session
  public getFilePeriod(): Promise<IRecordFile | undefined> {
    const closed = this.segment
    if (!closed) return Promise.resolve(undefined)
    const end = this.now()
    for (const [, output] of this.outputs()) this.cutFile(output)
    this.segment = { start: end, files: [] }
    this.openFiles()
    return this.finish(closed, end)
  }

  public startSession() {
    this.segment = { start: this.now(), files: [] }
    this.openFiles()
  }

  // Call after stopping the mixers. Resolves with the last segment once the encoders have flushed into it; undefined
  // when there is no session (a second call)
  public endSession(): Promise<IRecordFile | undefined> {
    const closed = this.segment
    if (!closed) return Promise.resolve(undefined)
    const end = this.now()
    this.segment = undefined
    for (const [, output] of this.outputs()) this.closeOutput(output)
    this.mixed = undefined
    this.perUser = {}
    return this.finish(closed, end)
  }
}
