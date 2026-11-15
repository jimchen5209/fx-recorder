// FluxerVoice with a fake LiveKitSession: a grant opens the room and starts recording, a lost session is reconnected
// with backoff while the recording goes on, giving up after 6 attempts leaves, a new voice server reconnects at once,
// tracks become receivers or sources that end, and joining or leaving follows who is in the channel.
const test = require('node:test')
const assert = require('node:assert/strict')
const { EventEmitter } = require('node:events')
const { stubApp, stubModule, fakeLogger, useTempCwd, channel } = require('./helpers')

stubApp()
class FakeSession extends EventEmitter {
  static made = []
  // How many of the next open() calls fail
  static failures = 0
  constructor(endpoint, token) {
    super()
    Object.assign(this, { endpoint, token, lost: false, closed: false })
    FakeSession.made.push(this)
  }
  async open() {
    if (FakeSession.failures > 0) {
      FakeSession.failures--
      throw new Error('refused')
    }
  }
  close() {
    this.closed = true
  }
}
stubModule('Fluxer/Voice/LiveKitSession.js', { LiveKitSession: FakeSession })
const { FluxerVoice } = require('../dist/Fluxer/VoiceConnection')

const flush = async () => {
  for (let i = 0; i < 10; i++) await Promise.resolve()
}
async function runFor(t, ms, step = 1000) {
  for (let elapsed = 0; elapsed < ms; elapsed += step) {
    await flush()
    t.mock.timers.tick(step)
  }
  await flush()
}

// A voice in a channel where users() are present; conn is the gateway connection it gets on joining
function setup(t, users = () => ['u1']) {
  const tmp = useTempCwd()
  // Date too: lodash's debounce reads it
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  t.after(() => {
    t.mock.timers.reset()
    tmp.cleanup()
  })
  FakeSession.made = []
  FakeSession.failures = 0
  const conn = new EventEmitter()
  conn.connectionId = 'conn'
  let joins = 0
  conn.leave = () => conn.emit('closed', 'left')
  const admin = []
  const records = []
  const voice = new FluxerVoice('official', channel({ guildId: 'g1', ignoreUsers: ['ignored'] }), { join: () => (joins++, conn) }, { usersIn: users }, () => 'bot', async (m) => admin.push(m), fakeLogger(records))
  const calls = []
  voice.recording.recorder = {
    startStream: () => calls.push('startStream'),
    stop: async () => (calls.push('stop'), undefined),
    endSource: (user, source) => calls.push(['endSource', user, source]),
    saver: { getFilePeriod: async () => undefined }
  }
  return { voice, conn, admin, records, calls, joins: () => joins }
}
const grant = (conn, endpoint = 'voice.example', token = 't1') => conn.emit('grant', { endpoint, token, connectionId: 'conn', encrypted: false })

async function recording(t) {
  const s = setup(t)
  s.voice.update()
  await runFor(t, 1000)
  grant(s.conn)
  await flush()
  return s
}

test('someone in the channel: joins; the first grant opens the room and starts recording', async (t) => {
  const { voice, calls, joins } = await recording(t)
  assert.equal(joins(), 1)
  assert.equal(FakeSession.made.length, 1)
  assert.equal(FakeSession.made[0].token, 't1')
  assert.ok(voice.active)
  assert.deepEqual(calls, ['startStream'])
})

test('a token refresh grant for the same voice server keeps the room', async (t) => {
  const { conn } = await recording(t)
  grant(conn, 'voice.example', 't2')
  await flush()
  assert.equal(FakeSession.made.length, 1)
})

test('a lost room is reconnected after 1 s with the latest token, and the recording goes on', async (t) => {
  const { voice, conn, calls } = await recording(t)
  grant(conn, 'voice.example', 't2')
  FakeSession.made[0].emit('lost', false, 'socket closed')
  assert.ok(FakeSession.made[0].closed)
  await runFor(t, 999, 999)
  assert.equal(FakeSession.made.length, 1, 'waits first')
  await runFor(t, 1, 1)
  assert.equal(FakeSession.made.length, 2)
  assert.equal(FakeSession.made[1].token, 't2')
  assert.ok(voice.active)
  assert.ok(!calls.includes('stop'), 'not stopped while reconnecting')
})

