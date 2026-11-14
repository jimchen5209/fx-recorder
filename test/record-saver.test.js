// RecordSaver with the real FFmpeg encoder: files under temp/<storageKey>, rotation, per-user files, decodable output,
// segments handed over only when complete, name collisions, and failures that must not count as a finished segment.
// The mixers are PassThroughs fed at once (the real mixer paces on Date.now), so this takes seconds, not minutes.
// Skipped without ffmpeg/ffprobe.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { PassThrough } = require('node:stream')
const { spawnSync } = require('node:child_process')
const { setTimeout: sleep } = require('node:timers/promises')
const { fakeLogger, useTempCwd, hasFfmpeg, tone, channel } = require('./helpers')

const skip = !hasFfmpeg && 'ffmpeg/ffprobe not installed'
const { RecordSaver } = require('../dist/Recording/RecordSaver')

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
const currentFile = (saver, user) => (user ? saver.perUser[user] : saver.mixed).file.path

// A saver in its own temp cwd with a mixed and a per-user mixer
function setup(t, storageKey = 'fluxer-test-c1') {
  const tmp = useTempCwd()
  const saver = new RecordSaver(channel({ id: 'c1', storageKey, timeZone: 'UTC' }), fakeLogger(), false)
  const mixed = fakeMixer()
  const u1 = fakeMixer()
  t.after(() => {
    mixed.end()
    u1.end()
    tmp.cleanup()
  })
  saver.setRecvMixer(mixed)
  saver.setUserMixers({ u1 })
  saver.startSession()
  const feed = (seconds) => {
    mixed.write(tone(seconds * 1000, { channels: 'left' }))
    u1.write(tone(seconds * 1000, { channels: 'left' }))
  }
  // As Recorder.stop: the mixers end, then the session
  const stop = () => {
    mixed.end()
    u1.end()
    return saver.endSession()
  }
  return { saver, feed, stop }
}

test('rotation writes decodable mixed and per-user files under temp/<storageKey>', { skip }, async (t) => {
  const { saver, feed, stop } = setup(t)
  assert.ok(fs.existsSync('temp/fluxer-test-c1'), 'saver makes temp/<storageKey>')
  feed(30)
  await settled(currentFile(saver))
  // The visible name has one-second resolution: wait so the next segment gets its own
  await sleep(1100)
  const first = await saver.getFilePeriod()
  feed(30)
  await sleep(1100)
  const last = await stop()

  assert.notEqual(first.start, last.start)
  assert.match(first.start, /^\d{4}-\d{2}-\d{2} \d{2}-\d{2}-\d{2}$/)
  assert.equal(first.audioFilePath, `temp/fluxer-test-c1/${first.start}.mp3`)
  assert.equal(first.audioFileName, `${first.start}.mp3`)
  assert.deepEqual(
    first.tags.map((tag) => tag.replace(/\d+/, 'N')),
    ['#DateN', '#TimeN', '#YearN']
  )
  assert.deepEqual(first.perUserFiles, [{ user: 'u1', audioFilePath: `temp/fluxer-test-c1/u1-${first.start}.mp3`, audioFileName: `u1-${first.start}.mp3`, tag: '#Useru1' }])
  assert.ok(Object.isFrozen(first) && Object.isFrozen(first.perUserFiles), 'a handed-over segment cannot be changed')

  assert.ok(peakOf(first.audioFilePath) > 2000, 'first segment has the tone')
  assert.ok(peakOf(first.perUserFiles[0].audioFilePath) > 2000, 'per-user file has the tone')
  // Nothing fed is lost across the cut or at the end
  const total = durationOf(first.audioFilePath) + durationOf(last.audioFilePath)
  assert.ok(total > 59.5 && total < 61, `mixed: ${total.toFixed(2)} s of 60 s`)
})

test('endSession resolves only when the last segment is fully written', { skip }, async (t) => {
  const { feed, stop } = setup(t)
  feed(10)
  const last = await stop()
  const size = fs.statSync(last.audioFilePath).size
  await sleep(500)
  assert.equal(fs.statSync(last.audioFilePath).size, size, 'nothing written after it resolved')
  assert.ok(Math.abs(durationOf(last.audioFilePath) - 10) < 0.5)
})

