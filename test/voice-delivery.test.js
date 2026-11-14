// How DiscordVoice and FluxerVoice hand recordings to delivery: a segment is deleted once sent, a failed one is retried
// and kept without crashing the bot, admins hear of it (Discord only while recording), and the end of a session is not
// held up. The voices are made with their real constructors and fake clients; the recorder is faked; timers are mocked.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { stubApp, fakeLogger, useTempCwd, channel } = require('./helpers')

const app = stubApp()
const { DiscordVoice } = require('../dist/Core/Discord/Core/Voice')
const { FluxerVoice } = require('../dist/Core/Fluxer/Voice')

const file = { start: 'S', end: 'E', tags: [], audioFilePath: 'temp/S.mp3', audioFileName: 'S.mp3', perUserFiles: [] }
const config = channel({ guildId: 'g1', sendIntervalSecond: 60, fileDest: [{ type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }] })

let uploads
let messages
let adminMessages
let unhandled
let tmp
const onUnhandled = (error) => unhandled.push(error)
test.beforeEach(() => {
  uploads = 0
  messages = []
  adminMessages = []
  unhandled = []
  tmp = useTempCwd()
  fs.writeFileSync('temp/S.mp3', 'mp3')
  app.config.telegram = { ...app.config.telegram, logErrorsToAdmin: true, admins: ['admin'] }
  process.on('unhandledRejection', onUnhandled)
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
})
test.afterEach(() => {
  test.mock.timers.reset()
  process.off('unhandledRejection', onUnhandled)
  tmp.cleanup()
})

function telegram(fail) {
  app.telegram = {
    sendFile: async () => {
      uploads++
      if (fail) throw new Error('telegram down')
    },
    sendMessage: async (id, text) => (id === 'admin' ? adminMessages : messages).push(text)
  }
}
const recorder = { startStream: () => undefined, saver: { getFilePeriod: async () => file }, stop: async () => file }

// Moves mocked time on a second at a time, letting promises settle in between
async function runFor(ms) {
  for (let t = 0; t < ms; t += 1000) {
    await new Promise(setImmediate)
    test.mock.timers.tick(1000)
  }
  await new Promise(setImmediate)
}

const stopTimers = (voice) => {
  clearInterval(voice.recording.sendInterval)
  clearInterval(voice.recording.cleanupInterval)
}

function discordVoice() {
  const client = { user: { id: 'bot' }, getChannel: () => ({ voiceMembers: [] }), voiceConnections: { find: () => undefined }, leaveVoiceChannel: () => undefined }
  const voice = new DiscordVoice(client, config, fakeLogger())
  voice.recording.recorder = recorder
  voice._active = true
  return voice
}
function fluxerVoice() {
  const voice = new FluxerVoice('official', config, {}, {}, () => 'bot', async () => undefined, fakeLogger())
  voice.recording.recorder = recorder
  voice._active = true
  return voice
}

const voices = [
  [
    'DiscordVoice',
    discordVoice,
    (voice) => {
      voice._active = false
      voice.stopSession('chan1', { stopPlaying: () => undefined })
    }
  ],
  ['FluxerVoice', fluxerVoice, (voice) => voice.stopRecording()]
]

for (const [name, make, stop] of voices) {
  test(`${name}: a sent segment is deleted`, async () => {
    telegram(false)
    const voice = make()
    voice.recording.start()
    await runFor(60 * 1000)
    stopTimers(voice)
    assert.equal(uploads, 1)
    assert.ok(!fs.existsSync(file.audioFilePath))
  })

  test(`${name}: a failed segment is retried 3 times 5 s apart, kept, and admins are told, without an unhandled rejection`, async () => {
    telegram(true)
    const voice = make()
    voice.recording.start()
    await runFor(60 * 1000)
    assert.equal(uploads, 1)
    await runFor(5 * 1000)
    assert.equal(uploads, 2)
    await runFor(5 * 1000)
    stopTimers(voice)
    assert.equal(uploads, 3)
    assert.ok(fs.existsSync(file.audioFilePath))
    assert.deepEqual(adminMessages, ['Failed to send S.mp3 after 3 attempts'])
    assert.deepEqual(unhandled, [])
  })

  test(`${name}: the end of a session is announced after the rest is sent, and the last segment stays on disk`, async () => {
    telegram(false)
    const voice = make()
    stop(voice)
    await runFor(1000)
    stopTimers(voice)
    assert.equal(uploads, 1)
    assert.ok(messages.includes('[chan1] The record session has ended.'))
    assert.ok(fs.existsSync(file.audioFilePath))
    assert.equal(voice.recording.pending.size, 0, 'nothing left for shutdown to wait for')
  })

  test(`${name}: a failed rest of the session is kept, not announced as ended, and does not hold up shutdown`, async () => {
    telegram(true)
    const voice = make()
    stop(voice)
    await runFor(11 * 1000)
    stopTimers(voice)
    assert.equal(uploads, 3)
    assert.ok(!messages.includes('[chan1] The record session has ended.'))
    assert.ok(fs.existsSync(file.audioFilePath))
    assert.equal(voice.recording.pending.size, 0, 'a failed rest does not hold up shutdown')
    assert.deepEqual(unhandled, [])
    // Discord only tells admins while recording; Fluxer also after the session ended
    assert.deepEqual(adminMessages, name === 'FluxerVoice' ? ['Failed to send S.mp3 after 3 attempts'] : [])
  })
}
