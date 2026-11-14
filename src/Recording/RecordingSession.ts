import { readdirSync, statSync, unlinkSync } from 'node:fs'
import type { ILogObj, Logger } from 'tslog'
import { Recorder } from './Recorder'
import type { IRecordFile } from './RecordSaver'
import type { RecordingChannel } from './Types'

const STALE_AGE_MS = 24 * 60 * 60 * 1000
const CLEANUP_EVERY_MS = 60 * 60 * 1000

export interface RecordingSessionOptions {
  // The main logger, for the Recorder and RecordSaver
  mainLogger: Logger<ILogObj>
  // The channel's logger
  logger: Logger<ILogObj>
  // config.logging.debug
  debug: boolean
  // Sends a finished segment; keepFiles for the last one of a session
  deliver: (file: IRecordFile, options: { keepFiles: boolean }) => Promise<unknown>
  // A message to the channel's destinations
  announce: (message: string) => Promise<unknown>
}

// The recording lifecycle of one channel, shared by Discord and Fluxer: a segment every sendIntervalSecond, the rest
// when the session ends, stale cleanup, and the work shutdown waits for. The voice connection feeds PCM into recorder.
export class RecordingSession {
  public readonly recorder: Recorder
  private channel: RecordingChannel
  private options: RecordingSessionOptions
  private sendInterval: NodeJS.Timeout | undefined
  private cleanupInterval: NodeJS.Timeout | undefined
  // Segments being finished or sent, and messages on their way
  private pending = new Set<Promise<unknown>>()
  private running = false

  constructor(channel: RecordingChannel, options: RecordingSessionOptions) {
    this.channel = channel
    this.options = options
    this.recorder = new Recorder(channel, options.mainLogger, options.debug)
    // Runs until close(), also while the channel is empty
    this.cleanupInterval = setInterval(() => this.cleanStale(), CLEANUP_EVERY_MS)
  }

  // Once until stop(): starting again would replace the mixers and leave the old ones recording on their own
  public start() {
    if (this.running) return
    this.running = true
    this.recorder.startStream()
    this.sendInterval = setInterval(() => {
      this.track(this.recorder.saver.getFilePeriod().then((file) => file && this.options.deliver(file, { keepFiles: false })))
    }, this.channel.sendIntervalSecond * 1000)
    this.track(this.options.announce('Record session started'))
  }

  // Sends the rest. The last segment's files stay on disk after it is sent, as before; a second stop sends no segment
  public stop() {
    this.running = false
    clearInterval(this.sendInterval)
    this.options.logger.info('Sending rest of recording...')
    this.track(
      this.recorder
        .stop()
        .then((file) => file && this.options.deliver(file, { keepFiles: true }))
        .then(() => this.options.announce('The record session has ended.'))
    )
  }

  // Shutdown waits for it. Failures are logged where they happen; caught so they do not crash the bot, and a failed
  // segment's files stay for stale cleanup
  public track(work: Promise<unknown>) {
    const tracked: Promise<unknown> = work.catch(() => undefined).finally(() => this.pending.delete(tracked))
    this.pending.add(tracked)
  }

  // For shutdown: stops stale cleanup and resolves once every segment and message is done. The caller sets the deadline.
  public async close() {
    clearInterval(this.cleanupInterval)
    await Promise.all(this.pending)
  }

  private cleanStale() {
    const dir = `temp/${this.channel.storageKey}`
    try {
      for (const f of readdirSync(dir)) {
        if (!f.endsWith('.mp3')) continue
        const p = `${dir}/${f}`
        if (Date.now() - statSync(p).mtimeMs > STALE_AGE_MS) {
          unlinkSync(p)
          this.options.logger.warn(`Cleaned up stale recording: ${f}`)
        }
      }
    } catch {
      // temp dir may not exist yet
    }
  }
}