// FFmpeg reads about 5 s of input before it outputs anything; a shorter session still keeps its audio
test('a 3 s session keeps its audio', { skip }, async (t) => {
  const { feed, stop } = setup(t)
  feed(3)
  const last = await stop()
  assert.ok(Math.abs(durationOf(last.audioFilePath) - 3) < 0.5, `got ${durationOf(last.audioFilePath)} s`)
  assert.ok(peakOf(last.perUserFiles[0].audioFilePath) > 2000)
})

test('a second endSession or a rotation without a session resolves to nothing', { skip }, async (t) => {
  const { saver, stop } = setup(t)
  await stop()
  assert.equal(await saver.endSession(), undefined)
  assert.equal(await saver.getFilePeriod(), undefined)
})

test('two rotations in the same second do not overwrite each other', { skip }, async (t) => {
  const { saver, feed, stop } = setup(t)
  feed(6)
  const [a, b] = await Promise.all([saver.getFilePeriod(), saver.getFilePeriod()])
  const c = await stop()
  const paths = [a, b, c].flatMap((file) => [file.audioFilePath, ...file.perUserFiles.map((f) => f.audioFilePath)])
  assert.equal(new Set(paths).size, paths.length, `distinct files: ${paths.join(', ')}`)
  if (a.start === b.start) assert.equal(b.audioFileName, `${b.start}-2.mp3`)
  assert.ok(paths.every((path) => fs.existsSync(path)))
})

test('a file that cannot be written fails its segment instead of handing it over', { skip }, async (t) => {
  const { saver, feed, stop } = setup(t)
  feed(1)
  await sleep(300) // the first segment's files are open by now
  // The files of the segment the rotation opens cannot be created
  fs.rmSync('temp/fluxer-test-c1', { recursive: true })
  assert.ok(await saver.getFilePeriod(), 'the segment opened before is handed over')
  feed(1)
  await assert.rejects(stop(), { code: 'ENOENT' })
})

// Making a Recorder starts nothing: FFmpeg only runs once a session starts
test('a new Recorder makes its folder and nothing else', { skip }, (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  const children = () => process._getActiveHandles().filter((handle) => handle.constructor.name === 'ChildProcess').length
  const before = children()
  const { Recorder } = require('../dist/Recording/Recorder')
  new Recorder(channel({ storageKey: 'k' }), fakeLogger(), false)
  assert.deepEqual(fs.readdirSync('.'), ['temp'])
  assert.deepEqual(fs.readdirSync('temp'), ['k'])
  assert.equal(children(), before)
})

test('a new RecordSaver keeps the files already in its folder', (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  fs.mkdirSync('temp/k')
  fs.writeFileSync('temp/k/unsent.mp3', 'x')
  new RecordSaver(channel({ storageKey: 'k' }), fakeLogger(), false)
  assert.deepEqual(fs.readdirSync('temp/k'), ['unsent.mp3'])
})

// The encoders this process started
const encoders = () => process._getActiveHandles().filter((handle) => handle.constructor.name === 'ChildProcess' && handle.spawnfile === 'ffmpeg')

// Ctrl+C in a terminal, or pm2 stop/restart, sends SIGINT to FFmpeg as well; it finishes the file and exits 255
test('a session whose encoders got SIGINT still ends with complete files', { skip }, async (t) => {
  const { feed, stop } = setup(t)
  feed(10)
  await sleep(1000)
  for (const encoder of encoders()) encoder.kill('SIGINT')
  const last = await stop()
  assert.ok(durationOf(last.audioFilePath) > 5, `mixed: ${durationOf(last.audioFilePath)} s`)
  assert.ok(durationOf(last.perUserFiles[0].audioFilePath) > 5)
})

test('a session whose encoder was killed outright fails', { skip }, async (t) => {
  const { feed, stop } = setup(t)
  feed(10)
  await sleep(1000)
  for (const encoder of encoders()) encoder.kill('SIGKILL')
  await assert.rejects(stop(), /FFmpeg exited with SIGKILL/)
})

test('an encoder that cannot start fails the session end', { skip }, async (t) => {
  const tmp = useTempCwd()
  const path = process.env.PATH
  process.env.PATH = tmp.dir // no ffmpeg here
  const mixed = fakeMixer()
  t.after(() => {
    process.env.PATH = path
    tmp.cleanup()
  })
  const saver = new RecordSaver(channel({ timeZone: 'UTC' }), fakeLogger(), false)
  saver.setRecvMixer(mixed)
  saver.setUserMixers({})
  process.env.PATH = path
  saver.startSession()
  mixed.end()
  await assert.rejects(saver.endSession(), /ENOENT/)
})
