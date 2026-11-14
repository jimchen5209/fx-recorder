// App/App: importing it (and so every module that uses getApp) reads no config and starts nothing; createApp() does that.
// stopApp() waits for the platforms up to a deadline, then stops Telegram.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { useTempCwd } = require('./helpers')

const { getApp, stopApp, keepLeftovers, watchDiskSpace } = require('../dist/App/App')
const { fakeLogger } = require('./helpers')

test('importing App reads no config, and getApp() before createApp() throws', (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  require('../dist/App/App')
  assert.deepEqual(fs.readdirSync('.'), ['temp'], 'no config.json written')
  assert.throws(() => getApp(), /before createApp/)
})

// disconnects: how long each platform takes to stop, in ms
function fakeApp(...disconnects) {
  const app = { telegramStopped: false, telegram: { disconnect: () => (app.telegramStopped = true) }, fluxer: [] }
  const platforms = disconnects.map((ms) => ({ disconnect: () => new Promise((resolve) => setTimeout(resolve, ms)) }))
  app.discord = platforms[0]
  app.fluxer = platforms.slice(1)
  return app
}

test('stopApp: true once every platform has stopped, and Telegram stops after them', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const app = fakeApp(1000, 2000)
  const result = stopApp(app, 60 * 1000)
  t.mock.timers.tick(1000)
  await new Promise(setImmediate)
  assert.equal(app.telegramStopped, false, 'Telegram waits for the platforms')
  t.mock.timers.tick(1000)
  assert.equal(await result, true)
  assert.equal(app.telegramStopped, true)
})

test('stopApp: false when a platform is still stopping at the deadline, and Telegram stops anyway', async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const app = fakeApp(90 * 1000)
  const result = stopApp(app, 60 * 1000)
  t.mock.timers.tick(60 * 1000)
  assert.equal(await result, false)
  assert.equal(app.telegramStopped, true)
})

const DAY = 24 * 60 * 60 * 1000

test('keepLeftovers: an earlier run’s recordings move to temp/kept/<time>/, empty folders go, kept folders over 7 days go', (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  fs.mkdirSync('temp/c1')
  fs.writeFileSync('temp/c1/a.mp3', 'x')
  fs.writeFileSync('temp/c1/u1-a.mp3', 'x')
  fs.mkdirSync('temp/fluxer-official-c2')
  fs.mkdirSync('temp/kept/old', { recursive: true })
  fs.mkdirSync('temp/kept/recent')
  const old = new Date(Date.now() - 8 * DAY)
  fs.utimesSync('temp/kept/old', old, old)

  const now = Date.parse('2026-11-14T13:00:00.000Z')
  const { dir, files } = keepLeftovers('temp', now)
  assert.equal(dir, 'temp/kept/2026-11-14T13-00-00-000Z')
  assert.deepEqual(files.sort(), ['c1/a.mp3', 'c1/u1-a.mp3'])
  assert.deepEqual(fs.readdirSync(`${dir}/c1`).sort(), ['a.mp3', 'u1-a.mp3'])
  assert.deepEqual(fs.readdirSync('temp').sort(), ['kept'], 'channel folders moved or, when empty, removed')
  assert.ok(!fs.existsSync('temp/kept/old'), 'over 7 days')
  assert.ok(fs.existsSync('temp/kept/recent'))
})

// The real free space of the test machine's disk; minFreeBytes decides whether it counts as low
test('watchDiskSpace: tells once while the disk stays low, again after it came back', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const notified = []
  const watch = { path: '.', minFreeBytes: Number.POSITIVE_INFINITY, everyMs: 1000 }
  const timer = watchDiskSpace(fakeLogger(), (message) => notified.push(message), watch)
  t.after(() => clearInterval(timer))
  assert.equal(notified.length, 0, 'the first check is after everyMs')
  t.mock.timers.tick(1000)
  t.mock.timers.tick(1000)
  assert.equal(notified.length, 1)
  assert.match(notified[0], /GiB of disk space left for recordings in \./)
  watch.minFreeBytes = 0
  t.mock.timers.tick(1000)
  watch.minFreeBytes = Number.POSITIVE_INFINITY
  t.mock.timers.tick(1000)
  assert.equal(notified.length, 2)
})

test('watchDiskSpace: enough space tells nobody; a path it cannot check is logged', (t) => {
  t.mock.timers.enable({ apis: ['setInterval'] })
  const notified = []
  const records = []
  const enough = watchDiskSpace(fakeLogger(), (message) => notified.push(message), { path: '.', minFreeBytes: 0, everyMs: 1000 })
  const missing = watchDiskSpace(fakeLogger(records), (message) => notified.push(message), { path: '/no/such/dir', minFreeBytes: 0, everyMs: 1000 })
  t.after(() => {
    clearInterval(enough)
    clearInterval(missing)
  })
  t.mock.timers.tick(1000)
  assert.deepEqual(notified, [])
  assert.equal(records.filter(([level]) => level === 'warn').length, 1)
})

test('keepLeftovers: nothing left makes no kept folder, and a missing temp/ is made', (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  fs.rmSync('temp', { recursive: true })
  assert.deepEqual(keepLeftovers('temp').files, [])
  assert.deepEqual(fs.readdirSync('temp/kept'), [])
})
