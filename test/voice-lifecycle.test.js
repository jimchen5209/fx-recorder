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
  const recorder = { periods: 0, saver: { getFilePeriod: async () => (recorder.periods++, undefined) }, stop: async () => undefined }
  return recorder
}
// stop() waits on mocked timers, so time has to move while it runs
async function stopVoice(voice) {
  const stopped = voice.stop(connection)
  await runFor(1000)
  await stopped
}
const discordVoice = (client) => {
  const voice = new DiscordVoice(client, config, fakeLogger())
  voice.recorder = fakeRecorder()
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
  voice.startSendRecord()
  voice.startSendRecord()
  await runFor(60 * 1000)
  assert.equal(voice.recorder.periods, 1)
  clearInterval(voice.sendInterval)
  await stopVoice(voice)
})

test('DiscordVoice: a join pending when shutdown starts does not happen', async () => {
  const client = fakeDiscord(['u1'])
  const voice = discordVoice(client)
  // The constructor's own check is debounced; shut down before it runs
  const stopped = voice.stop(connection)
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
  const stopped = voice.stop(connection)
  await runFor(10 * 1000)
  await stopped
  assert.equal(client.joins, joinsBefore)
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
