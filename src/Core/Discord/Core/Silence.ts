import Stream from 'stream'

const SILENCE_FRAME = Buffer.from([0xF8, 0xFF, 0xFE])

export class Silence extends Stream.Readable {
  _read() {
    this.push(SILENCE_FRAME)
    this.push(null)
  }
}