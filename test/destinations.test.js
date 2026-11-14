// Output/Destinations with fake Telegram, Discord and Fluxer clients: captions, order, sendAll/perUser, failure paths.
// Tests marked todo describe how the code should behave and fail for now.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const { stubInstances, fakeLogger, useTempCwd } = require('./helpers')

const instances = stubInstances()
const Destinations = require('../dist/Core/Output/Destinations')

let calls
function fakeTelegram() {
  return {
    sendAudio: async (id, file, caption) => {
      calls.push(['telegram.audio', id, path.basename(file), caption])
      return file
    },
    sendMessage: async (id, text, markdown) => calls.push(['telegram.message', id, text, !!markdown])
  }
}
function fakeDiscord({ fail = false } = {}) {
  return {
    createMessage: async (id, content) => {
      calls.push(['discord', id, typeof content === 'string' ? content : content.content, content.attachments?.[0]?.filename])
      if (fail) throw new Error('discord down')
    },
    getDMChannel: async (admin) => ({ id: `dm-${admin}` })
  }
}
function fakeFluxer(id, { fail = false } = {}) {
  return {
    instance: { id },
    send: async (channelId, content, file) => {
      calls.push(['fluxer', id, channelId, content, file?.name])
      if (fail) throw new Error('fluxer down')
    }
  }
}

let tmp
test.beforeEach(() => {
  calls = []
  tmp = useTempCwd()
  fs.writeFileSync('temp/a.mp3', 'mixed')
  fs.writeFileSync('temp/u1-a.mp3', 'u1')
  instances.telegram = fakeTelegram()
  instances.fluxer = []
})
test.afterEach(() => tmp.cleanup())

const file = {
  start: '2026-11-14 10-00-00',
  end: '2026-11-14 10-01-00',
  tags: ['#Date20261114', '#Time1000', '#Year2026'],
  audioFilePath: 'temp/a.mp3',
  audioFileName: 'a.mp3',
  perUserFiles: [{ user: 'u1', audioFilePath: 'temp/u1-a.mp3', audioFileName: 'u1-a.mp3', tag: '#Useru1' }]
}
const caption = 'Channel:c1\nStart:2026-11-14 10-00-00\nEnd:2026-11-14 10-01-00\n\n#Date20261114 #Time1000 #Year2026'
const userCaption = 'Channel:c1\nStart:2026-11-14 10-00-00\nEnd:2026-11-14 10-01-00\nUser:u1\n\n#Date20261114 #Time1000 #Year2026 #Useru1'

test('sendRecord: destinations in config order, mixed before per-user, exact captions', async () => {
  const dests = [
    { type: 'telegram', id: 't1', sendAll: true, sendPerUser: true },
    { type: 'discord', id: 'd1', sendAll: true, sendPerUser: false },
    { type: 'fluxer', id: 'f1', instance: 'official', sendAll: false, sendPerUser: true },
    { type: 'telegram', id: '', sendAll: true, sendPerUser: true }
  ]
  instances.fluxer = [fakeFluxer('official')]
  await Destinations.sendRecord(dests, fakeDiscord(), fakeLogger(), 'c1', file)
  assert.deepEqual(calls, [
    ['telegram.audio', 't1', 'a.mp3', caption],
    ['telegram.audio', 't1', 'u1-a.mp3', userCaption],
    ['discord', 'd1', caption, 'a.mp3'],
    ['fluxer', 'official', 'f1', userCaption, 'u1-a.mp3']
  ])
})

test('sendRecord: discord destinations are skipped without a client', async () => {
  await Destinations.sendRecord([{ type: 'discord', id: 'd1', sendAll: true, sendPerUser: true }], undefined, fakeLogger(), 'c1', file)
  assert.deepEqual(calls, [])
})

test('sendRecord: a discord failure rejects and stops the rest', async () => {
  const dests = [
    { type: 'discord', id: 'd1', sendAll: true, sendPerUser: false },
    { type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }
  ]
  await assert.rejects(Destinations.sendRecord(dests, fakeDiscord({ fail: true }), fakeLogger(), 'c1', file), /discord down/)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['discord']
  )
})

test('sendRecord: a fluxer failure (or a missing instance) does not hold back later destinations, then rejects', async () => {
  const dests = [
    { type: 'fluxer', id: 'f1', instance: 'official', sendAll: true, sendPerUser: false },
    { type: 'fluxer', id: 'f2', instance: 'gone', sendAll: true, sendPerUser: false },
    { type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }
  ]
  instances.fluxer = [fakeFluxer('official', { fail: true })]
  await assert.rejects(Destinations.sendRecord(dests, undefined, fakeLogger(), 'c1', file), /fluxer down/)
  assert.deepEqual(
    calls.map((c) => c[0]),
    ['fluxer', 'telegram.audio']
  )
})

// Fails for now: Telegram.sendAudio catches the SDK error, so sendRecord resolves and the caller deletes the file
test('a failed Telegram upload rejects sendRecord', { todo: true }, async () => {
  const TelegramModule = require('../dist/Core/Telegram/Core')
  const telegram = Object.create(TelegramModule.Telegram.prototype)
  telegram.logger = fakeLogger()
  telegram.bot = { sendAudio: async () => Promise.reject(new Error('telegram down')) }
  instances.telegram = telegram
  await assert.rejects(Destinations.sendRecord([{ type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }], undefined, fakeLogger(), 'c1', file))
})

test('sendMessage: telegram, discord, fluxer in order; a fluxer failure is logged, not thrown', async () => {
  instances.fluxer = [fakeFluxer('official', { fail: true })]
  const dests = [
    { type: 'fluxer', id: 'f1', instance: 'official' },
    { type: 'telegram', id: 't1' },
    { type: 'discord', id: 'd1' }
  ]
  await Destinations.sendMessage(dests, fakeDiscord(), '[c1] hi')
  assert.deepEqual(calls, [
    ['fluxer', 'official', 'f1', '[c1] hi', undefined],
    ['telegram.message', 't1', '[c1] hi', false],
    ['discord', 'd1', '[c1] hi', undefined]
  ])
})

test('sendAdminMessage: one discord admin failing does not stop the others, then telegram admins (markdown)', async () => {
  instances.config.discord = { ...instances.config.discord, logErrorsToAdmin: true, admins: ['a1', 'a2'] }
  instances.config.telegram = { ...instances.config.telegram, logErrorsToAdmin: true, admins: ['ta'] }
  const discord = fakeDiscord()
  discord.getDMChannel = async (admin) => {
    if (admin === 'a1') throw new Error('no dm')
    return { id: `dm-${admin}` }
  }
  await Destinations.sendAdminMessage(discord, fakeLogger(), 'boom')
  assert.deepEqual(calls, [
    ['discord', 'dm-a2', 'boom', undefined],
    ['telegram.message', 'ta', 'boom', true]
  ])
})
