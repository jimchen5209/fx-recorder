// App/App: importing it (and so every module that uses getApp) reads no config and starts nothing; createApp() does that.
// stopApp() waits for the platforms up to a deadline, then stops Telegram.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { useTempCwd } = require('./helpers')

const { getApp, stopApp } = require('../dist/App/App')

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
