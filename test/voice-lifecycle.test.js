// Timers and joins owned by DiscordVoice and FluxerVoice: stale cleanup survives a pause, a session never runs two send
// timers, and nothing joins again after shutdown. Real constructors, fake clients, mocked timers (Date too, for debounce).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { stubApp, fakeLogger, useTempCwd, channel } = require('./helpers')

const app = stubApp()
const { DiscordVoice } = require('../dist/Discord/VoiceConnection')
const { FluxerVoice } = require('../dist/Fluxer/VoiceConnection')

const config = channel({ guildId: 'g1', sendIntervalSecond: 60, fileDest: [] })
const HOUR = 60 * 60 * 1000

let tmp
test.beforeEach(() => {
  tmp = useTempCwd()
  app.telegram = { sendMessage: async () => undefined, sendFile: async () => undefined }
  // From the real time, so file mtimes and Date.now agree
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

// members: who the client sees in the channel; joins counts joinVoiceChannel calls
function fakeDiscord(members = []) {
  const client = {
    joins: 0,
    user: { id: 'bot', username: 'bot' },
    getChannel: () => ({ voiceMembers: members.map((id) => ({ id })), guild: { editMember: async () => undefined } }),
    voiceConnections: { find: () => undefined },
    joinVoiceChannel: async () => {
      client.joins++
      throw new Error('no voice in tests')
    },
    leaveVoiceChannel: () => undefined
  }
  return client
}
const connection = { stopPlaying: () => undefined, off: () => undefined, receive: () => ({ off: () => undefined }) }
const fakeRecorder = () => {
  const recorder = { periods: 0, startStream: () => undefined, saver: { getFilePeriod: async () => (recorder.periods++, undefined) }, stop: async () => undefined }
  return recorder
}
// stop() waits on mocked timers, so time has to move while it runs
async function stopVoice(voice) {
  const stopped = voice.stop()
  await runFor(1000)
  await stopped
}
const discordVoice = (client) => {
  const voice = new DiscordVoice(client, config, fakeLogger())
  voice.recording.recorder = fakeRecorder()
  return voice
}

test('DiscordVoice: stale cleanup goes on after the channel empties (a pause)', async () => {
  const voice = discordVoice(fakeDiscord())
  fs.writeFileSync('temp/chan1/old.mp3', 'x')
  voice.stopSession('chan1', connection)
  // Older than 7 days by the time cleanup runs
  await runFor(8 * 24 * HOUR, HOUR)
  assert.ok(!fs.existsSync('temp/chan1/old.mp3'), 'stale file removed after the pause')
  await stopVoice(voice)
})

test('DiscordVoice: starting the send timer again replaces it instead of adding a second one', async () => {
  const voice = discordVoice(fakeDiscord())
  voice.recording.start()
  voice.recording.start()
  await runFor(60 * 1000)
  assert.equal(voice.recording.recorder.periods, 1)
  clearInterval(voice.recording.sendInterval)
  await stopVoice(voice)
})

test('DiscordVoice: a join pending when shutdown starts does not happen', async () => {
  const client = fakeDiscord(['u1'])
  const voice = discordVoice(client)
  // The constructor's own check is debounced; shut down before it runs
  const stopped = voice.stop()
  await runFor(2000)
  await stopped
  assert.equal(client.joins, 0)
})

test('DiscordVoice: a reconnect scheduled before shutdown does not join again', async () => {
  const client = fakeDiscord(['u1'])
  const voice = discordVoice(client)
  await runFor(1000)
  const joinsBefore = client.joins
  voice.tryReconnect('chan1', connection)
  // The debounced reconnect has run and its 5 s rejoin timer is pending
  await runFor(1000)
  const stopped = voice.stop()
  await runFor(10 * 1000)
  await stopped
  assert.equal(client.joins, joinsBefore)
})

// A telegram sink whose uploads wait until released
function slowTelegram() {
  const sink = { uploads: 0, sendMessage: async () => undefined }
  sink.done = new Promise((resolve) => {
    sink.release = resolve
  })
  sink.sendFile = async () => {
    sink.uploads++
    await sink.done
  }
  app.telegram = sink
  return sink
}
const segment = { start: 'S', end: 'E', tags: [], audioFilePath: 'temp/S.mp3', audioFileName: 'S.mp3', perUserFiles: [] }
const sending = channel({ guildId: 'g1', sendIntervalSecond: 60, fileDest: [{ type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }] })
// Settles to true once the promise has resolved
const watch = (promise) => {
  const state = { done: false }
  promise.then(() => {
    state.done = true
  })
  return state
}

test('DiscordVoice: shutdown waits for a segment still being sent, also when the channel is paused', async () => {
  const telegram = slowTelegram()
  const voice = new DiscordVoice(fakeDiscord(), sending, fakeLogger())
  voice.recording.recorder = { startStream: () => undefined, saver: { getFilePeriod: async () => segment }, stop: async () => undefined }
  voice.recording.start()
  await runFor(60 * 1000)
  clearInterval(voice.recording.sendInterval)
  assert.equal(telegram.uploads, 1)

  const stopped = watch(voice.stop())
  await runFor(10 * 1000)
  assert.equal(stopped.done, false, 'still waiting for the upload')
  telegram.release()
  await runFor(0)
  assert.equal(stopped.done, true)
})

test('DiscordVoice: stopping twice sends the rest once', async () => {
  const telegram = slowTelegram()
  telegram.release()
  const client = fakeDiscord()
  client.voiceConnections = { find: () => connection }
  const voice = new DiscordVoice(client, sending, fakeLogger())
  let stops = 0
  voice.recording.recorder = { stop: async () => (stops++ === 0 ? segment : undefined) }
  const first = voice.stop()
  const second = voice.stop()
  await runFor(1000)
  await Promise.all([first, second])
  assert.equal(stops, 2)
  assert.equal(telegram.uploads, 1)
})

test('FluxerVoice: shutdown waits for the rest of the recording that the leave starts sending', async () => {
  const telegram = slowTelegram()
  const { EventEmitter } = require('node:events')
  const conn = new EventEmitter()
  conn.leave = () => conn.emit('closed', 'left')
  const voice = new FluxerVoice('official', sending, { join: () => conn }, { usersIn: () => ['u1'] }, () => 'bot', async () => undefined, fakeLogger())
  voice.recording.recorder = { startStream: () => undefined, saver: {}, stop: async () => segment }
  voice.join()
  voice.startRecording()

  const stopped = watch(voice.stop())
  await runFor(1000)
  assert.equal(telegram.uploads, 1)
  assert.equal(stopped.done, false, 'still waiting for the upload')
  telegram.release()
  await runFor(0)
  assert.equal(stopped.done, true)
})

// A voice connection Dysnomia would hand out: an emitter with one cached PCM receiver
function fakeConnection() {
  const { EventEmitter } = require('node:events')
  const conn = new EventEmitter()
  const pcm = new EventEmitter()
  Object.assign(conn, { pcm, receive: () => pcm, play: () => undefined, stopPlaying: () => undefined })
  return conn
}

test('DiscordVoice: member events while a join is running start no second join', async () => {
  const conn = fakeConnection()
  const client = fakeDiscord(['u1'])
  // The join takes 3 s, as a slow voice server
  client.joinVoiceChannel = () => {
    client.joins++
    return new Promise((resolve) => setTimeout(() => resolve(conn), 3000))
  }
  const voice = discordVoice(client)
  await runFor(1000) // the constructor's check starts the join
  voice.handleUserConnect()
  await runFor(1000)
  voice.handleUserConnect()
  await runFor(3000)
  assert.equal(client.joins, 1)
  assert.equal(conn.pcm.listenerCount('data'), 1)
  await stopVoice(voice)
})

test('DiscordVoice: starting twice on one connection records each packet once, and the receiver comes off with the session', async () => {
  const conn = fakeConnection()
  const voice = discordVoice(fakeDiscord())
  const stored = []
  let starts = 0
  voice.recording.recorder = { startStream: () => starts++, storeBuffer: (data, user) => stored.push(user), stop: async () => undefined }
  voice.startRecording(conn)
  voice.startRecording(conn)
  conn.pcm.emit('data', Buffer.alloc(3840), 'u1')
  assert.deepEqual(stored, ['u1'])
  assert.equal(starts, 1)
  assert.equal(conn.listenerCount('userDisconnect'), 1)

  voice.stopSession('chan1', conn)
  assert.equal(conn.pcm.listenerCount('data'), 0)
  assert.equal(conn.listenerCount('userDisconnect'), 0)
  voice.startRecording(conn)
  assert.equal(conn.pcm.listenerCount('data'), 1, 'a new session on the same connection gets one receiver')
  await stopVoice(voice)
})

// A Discord channel with `members` in it whose joins hand out one connection (failing `failures` times first);
// messages and admin messages to Telegram are noted
function discordChannel({ members = ['u1'], failures = 0 } = {}) {
  const messages = []
  const admin = []
  app.telegram = { sendFile: async () => undefined, sendMessage: async (id, text) => (id === 'admin' ? admin : messages).push(text) }
  app.config.telegram = { ...app.config.telegram, logErrorsToAdmin: true, admins: ['admin'] }
  const conn = fakeConnection()
  const client = fakeDiscord(members)
  let joined = false
  client.joinVoiceChannel = async () => {
    client.joins++
    if (failures-- > 0) throw new Error('no voice')
    joined = true
    return conn
  }
  client.voiceConnections = { find: () => (joined ? conn : undefined) }
  client.leaveVoiceChannel = () => {
    joined = false
  }
  const voice = new DiscordVoice(client, sending, fakeLogger())
  const calls = []
  voice.recording.recorder = {
    startStream: () => calls.push('startStream'),
    stop: async () => (calls.push('stop'), undefined),
    endStream: (user) => calls.push(['endStream', user]),
    storeBuffer: () => undefined,
    saver: { getFilePeriod: async () => undefined }
  }
  return { voice, client, conn, calls, messages, admin, members, joined: () => joined }
}

test('DiscordVoice: a join failing 5 times gives up and says so; the next member event tries again', async () => {
  const { voice, client, messages } = discordChannel({ failures: 10 })
  await runFor(1000)
  assert.equal(client.joins, 5)
  assert.ok(messages.includes('[chan1] Connecting to voice channel failed after retrying 5 times. Channel recording aborted.'))
  assert.ok(!voice.active)
  voice.handleUserConnect()
  await runFor(1000)
  assert.equal(client.joins, 10)
  await stopVoice(voice)
})

test('DiscordVoice: a lost voice connection while recording sends the rest and joins again 5 s later', async () => {
  const { voice, client, conn, calls, messages, admin, joined } = discordChannel()
  await runFor(1000)
  assert.ok(voice.active)
  assert.deepEqual(calls, ['startStream'])
  conn.emit('disconnect', new Error('gone'))
  await runFor(1000)
  assert.deepEqual(calls, ['startStream', 'stop'])
  assert.ok(!joined())
  assert.ok(messages.includes('[chan1] There is an error with the voice connection.'))
  assert.ok(admin.some((message) => /Error from voice connection chan1: gone/.test(message)))
  await runFor(5000)
  assert.equal(client.joins, 2)
  assert.deepEqual(calls, ['startStream', 'stop', 'startStream'])
  await stopVoice(voice)
})

test('DiscordVoice: the channel emptying pauses: the user’s file ends, the session ends, and the bot leaves', async () => {
  const { voice, members, calls, messages, admin, joined } = discordChannel()
  await runFor(1000)
  members.length = 0
  voice.handleUserDisconnect('u1')
  await runFor(1000)
  assert.deepEqual(calls, ['startStream', ['endStream', 'u1'], 'stop'])
  assert.ok(!voice.active)
  assert.ok(!joined())
  assert.ok(messages.includes('[chan1] No user in the channel, pausing...'))
  assert.ok(admin.includes('No user in chan1, recorder pausing...'))
  await stopVoice(voice)
})

test('DiscordVoice: 5 voice errors within a second reconnect; errors and warnings reach admins in one message each', async () => {
  const { voice, client, conn, calls, admin } = discordChannel()
  await runFor(1000)
  conn.emit('warn', 'shaky')
  for (let i = 0; i < 5; i++) conn.emit('error', new Error(`e${i}`))
  await runFor(1000)
  assert.ok(admin.some((message) => /^1 warning from chan1 in 1 seconds:\n```\nshaky\n```$/.test(message)))
  assert.ok(admin.some((message) => /^5 errors from chan1/.test(message)))
  assert.ok(admin.includes('Error count exceeded 5. Reconnecting...'))
  assert.deepEqual(calls, ['startStream', 'stop'])
  await runFor(5000)
  assert.equal(client.joins, 2)
  await stopVoice(voice)
})

test('DiscordVoice: 5 reconnects less than a second apart reconnect the whole Discord client, once', async (t) => {
  const { voice, conn } = discordChannel()
  let reconnects = 0
  app.discord = { reconnect: () => reconnects++ }
  t.after(() => {
    app.discord = undefined
  })
  await runFor(1000)
  for (let i = 0; i < 5; i++) {
    voice.tryReconnect('chan1', conn)
    await runFor(600, 600)
  }
  assert.equal(reconnects, 1)
  await stopVoice(voice)
})

test('FluxerVoice: an update after shutdown does not join', async () => {
  let joins = 0
  const manager = { join: () => joins++ }
  const tracker = { usersIn: () => ['u1'] }
  const voice = new FluxerVoice('official', config, manager, tracker, () => 'bot', async () => undefined, fakeLogger())
  await voice.stop()
  voice.update()
  await runFor(2000)
  assert.equal(joins, 0)
})
