// Delivery to fake Telegram, Discord and Fluxer sinks. Captions, order, sendAll/perUser, retries,
// deleting a segment once sent, failure paths, and admin messages. Timers are mocked.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { stubApp, fakeLogger, useTempCwd, channel } = require('./helpers')

const app = stubApp()
const { Delivery, sendAdminMessage } = require('../dist/Delivery/Delivery')

let calls
// A sink that records what it is asked to send; fail(kind, id) decides which calls throw
function fakeSink(name, fail = () => false) {
  return {
    sendMessage: async (id, text) => {
      calls.push([name, 'message', id, text])
      if (fail('message', id)) throw new Error(`${name} down`)
    },
    sendFile: async (id, caption, file) => {
      calls.push([name, 'file', id, file.name, caption])
      if (fail('file', id)) throw new Error(`${name} down`)
    }
  }
}
const fakeFluxer = (id, fail) => {
  const sink = fakeSink(`fluxer:${id}`, fail)
  return { instance: { id }, send: (channelId, content, file) => (file ? sink.sendFile(channelId, content, file) : sink.sendMessage(channelId, content)) }
}

let tmp
let notified
test.beforeEach(() => {
  calls = []
  notified = []
  tmp = useTempCwd()
  fs.writeFileSync('temp/a.mp3', 'mixed')
  fs.writeFileSync('temp/u1-a.mp3', 'u1')
  app.telegram = fakeSink('telegram')
  app.discord = fakeSink('discord')
  app.fluxer = []
  test.mock.timers.enable({ apis: ['setTimeout'] })
})
test.afterEach(() => {
  test.mock.timers.reset()
  tmp.cleanup()
})

// Moves mocked time on a second at a time, letting promises settle in between
async function runFor(ms) {
  for (let t = 0; t < ms; t += 1000) {
    await new Promise(setImmediate)
    test.mock.timers.tick(1000)
  }
  await new Promise(setImmediate)
}

const delivery = (fileDest) => new Delivery(channel({ id: 'c1', fileDest }), fakeLogger(), (message) => notified.push(message))
const dest = (type, id, extra = {}) => ({ type, id, sendAll: true, sendPerUser: false, ...extra })
const segment = (name = 'a') => ({
  start: '2026-11-14 10-00-00',
  end: '2026-11-14 10-01-00',
  tags: ['#Date20261114', '#Time1000', '#Year2026'],
  audioFilePath: `temp/${name}.mp3`,
  audioFileName: `${name}.mp3`,
  perUserFiles: [{ user: 'u1', audioFilePath: `temp/u1-${name}.mp3`, audioFileName: `u1-${name}.mp3`, tag: '#Useru1' }]
})
const caption = 'Channel:c1\nStart:2026-11-14 10-00-00\nEnd:2026-11-14 10-01-00\n\n#Date20261114 #Time1000 #Year2026'
const userCaption = 'Channel:c1\nStart:2026-11-14 10-00-00\nEnd:2026-11-14 10-01-00\nUser:u1\n\n#Date20261114 #Time1000 #Year2026 #Useru1'
const files = () => fs.readdirSync('temp').sort()

test('deliver: destinations in config order, mixed before per-user, exact captions, then the files are deleted', async () => {
  app.fluxer = [fakeFluxer('official')]
  await delivery([
    dest('telegram', 't1', { sendPerUser: true }),
    dest('discord', 'd1'),
    dest('fluxer', 'f1', { instance: 'official', sendAll: false, sendPerUser: true }),
    dest('telegram', '', { sendPerUser: true })
  ]).deliver(segment())
  assert.deepEqual(calls, [
    ['telegram', 'file', 't1', 'a.mp3', caption],
    ['telegram', 'file', 't1', 'u1-a.mp3', userCaption],
    ['discord', 'file', 'd1', 'a.mp3', caption],
    ['fluxer:official', 'file', 'f1', 'u1-a.mp3', userCaption]
  ])
  assert.deepEqual(files(), [])
})

test('deliver with keepFiles sends and leaves the files', async () => {
  await delivery([dest('telegram', 't1')]).deliver(segment(), { keepFiles: true })
  assert.equal(calls.length, 1)
  assert.deepEqual(files(), ['a.mp3', 'u1-a.mp3'])
})

test('deliver: discord destinations are skipped when Discord is off', async () => {
  app.discord = undefined
  await delivery([dest('discord', 'd1', { sendPerUser: true })]).deliver(segment())
  assert.deepEqual(calls, [])
})

test('deliver: a failure is retried 3 times 5 s apart, then admins are told, the files stay and it rejects', async () => {
  app.telegram = fakeSink('telegram', (kind) => kind === 'file')
  const result = delivery([dest('telegram', 't1')]).deliver(segment())
  result.catch(() => undefined)
  await runFor(0)
  assert.equal(calls.length, 1)
  await runFor(5000)
  assert.equal(calls.length, 2)
  await runFor(5000)
  assert.equal(calls.length, 3)
  await assert.rejects(result, /telegram down/)
  assert.deepEqual(notified, ['Failed to send a.mp3 after 3 attempts'])
  assert.deepEqual(files(), ['a.mp3', 'u1-a.mp3'])
})

test('deliver: a discord failure stops the destinations after it', async () => {
  app.discord = fakeSink('discord', () => true)
  const result = delivery([dest('discord', 'd1'), dest('telegram', 't1')]).deliver(segment())
  result.catch(() => undefined)
  await runFor(10 * 1000)
  await assert.rejects(result, /discord down/)
  assert.deepEqual([...new Set(calls.map((c) => c[0]))], ['discord'])
})

