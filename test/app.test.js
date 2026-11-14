// App/App: importing it (and so every module that uses getApp) reads no config and starts nothing; createApp() does that.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { useTempCwd } = require('./helpers')

test('importing App reads no config, and getApp() before createApp() throws', (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  const { getApp } = require('../dist/App/App')
  assert.deepEqual(fs.readdirSync('.'), ['temp'], 'no config.json written')
  assert.throws(() => getApp(), /before createApp/)
})
