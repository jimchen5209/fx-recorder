import { OpusEncoder } from '@discordjs/opus'
import type { ILogObj, Logger } from 'tslog'
import type { MediaStreamTrack } from 'werift'
import type { Recorder } from '../../Discord/Recorder/Recorder'
import type { RemoteTrackInfo } from './LiveKitSession'

// Logged at debug when the RTP timestamps of a track jump by more than this, for lining tracks up later
const GAP_LOG_MS = 200

// One subscribed microphone track: Opus RTP decoded to 48 kHz stereo s16le, the PCM Discord's receiver gives, into the Recorder.
// @discordjs/opus, not opusscript: opusscript failed on most packets with several decoders (P0).
export class TrackReceiver {
  public readonly sourceId: string
  private decoder = new OpusEncoder(48000, 2)
  private lastTs: number | undefined
  private decodeErrors = 0

  constructor(
    track: MediaStreamTrack,
    public readonly info: RemoteTrackInfo & { userId: string },
    recorder: Recorder,
    isActive: () => boolean,
    logger: Logger<ILogObj>
  ) {
    this.sourceId = `${info.connectionId}:${info.trackSid}`
    track.onReceiveRtp.subscribe((packet) => {
      if (!isActive()) return
      const ts = packet.header.timestamp
      if (this.lastTs !== undefined) {
        const gapMs = ((ts - this.lastTs) >>> 0) / 48
        if (gapMs > GAP_LOG_MS) logger.debug(`Track ${this.sourceId} of ${info.userId}: RTP gap of ${Math.round(gapMs)} ms`)
      }
      this.lastTs = ts
      let pcm: Buffer
      try {
        pcm = this.decoder.decode(packet.payload)
      } catch (error) {
        // Encrypted media (e2ee) or a broken packet; logged once per hundred so a bad track does not flood the log
        if (this.decodeErrors++ % 100 === 0) logger.warn(`Track ${this.sourceId} of ${info.userId}: ${this.decodeErrors} packet(s) failed to decode: ${error}`)
        return
      }
      recorder.storeBuffer(pcm, info.userId, this.sourceId)
    })
  }
}
