// RecordingSession: the recording lifecycle both voice connections share. A segment every sendIntervalSecond and the
// rest at the end, each handed to delivery, messages, stale cleanup (7 days) until close, and close waiting for the
// work in flight. The Recorder is faked; timers are mocked.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { fakeLogger, useTempCwd, channel } = require('./helpers')

const { RecordingSession } = require('../dist/Recording/RecordingSession')

const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
let tmp
test.beforeEach(() => {
  tmp = useTempCwd()
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'], now: Date.now() })
})
test.afterEach(() => {
  test.mock.timers.reset()
  tmp.cleanup()
})

async function runFor(ms, step = 1000) {
  for (let t = 0; t < ms; t += step) {
    await new Promise(setImmediate)
    test.mock.timers.tick(step)
  }
  await new Promise(setImmediate)
}

// calls: what the session asked for, in order; segments: what the fake recorder hands out, in order
function setup({ deliver } = {}) {
  const calls = []
  let n = 0
  const session = new RecordingSession(channel({ storageKey: 'k', sendIntervalSecond: 60 }), {
    mainLogger: fakeLogger(),
    logger: fakeLogger(),
    debug: false,
    deliver: deliver ?? (async (file) => calls.push(['deliver', file.start])),
    announce: async (message) => calls.push(['announce', message])
  })
  let stopped = false
  session.recorder = {
    startStream: () => calls.push(['startStream']),
    saver: { getFilePeriod: async () => ({ start: `seg${++n}` }) },
    // A second stop has no session left, as the real Recorder
    stop: async () => (stopped ? undefined : ((stopped = true), { start: 'rest' }))
  }
  return { session, calls }
}

test('a session: started, a segment a minute, the rest at the end, with its messages', async () => {
  const { session, calls } = setup()
  session.start()
  await runFor(120 * 1000)
  session.stop()
  await session.close()
  assert.deepEqual(calls, [
    ['startStream'],
    ['announce', 'Record session started'],
    ['deliver', 'seg1'],
    ['deliver', 'seg2'],
    ['deliver', 'rest'],
    ['announce', 'The record session has ended.']
  ])
})

test('starting again while running does nothing; stopping twice sends the rest once', async () => {
  const { session, calls } = setup()
  session.start()
  session.start()
  assert.equal(calls.filter(([kind]) => kind === 'startStream').length, 1, 'the mixers are not replaced')
  assert.equal(calls.filter(([kind, message]) => kind === 'announce' && message === 'Record session started').length, 1)
  await runFor(60 * 1000)
  session.stop()
  session.stop()
  await session.close()
  assert.equal(calls.filter(([kind, start]) => kind === 'deliver' && start.startsWith('seg')).length, 1)
  assert.equal(calls.filter(([kind, start]) => kind === 'deliver' && start === 'rest').length, 1)
  await runFor(120 * 1000)
  assert.equal(calls.filter(([kind]) => kind === 'deliver').length, 2, 'no segment after stop')
})

test('close waits for a segment still being sent, and a failed one does not reject it', async () => {
  let release
  const { session } = setup({
    deliver: (file) =>
      file.start === 'rest'
        ? Promise.reject(new Error('down'))
        : new Promise((resolve) => {
            release = resolve
          })
  })
  session.start()
  await runFor(60 * 1000)
  session.stop()
  let closed = false
  session.close().then(() => {
    closed = true
  })
  await runFor(1000)
  assert.equal(closed, false, 'the first segment is still being sent')
  release()
  await runFor(0)
  assert.equal(closed, true)
})

test('stale cleanup removes recordings older than 7 days, runs while stopped, and ends with close', async () => {
  const { session } = setup()
  fs.writeFileSync('temp/k/old.mp3', 'x')
  session.stop()
  await runFor(6 * DAY, HOUR)
  assert.ok(fs.existsSync('temp/k/old.mp3'), 'kept for 7 days')
  await runFor(2 * DAY, HOUR)
  assert.ok(!fs.existsSync('temp/k/old.mp3'))
  await session.close()
  fs.writeFileSync('temp/k/later.mp3', 'x')
  await runFor(8 * DAY, HOUR)
  assert.ok(fs.existsSync('temp/k/later.mp3'), 'no cleanup after close')
})
