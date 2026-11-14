// Timers and joins owned by DiscordVoice and FluxerVoice: stale cleanup survives a pause, a session never runs two send
// timers, and nothing joins again after shutdown. Real constructors, fake clients, mocked timers (Date too, for debounce).
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { stubApp, fakeLogger, useTempCwd, channel } = require('./helpers')

const app = stubApp()
const { DiscordVoice } = require('../dist/Core/Discord/Core/Voice')
const { FluxerVoice } = require('../dist/Core/Fluxer/Voice')

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
const connection = { stopPlaying: () => undefined }
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
  // Older than a day by the time cleanup runs
  await runFor(25 * HOUR, HOUR)
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