test('reconnecting gives up after 6 attempts, tells admins and leaves, which ends the recording', async (t) => {
  const { voice, conn, admin, calls } = await recording(t)
  const closed = []
  conn.on('closed', (why) => closed.push(why))
  FakeSession.failures = 6
  FakeSession.made[0].emit('lost', false, 'socket closed')
  await runFor(t, 120 * 1000)
  assert.equal(FakeSession.made.length, 7, 'the first room and six attempts')
  assert.match(admin.at(-1), /Reconnecting .* to the voice server failed, recorder stopping/)
  assert.deepEqual(closed, ['left'])
  assert.ok(!voice.active)
  assert.ok(calls.includes('stop'))
})

test('a fatal loss (removed by the server) leaves at once', async (t) => {
  const { voice, conn } = await recording(t)
  const closed = []
  conn.on('closed', (why) => closed.push(why))
  FakeSession.made[0].emit('lost', true, 'server leave')
  await flush()
  assert.deepEqual(closed, ['left'])
  assert.equal(FakeSession.made.length, 1)
  assert.ok(!voice.active)
})

test('a grant for a new voice server reconnects at once', async (t) => {
  const { conn } = await recording(t)
  grant(conn, 'other.example', 't2')
  await flush()
  assert.equal(FakeSession.made.length, 2)
  assert.equal(FakeSession.made[1].endpoint, 'other.example')
  assert.ok(FakeSession.made[0].closed)
})

test('the connection ending while the room opens closes that room and records nothing', async (t) => {
  const s = setup(t)
  s.voice.update()
  await runFor(t, 1000)
  let finishOpen
  const open = FakeSession.prototype.open
  FakeSession.prototype.open = () =>
    new Promise((resolve) => {
      finishOpen = resolve
    })
  t.after(() => {
    FakeSession.prototype.open = open
  })
  grant(s.conn)
  s.conn.emit('closed', 'left')
  finishOpen()
  await flush()
  assert.ok(FakeSession.made[0].closed)
  assert.ok(!s.voice.active)
  assert.deepEqual(s.calls, [])
})

test('a microphone track that ends ends its source: <user>-<connection>, <connection>:<track>', async (t) => {
  const { calls } = await recording(t)
  const session = FakeSession.made[0]
  session.emit('trackEnded', { userId: 'u1', connectionId: 'c1', trackSid: 'TR1', source: 'MICROPHONE' })
  session.emit('trackEnded', { userId: 'u1', connectionId: 'c1', trackSid: 'TR2', source: 'SCREEN_SHARE_AUDIO' })
  assert.deepEqual(calls.slice(1), [['endSource', 'u1-c1', 'c1:TR1']])
})

test('tracks: one nobody can be named for is left out and logged, an ignored user is skipped, others get a receiver', async (t) => {
  let OpusEncoder
  try {
    ;({ OpusEncoder } = require('@discordjs/opus'))
  } catch {
    return t.skip('@discordjs/opus not installed')
  }
  assert.ok(OpusEncoder)
  const { records } = await recording(t)
  const session = FakeSession.made[0]
  const subscribed = []
  const track = (name) => ({ ssrc: 1, onReceiveRtp: { subscribe: () => subscribed.push(name) } })
  session.emit('track', track('unknown'), undefined)
  session.emit('track', track('ignored'), { userId: 'ignored', connectionId: 'c', trackSid: 'T' })
  session.emit('track', track('u1'), { userId: 'u1', connectionId: 'c1', trackSid: 'TR1', source: 'MICROPHONE' })
  assert.deepEqual(subscribed, ['u1'])
  assert.ok(records.some(([level, message]) => level === 'warn' && /could not be matched to a user \(ssrc 1\)/.test(message)))
})

test('the channel emptying leaves; an unknown guild (no snapshot yet) changes nothing', async (t) => {
  let present = ['u1']
  const s = setup(t, () => present)
  s.voice.update()
  await runFor(t, 1000)
  grant(s.conn)
  await flush()
  const closed = []
  s.conn.on('closed', (why) => closed.push(why))
  present = undefined
  s.voice.update()
  await runFor(t, 1000)
  assert.deepEqual(closed, [])
  present = ['bot', 'ignored']
  s.voice.update()
  await runFor(t, 1000)
  assert.deepEqual(closed, ['left'])
  assert.ok(!s.voice.active)
})
