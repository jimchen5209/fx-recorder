// PCM baseline of the mixdown (Libs/LicsonMixer), native and JS backends each, sample by sample (_mixin called
// directly), and the real-time loop with mocked timers and Date: a frame every 50 ms, sources merged and removed.
const test = require('node:test')
const assert = require('node:assert/strict')
const Module = require('node:module')
const path = require('node:path')
const { dist, tone } = require('./helpers')

const mixerPath = path.join(dist, 'Libs', 'LicsonMixer', 'mixer.js')

function loadMixer({ native }) {
  delete require.cache[mixerPath]
  const original = Module.prototype.require
  const log = console.log
  const warn = console.warn
  console.log = console.warn = () => undefined
  if (!native) {
    Module.prototype.require = function (id) {
      if (id.endsWith('mix.node')) throw new Error('native backend disabled for this test')
      return original.apply(this, arguments)
    }
  }
  try {
    return require(mixerPath)
  } finally {
    Module.prototype.require = original
    console.log = log
    console.warn = warn
    delete require.cache[mixerPath]
  }
}

const backends = { js: loadMixer({ native: false }) }
try {
  backends.native = loadMixer({ native: true })
  if (backends.native.prototype._mixin === backends.js.prototype._mixin) delete backends.native
} catch {
  // native addon not built
}
const nativeLoaded = backends.native && backends.native.prototype._mixin.toString().includes('[native code]')

const source = () => ({ volume: 1, transitionLength: -1 })
const samples = (buf) => Array.from({ length: buf.length / 2 }, (_, i) => buf.readInt16LE(i * 2))

for (const [name, Mixer] of Object.entries(backends)) {
  const mix = (buffers) => Mixer.prototype._mixin.call(new Mixer(16, 2, 48000), buffers, buffers.map(source), buffers[0].length, 16, 2)

  test(`${name}: one source passes through unchanged`, () => {
    const a = tone(20)
    // Max 32767 vs Int16 -32768 bound: off by at most one
    samples(mix([a])).forEach((v, i) => assert.ok(Math.abs(v - samples(a)[i]) <= 1, `sample ${i}`))
  })

  test(`${name}: silence stays silence`, () => {
    assert.ok(samples(mix([Buffer.alloc(3840), Buffer.alloc(3840)])).every((v) => v === 0))
  })

  test(`${name}: left and right stay on their own channel`, () => {
    const out = samples(mix([tone(20, { channels: 'left' }), tone(20, { channels: 'right', freq: 660 })]))
    const left = out.filter((_, i) => i % 2 === 0)
    const right = out.filter((_, i) => i % 2 === 1)
    assert.ok(left.some((v) => v !== 0) && right.some((v) => v !== 0))
    samples(tone(20, { channels: 'left' }))
      .filter((_, i) => i % 2 === 0)
      .forEach((v, i) => assert.ok(Math.abs(left[i] - v) <= 1))
  })

  test(`${name}: two overlapping sources follow (1-|ab|)(a+b) and clip`, () => {
    const a = tone(20, { amp: 20000 })
    const b = tone(20, { amp: 20000, freq: 660 })
    const out = samples(mix([a, b]))
    const sa = samples(a)
    const sb = samples(b)
    out.forEach((v, i) => {
      const x = sa[i] / 32767
      const y = sb[i] / 32767
      const expected = Math.max(-1, Math.min(1, (1 - Math.abs(x * y)) * (x + y))) * 32767
      assert.ok(Math.abs(v - expected) <= 2, `sample ${i}: ${v} vs ${expected}`)
    })
  })

  test(`${name}: a short chunk (one stereo frame)`, () => {
    assert.equal(mix([Buffer.from([0x10, 0x00, 0xf0, 0xff])]).length, 4)
  })
}

test('native backend matches the JS backend within one step', { skip: !nativeLoaded && 'native mix.node not built' }, () => {
  const buffers = [tone(20, { amp: 20000 }), tone(20, { amp: 15000, freq: 660, channels: 'left' })]
  const run = (Mixer) => samples(Mixer.prototype._mixin.call(new Mixer(16, 2, 48000), buffers, buffers.map(source), 3840, 16, 2))
  const js = run(backends.js)
  run(backends.native).forEach((v, i) => assert.ok(Math.abs(v - js[i]) <= 1, `sample ${i}`))
})

