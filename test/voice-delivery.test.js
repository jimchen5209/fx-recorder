// How DiscordVoice and FluxerVoice hand recordings to delivery: a file is deleted only after it was sent, a failed upload
// is retried 3 times 5 s apart and then given up without crashing the bot, and the end of a session is not held up.
// The voice objects skip their constructors (no client, no voice connection); timers are mocked.
const test = require('node:test')
const assert = require('node:assert/strict')
const { stubInstances, fakeLogger, channel } = require('./helpers')

const instances = stubInstances()
const { DiscordVoice } = require('../dist/Core/Discord/Core/Voice')
const { FluxerVoice } = require('../dist/Core/Fluxer/Voice')

const file = { start: 'S', end: 'E', tags: [], audioFilePath: 'temp/S.mp3', audioFileName: 'S.mp3', perUserFiles: [] }
const config = channel({ sendIntervalSecond: 60, fileDest: [{ type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }] })

let uploads
let messages
let removed
let unhandled
const onUnhandled = (error) => unhandled.push(error)
test.beforeEach(() => {
  uploads = 0
  messages = []
  removed = []
  unhandled = []
  process.on('unhandledRejection', onUnhandled)
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
})
test.afterEach(() => {
  test.mock.timers.reset()
  process.off('unhandledRejection', onUnhandled)
})

function telegram(fail) {
  instances.telegram = {
    sendAudio: async () => {
      uploads++
      if (fail) throw new Error('telegram down')
    },
    sendMessage: async (_id, text) => messages.push(text)
  }
}
const recorder = { saver: { getFilePeriod: () => file, removeRecordFile: (start) => removed.push(start) }, stop: () => file }

// Moves mocked time on a second at a time, letting promises settle in between
async function runFor(ms) {
  for (let t = 0; t < ms; t += 1000) {
    await new Promise(setImmediate)
    test.mock.timers.tick(1000)
  }
  await new Promise(setImmediate)
}

function discordVoice() {
  const voice = Object.create(DiscordVoice.prototype)
  Object.assign(voice, { client: { leaveVoiceChannel: () => undefined }, channelConfig: config, logger: fakeLogger(), recorder, _active: true, readyToDelete: false })
  return voice
}
function fluxerVoice() {
  const voice = Object.create(FluxerVoice.prototype)
  Object.assign(voice, { channelConfig: config, logger: fakeLogger(), recorder, notifyAdmins: async () => undefined, _active: true, readyToDelete: false })
  return voice
}

for (const [name, make, stop] of [
  ['DiscordVoice', discordVoice, (voice) => {
    voice._active = false
    voice.stopSession('chan1', { stopPlaying: () => undefined })
  }],
  ['FluxerVoice', fluxerVoice, (voice) => voice.stopRecording()]
]) {
  test(`${name}: a sent segment is deleted`, async () => {
    telegram(false)
    const voice = make()
    voice.startSendRecord()
    await runFor(60 * 1000)
    clearInterval(voice.sendInterval)
    assert.equal(uploads, 1)
    assert.deepEqual(removed, ['S'])
  })

  test(`${name}: a failed segment is retried 3 times 5 s apart, then kept, without an unhandled rejection`, async () => {
    telegram(true)
    const voice = make()
    voice.startSendRecord()
    await runFor(60 * 1000)
    assert.equal(uploads, 1)
    await runFor(5 * 1000)
    assert.equal(uploads, 2)
    await runFor(5 * 1000)
    clearInterval(voice.sendInterval)
    assert.equal(uploads, 3)
    assert.deepEqual(removed, [])
    assert.deepEqual(unhandled, [])
  })

  test(`${name}: the end of a session is announced after the rest is sent`, async () => {
    telegram(false)
    const voice = make()
    stop(voice)
    await runFor(1000)
    assert.equal(uploads, 1)
    assert.ok(messages.includes('[chan1] The record session has ended.'))
    assert.equal(voice.readyToDelete, true)
  })

  test(`${name}: a failed rest of the session is kept, not announced as ended, and does not hold up shutdown`, async () => {
    telegram(true)
    const voice = make()
    stop(voice)
    await runFor(11 * 1000)
    assert.equal(uploads, 3)
    assert.ok(!messages.includes('[chan1] The record session has ended.'))
    assert.deepEqual(removed, [])
    assert.equal(voice.readyToDelete, true)
    assert.deepEqual(unhandled, [])
  })
}
