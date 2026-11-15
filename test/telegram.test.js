// Telegram with a fake node-telegram-bot-api: a token is required, /ping answers pong, a failed message is logged and
// not thrown, a failed upload is thrown, Markdown for admins, and disconnect stops polling.
const test = require('node:test')
const assert = require('node:assert/strict')
const { fakeLogger } = require('./helpers')

const bots = []
class FakeBot {
  constructor(token, options) {
    Object.assign(this, { token, options, calls: [], handlers: [], fail: false })
    bots.push(this)
  }
  onText(pattern, handler) {
    this.handlers.push([pattern, handler])
  }
  async sendMessage(...args) {
    this.calls.push(['sendMessage', ...args])
    if (this.fail) throw new Error('telegram down')
  }
  async sendAudio(...args) {
    this.calls.push(['sendAudio', ...args])
    if (this.fail) throw new Error('telegram down')
  }
  stopPolling() {
    this.calls.push(['stopPolling'])
  }
}
require.cache[require.resolve('node-telegram-bot-api')] = { exports: FakeBot, loaded: true }
const { Telegram } = require('../dist/Telegram/Telegram')

const config = { token: 'secret', admins: [], logErrorsToAdmin: false, baseApiUrl: 'https://tg.example' }

test('an empty token is refused', () => {
  assert.throws(() => new Telegram({ ...config, token: '' }, fakeLogger()), /token not found/)
})

test('the bot gets the token and API URL, and answers /ping and /ping@bot with pong as a reply', () => {
  new Telegram(config, fakeLogger())
  const bot = bots.at(-1)
  assert.equal(bot.token, 'secret')
  assert.deepEqual(bot.options, { baseApiUrl: 'https://tg.example' })
  const [[pattern, handler]] = bot.handlers
  assert.ok(pattern.test('/ping') && pattern.test('/ping@my_bot'))
  handler({ chat: { id: 42 }, message_id: 7 })
  assert.deepEqual(bot.calls, [['sendMessage', 42, 'pong', { reply_parameters: { message_id: 7 } }]])
})

test('sendMessage: plain or Markdown; a failure is logged, not thrown', async () => {
  const records = []
  const telegram = new Telegram(config, fakeLogger(records))
  const bot = bots.at(-1)
  await telegram.sendMessage('c', 'hi')
  await telegram.sendMessage('c', '*hi*', true)
  bot.fail = true
  await telegram.sendMessage('c', 'lost')
  assert.deepEqual(bot.calls, [
    ['sendMessage', 'c', 'hi', { parse_mode: undefined }],
    ['sendMessage', 'c', '*hi*', { parse_mode: 'Markdown' }],
    ['sendMessage', 'c', 'lost', { parse_mode: undefined }]
  ])
  assert.ok(records.some(([level, message]) => level === 'error' && /Message lost send failed:telegram down/.test(message)))
})

test('sendFile: uploads the path as audio with the caption; a failure is logged and thrown', async () => {
  const records = []
  const telegram = new Telegram(config, fakeLogger(records))
  const bot = bots.at(-1)
  await telegram.sendFile('c', 'cap', { name: 'a.mp3', path: 'temp/a.mp3' })
  bot.fail = true
  await assert.rejects(telegram.sendFile('c', 'cap', { name: 'a.mp3', path: 'temp/a.mp3' }), /telegram down/)
  assert.deepEqual(bot.calls[0], ['sendAudio', 'c', 'temp/a.mp3', { caption: 'cap' }])
  assert.ok(records.some(([level, message]) => level === 'error' && /temp\/a\.mp3 send failed/.test(message)))
})

test('disconnect stops polling', () => {
  const telegram = new Telegram(config, fakeLogger())
  telegram.disconnect()
  assert.deepEqual(bots.at(-1).calls, [['stopPolling']])
})