const AbortStream = require(path.join(dist, 'Libs', 'abort.js'))
const FRAME = 9600 // 50 ms of 48 kHz stereo s16le

// A running JS-backend mixer; frames are what it pushed, each 50 ms of mocked time
function running(t) {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const log = console.log
  console.log = () => undefined // the mixer logs every track
  const mixer = new backends.js(16, 2, 48000)
  const frames = []
  mixer.on('data', (frame) => frames.push(frame))
  t.after(() => {
    mixer.stop()
    console.log = log
  })
  const tick = async (ms) => {
    for (let elapsed = 0; elapsed < ms; elapsed += 50) {
      await new Promise(setImmediate)
      t.mock.timers.tick(50)
    }
    await new Promise(setImmediate)
  }
  return { mixer, frames, tick }
}
const loud = (frame) => samples(frame).some((v) => Math.abs(v) > 1000)

test('loop: with no source, one silent 50 ms frame every 50 ms', async (t) => {
  const { frames, tick } = running(t)
  await tick(500)
  assert.ok(frames.length >= 10 && frames.length <= 12, `${frames.length} frames`)
  assert.ok(frames.every((frame) => frame.length === FRAME && !loud(frame)))
})

test('loop: a source’s audio comes out in order, and the source goes once it ended and drained', async (t) => {
  const { mixer, frames, tick } = running(t)
  await tick(100)
  const removed = []
  mixer.on('remove_track', () => removed.push(1))
  const stream = new AbortStream(64 * 1000 * 8, 64 * 1000 * 4)
  mixer.addSource(stream, 'u1')
  const before = frames.length
  stream.write(tone(500, { amp: 20000 }))
  stream.end()
  await tick(1500)
  const out = frames.slice(before)
  const first = out.findIndex(loud)
  assert.ok(first >= 0, 'the audio comes out')
  assert.equal(out.filter(loud).length, 10, '500 ms of audio, ten frames')
  assert.ok(out.slice(first, first + 10).every(loud), 'in one piece')
  assert.equal(mixer.count(), 0)
  assert.equal(removed.length, 1)
})

test('loop: stop ends the stream and pushes nothing more', async (t) => {
  const { mixer, frames, tick } = running(t)
  await tick(200)
  let ended = false
  mixer.on('end', () => {
    ended = true
  })
  mixer.stop()
  const count = frames.length
  await tick(500)
  assert.ok(ended)
  assert.equal(frames.length, count)
})

// The loop reads 0.4 s at once, and a stream that is not ended returns null for a read bigger than what it holds, so
// the last < 0.4 s of a speaker's audio used to wait in the source until they spoke again
test('loop: an utterance shorter than the 0.4 s cushion comes out whole once the speaker stops', async (t) => {
  const { mixer, frames, tick } = running(t)
  const stream = new AbortStream(64 * 1000 * 8, 64 * 1000 * 4)
  mixer.addSource(stream, 'u1')
  const before = frames.length
  stream.write(tone(100, { amp: 20000 }))
  await tick(100)
  assert.equal(frames.slice(before).filter(loud).length, 0, 'not while a late packet may still come')
  await tick(200)
  assert.equal(frames.slice(before).filter(loud).length, 2, '100 ms: two frames')
  assert.equal(mixer.count(), 1, 'the source stays for more')
})

test('loop: speech in 20 ms packets with pauses comes out whole, nothing left behind', async (t) => {
  const { mixer, frames, tick } = running(t)
  const stream = new AbortStream(64 * 1000 * 8, 64 * 1000 * 4)
  mixer.addSource(stream, 'u1')
  const before = frames.length
  for (let i = 0; i < 15; i++) {
    stream.write(tone(20, { amp: 20000 }))
    if (i % 5 === 4) await tick(100)
  }
  await tick(500)
  assert.equal(frames.slice(before).filter(loud).length, 6, '300 ms of packets: six frames')
})