test('deliver: a failed or missing fluxer instance does not hold back later destinations, then it rejects', async () => {
  app.fluxer = [fakeFluxer('official', () => true)]
  const result = delivery([dest('fluxer', 'f1', { instance: 'official' }), dest('fluxer', 'f2', { instance: 'gone' }), dest('telegram', 't1')]).deliver(segment())
  result.catch(() => undefined)
  await runFor(0)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['fluxer:official', 'telegram']
  )
  await runFor(10 * 1000)
  await assert.rejects(result, /fluxer:official down/)
})

test('deliver: a destination that succeeded is not sent again when another one is retried', async () => {
  let discordFailures = 1
  app.discord = fakeSink('discord', () => discordFailures-- > 0)
  const result = delivery([dest('telegram', 't1'), dest('discord', 'd1')]).deliver(segment())
  await runFor(5000)
  await result
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['telegram', 'discord', 'discord']
  )
  assert.deepEqual(files(), [], 'deleted once every destination has it')
})

test('deliver: within one destination, a retry sends only the files that failed', async () => {
  let failures = 1
  // The upload just recorded is the one being tried
  app.telegram = fakeSink('telegram', () => calls.at(-1)[3] === 'u1-a.mp3' && failures-- > 0)
  const result = delivery([dest('telegram', 't1', { sendPerUser: true })]).deliver(segment())
  await runFor(5000)
  await result
  assert.deepEqual(
    calls.map((c) => c[3]),
    ['a.mp3', 'u1-a.mp3', 'u1-a.mp3']
  )
})

test('deliver: two destinations with the same id count as two', async () => {
  await delivery([dest('telegram', 't1'), dest('telegram', 't1')]).deliver(segment())
  assert.equal(calls.length, 2)
})

test('deliver: a slow upload does not hold back the next segment, and each deletes only its own files', async () => {
  fs.writeFileSync('temp/b.mp3', 'mixed')
  fs.writeFileSync('temp/u1-b.mp3', 'u1')
  let release
  const slow = new Promise((resolve) => {
    release = resolve
  })
  app.telegram = {
    sendMessage: async () => undefined,
    sendFile: async (_id, _caption, file) => {
      calls.push(file.name)
      if (file.name === 'a.mp3') await slow
    }
  }
  const channelDelivery = delivery([dest('telegram', 't1')])
  const first = channelDelivery.deliver(segment('a'))
  await channelDelivery.deliver(segment('b'))
  assert.deepEqual(files(), ['a.mp3', 'u1-a.mp3'], 'the second segment is sent and deleted while the first is still uploading')
  release()
  await first
  assert.deepEqual(files(), [])
  assert.deepEqual(calls, ['a.mp3', 'b.mp3'])
})

// The real Telegram class with a fake bot, so its error handling is what gets tested
function realTelegram(sendAudio) {
  const { Telegram } = require('../dist/Telegram/Telegram')
  const telegram = Object.create(Telegram.prototype)
  telegram.logger = fakeLogger()
  telegram.bot = { sendAudio }
  return telegram
}

test('Telegram.sendFile uploads the path with the caption and throws when the upload fails', async () => {
  const sent = []
  await realTelegram(async (id, path, options) => sent.push([id, path, options])).sendFile('t1', 'cap', { name: 'a.mp3', path: 'temp/a.mp3' })
  assert.deepEqual(sent, [['t1', 'temp/a.mp3', { caption: 'cap' }]])
  await assert.rejects(realTelegram(async () => Promise.reject(new Error('telegram down'))).sendFile('t1', 'cap', { name: 'a.mp3', path: 'temp/a.mp3' }), /telegram down/)
})

test('sendMessage: prefixed with the channel, in config order; a fluxer failure is logged on the main logger, not thrown', async () => {
  const records = []
  app.mainLogger = fakeLogger(records)
  app.fluxer = [fakeFluxer('official', () => true)]
  await delivery([dest('fluxer', 'f1', { instance: 'official' }), dest('telegram', 't1'), dest('discord', 'd1')]).sendMessage('hi')
  assert.deepEqual(calls, [
    ['fluxer:official', 'message', 'f1', '[c1] hi'],
    ['telegram', 'message', 't1', '[c1] hi'],
    ['discord', 'message', 'd1', '[c1] hi']
  ])
  assert.deepEqual(records, [['error', 'Message to fluxer official/f1 failed: fluxer:official down']])
})

test('sendMessage: a discord failure is thrown', async () => {
  app.discord = fakeSink('discord', () => true)
  await assert.rejects(delivery([dest('discord', 'd1')]).sendMessage('hi'), /discord down/)
})

test('sendAdminMessage: one discord admin failing does not stop the others, then telegram admins (markdown)', async () => {
  app.config.discord = { ...app.config.discord, logErrorsToAdmin: true, admins: ['a1', 'a2'] }
  app.config.telegram = { ...app.config.telegram, logErrorsToAdmin: true, admins: ['ta'] }
  app.telegram = { sendMessage: async (id, text, markdown) => calls.push(['telegram', id, text, markdown]) }
  const discord = {
    getDMChannel: async (admin) => {
      if (admin === 'a1') throw new Error('no dm')
      return { id: `dm-${admin}` }
    },
    createMessage: async (id, text) => calls.push(['discord', id, text])
  }
  await sendAdminMessage(discord, fakeLogger(), 'boom')
  assert.deepEqual(calls, [
    ['discord', 'dm-a2', 'boom'],
    ['telegram', 'ta', 'boom', true]
  ])
})
