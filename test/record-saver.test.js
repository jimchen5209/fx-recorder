// RecordSaver with the real FFmpeg encoder: files under temp/<storageKey>, rotation, per-user files, decodable output.
// The mixers are PassThroughs fed at once (the real mixer paces on Date.now), so this takes seconds, not minutes.
// Skipped without ffmpeg/ffprobe.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PassThrough } = require('node:stream')
const { spawnSync } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')
const { stubInstances, useTempCwd, hasFfmpeg, tone, channel } = require('./helpers')

stubInstances()
const skip = !hasFfmpeg && 'ffmpeg/ffprobe not installed'

const durationOf = (file) => Number(spawnSync('ffprobe', ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]).stdout.toString()) || 0
function peakOf(file) {
  const pcm = spawnSync('ffmpeg', ['-v', 'error', '-i', file, '-f', 's16le', '-ac', '2', '-ar', '48000', '-'], { maxBuffer: 256 * 1024 * 1024 }).stdout
  let peak = 0
  for (let i = 0; i + 1 < pcm.length; i += 2) peak = Math.max(peak, Math.abs(pcm.readInt16LE(i)))
  return peak
}
// Waits until the file stops growing (FFmpeg has caught up with what it was given)
async function settled(file) {
  let size = -1
  for (let i = 0; i < 50; i++) {
    await sleep(100)
    const now = fs.existsSync(file) ? fs.statSync(file).size : 0
    if (now > 0 && now === size) return now
    size = now
  }
  return size
}
// Stands in for a LicsonMixer: a PCM stream whose getSources() is never empty
function fakeMixer() {
  const mixer = new PassThrough()
  mixer.getSources = () => [{}]
  return mixer
}

// One session: 30 s of PCM, rotate, 30 s more, end. Returns both segments and the saver.
async function session(t) {
  const tmp = useTempCwd()
  const { RecordSaver } = require('../dist/Core/Discord/Recorder/RecordSaver')
  const saver = new RecordSaver(channel({ id: 'c1', storageKey: 'fluxer-test-c1', timeZone: 'UTC' }))
  const mixed = fakeMixer()
  const u1 = fakeMixer()
  t.after(() => {
    // Leftover encoders whose stdout nobody reads any more would keep the test alive (see the short-session test)
    for (const stream of [saver.mp3Stream, ...Object.values(saver.perUserMp3Stream)]) stream?.resume()
    tmp.cleanup()
  })
  saver.setRecvMixer(mixed)
  saver.setUserMixers({ u1 })
  saver.startSession()
  const feed = (seconds) => {
    mixed.write(tone(seconds * 1000, { channels: 'left' }))
    u1.write(tone(seconds * 1000, { channels: 'left' }))
  }

  feed(30)
  await settled(`temp/fluxer-test-c1/${saver.mp3Start}.mp3`)
  // The visible name has one-second resolution: wait so the next segment gets its own
  await sleep(1100)
  const first = saver.getFilePeriod()
  feed(30)
  await settled(`temp/fluxer-test-c1/${first.start}.mp3`)
  await sleep(1100)
  const last = saver.endSession()
  // As Recorder.stop: the mixers end after the session
  mixed.end()
  u1.end()
  await sleep(1500)
  return { saver, first, last }
}

test('rotation writes decodable mixed and per-user files under temp/<storageKey>', { skip }, async (t) => {
  const { saver, first, last } = await session(t)

  assert.notEqual(first.start, last.start)
  assert.match(first.start, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/)
  assert.equal(first.audioFilePath, `temp/fluxer-test-c1/${first.start}.mp3`)
  assert.equal(first.audioFileName, `${first.start}.mp3`)
  assert.deepEqual(
    first.tags.map((tag) => tag.replace(/\d+/, 'N')),
    ['#DateN', '#TimeN', '#YearN']
  )
  assert.deepEqual(first.perUserFiles, [{ user: 'u1', audioFilePath: `temp/fluxer-test-c1/u1-${first.start}.mp3`, audioFileName: `u1-${first.start}.mp3`, tag: '#Useru1' }])

  assert.ok(durationOf(first.audioFilePath) > 1, 'first segment has audio')
  assert.ok(peakOf(first.audioFilePath) > 2000, 'first segment has the tone')
  assert.ok(peakOf(first.perUserFiles[0].audioFilePath) > 2000, 'per-user file has the tone')
  assert.ok(durationOf(last.audioFilePath) > 1, 'last segment has audio')

  saver.removeRecordFile(first.start)
  assert.ok(!fs.existsSync(first.audioFilePath))
  assert.ok(!fs.existsSync(first.perUserFiles[0].audioFilePath))
  assert.ok(fs.existsSync(last.audioFilePath), 'removing one segment leaves the other')
})

// Fails for now: endSession returns the file while its writer is still open, so a caller can send a partial file
test('endSession returns a fully written segment', { skip, todo: true }, async (t) => {
  const tmp = useTempCwd()
  const { RecordSaver } = require('../dist/Core/Discord/Recorder/RecordSaver')
  const saver = new RecordSaver(channel({ timeZone: 'UTC' }))
  const mixed = fakeMixer()
  t.after(() => {
    saver.mp3Stream?.resume()
    tmp.cleanup()
  })
  saver.setRecvMixer(mixed)
  saver.setUserMixers({})
  saver.startSession()
  mixed.write(tone(10 * 1000))
  await sleep(1000)
  const writer = saver.writeStream
  saver.endSession()
  mixed.end()
  assert.ok(writer.writableFinished, 'writer finished when the segment is handed over')
})

// Fails for now: FFmpeg reads about 5 s of input (analyzeduration) before it outputs anything. A shorter session ends
// with its audio still inside FFmpeg; endSession has unpiped stdout by then, so the file stays empty.
test('a 3 s session keeps its audio', { skip, todo: true }, async (t) => {
  const tmp = useTempCwd()
  const { RecordSaver } = require('../dist/Core/Discord/Recorder/RecordSaver')
  const saver = new RecordSaver(channel({ timeZone: 'UTC' }))
  const mixed = fakeMixer()
  t.after(() => {
    saver.mp3Stream?.resume()
    tmp.cleanup()
  })
  saver.setRecvMixer(mixed)
  saver.setUserMixers({})
  saver.startSession()
  mixed.write(tone(3 * 1000))
  await sleep(1000)
  const last = saver.endSession()
  mixed.end()
  await sleep(1500)
  assert.ok(durationOf(last.audioFilePath) > 2.5, `got ${fs.statSync(last.audioFilePath).size} bytes`)
})

test('two rotations in the same second do not overwrite or delete the other segment', { todo: 'not written yet' })
