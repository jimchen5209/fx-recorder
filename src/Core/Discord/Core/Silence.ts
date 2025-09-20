import Stream from 'node:stream'

const SILENCE_FRAME = Buffer.from([0xf8, 0xff, 0xfe])

export class Silence extends Stream.Readable {
  _read() {
    this.push(SILENCE_FRAME)
    this.push(null)
  }
}
