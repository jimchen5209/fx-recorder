import { Transform } from 'node:stream'

declare class AbortStream extends Transform {
  constructor(highWaterMark: number, chunkSize: number)
}

export default AbortStream
