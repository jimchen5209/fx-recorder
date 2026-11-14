// PCM baseline of the mixdown (Libs/LicsonMixer), native and JS backends each, sample by sample.
// _mixin is called directly: the mixer loop paces itself on Date.now and is not tested here.
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
