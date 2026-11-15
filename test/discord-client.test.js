// Discord: reconnecting the whole client keeps the app's handlers and recorded channels, and a second ready does not
// make the channels again. A real Dysnomia client that never connects; its network calls are faked; timers are mocked.
const test = require('node:test')
const assert = require('node:assert/strict')
const { stubApp, fakeLogger, useTempCwd, channel } = require('./helpers')

stubApp()
const { Discord } = require('../dist/Discord/Discord')

const events = ['voiceChannelJoin', 'voiceChannelLeave', 'voiceChannelSwitch', 'warn', 'error', 'ready']

function setup(t) {
  const tmp = useTempCwd()
  // The voices' debounced join check and cleanup timer never run
  test.mock.timers.enable({ apis: ['setTimeout', 'setInterval', 'Date'] })
  t.after(() => {
    test.mock.timers.reset()
    tmp.cleanup()
  })
  const discord = new Discord({ token: 'test', channels: [channel({ id: 'c1' }), channel({ id: 'c2' })], admins: [], logErrorsToAdmin: false }, fakeLogger())
  const client = discord.client
  client.disconnects = []
  client.statuses = 0
  client.statusArgs = []
  client.messages = []
  client.disconnect = (options) => client.disconnects.push(options)
  client.editStatus = (...args) => {
    client.statuses++
    client.statusArgs.push(args)
  }
  client.createMessage = async (...args) => client.messages.push(args)
  client.user = { id: 'bot', username: 'bot' }
  return { discord, client }
}

// Replaces each recorded channel's handlers with ones that note the call
function watchVoices(discord) {
  const calls = []
  for (const [id, voice] of Object.entries(discord.audios)) {
    voice.handleUserConnect = () => calls.push(['connect', id])
    voice.handleUserDisconnect = (user) => calls.push(['disconnect', id, user])
    voice.stop = async () => calls.push(['stop', id])
  }
  return calls
}

test('voice events go to the recorded channel; the bot’s own and other channels are ignored', (t) => {
  const { discord, client } = setup(t)
  client.emit('ready')
  const calls = watchVoices(discord)
  client.emit('voiceChannelJoin', { id: 'u1' }, { id: 'c1' })
  client.emit('voiceChannelJoin', { id: 'bot' }, { id: 'c1' })
  client.emit('voiceChannelJoin', { id: 'u1' }, { id: 'elsewhere' })
  client.emit('voiceChannelLeave', { id: 'u1' }, { id: 'c1' })
  client.emit('voiceChannelSwitch', { id: 'u2' }, { id: 'c2' }, { id: 'c1' })
  client.emit('voiceChannelSwitch', { id: 'bot' }, { id: 'c2' }, { id: 'c1' })
  assert.deepEqual(calls, [
    ['connect', 'c1'],
    ['disconnect', 'c1', 'u1'],
    ['disconnect', 'c1', 'u2'],
    ['connect', 'c2']
  ])
})

test('presence: idle with nothing recorded, dnd with the count while recording', (t) => {
  const { discord, client } = setup(t)
  client.emit('ready')
  discord.audios.c1._active = true
  discord.audios.c1.emit('status')
  discord.audios.c2._active = true
  discord.audios.c2.emit('status')
  assert.deepEqual(
    client.statusArgs.map(([status, activity]) => [status, activity.state]),
    [
      ['idle', 'Idle'],
      ['dnd', 'Recording 1 channel'],
      ['dnd', 'Recording 2 channels']
    ]
  )
})

test('as a destination: a message, or a file as an attachment with the caption', async (t) => {
  const { discord, client } = setup(t)
  const fs = require('node:fs')
  fs.writeFileSync('temp/a.mp3', 'mp3')
  await discord.sendMessage('d1', 'hi')
  await discord.sendFile('d1', 'cap', { name: 'a.mp3', path: 'temp/a.mp3' })
  assert.deepEqual(client.messages[0], ['d1', 'hi'])
  assert.equal(client.messages[1][1].content, 'cap')
  assert.equal(client.messages[1][1].attachments[0].filename, 'a.mp3')
  assert.equal(client.messages[1][1].attachments[0].file.toString(), 'mp3')
})

test('start connects; disconnect stops every channel, then drops the handlers and the connection for good', async (t) => {
  const { discord, client } = setup(t)
  let connects = 0
  client.connect = () => connects++
  discord.start()
  assert.equal(connects, 1)
  client.emit('ready')
  const calls = watchVoices(discord)
  await discord.disconnect()
  assert.deepEqual(calls, [
    ['stop', 'c1'],
    ['stop', 'c2']
  ])
  assert.deepEqual(discord.audios, {})
  assert.deepEqual(listeners(client), [0, 0, 0, 0, 0, 0])
  assert.deepEqual(client.disconnects, [{ reconnect: false }])
})

test('Silence: one Opus silence frame, then the end', async () => {
  const { Silence } = require('../dist/Discord/Silence')
  const chunks = []
  for await (const chunk of new Silence()) chunks.push(chunk)
  assert.deepEqual(chunks, [Buffer.from([0xf8, 0xff, 0xfe])])
})

test('an empty token is refused', () => {
  assert.throws(() => new Discord({ token: '', channels: [], admins: [], logErrorsToAdmin: false }, fakeLogger()), /token missing/)
})
const listeners = (client) => events.map((event) => client.listenerCount(event))

test('reconnect keeps the handlers and the recorded channels', (t) => {
  const { discord, client } = setup(t)
  client.emit('ready')
  const before = listeners(client)
  const voice = discord.audios.c1
  assert.ok(voice)

  discord.reconnect()
  assert.deepEqual(client.disconnects, [{ reconnect: true }])
  assert.deepEqual(listeners(client), before)
  assert.equal(discord.audios.c1, voice)
})

test('a ready after a reconnect sets the presence again and keeps the same channels', (t) => {
  const { discord, client } = setup(t)
  client.emit('ready')
  const voice = discord.audios.c1
  discord.reconnect()
  client.emit('ready')
  assert.equal(discord.audios.c1, voice)
  assert.equal(client.statuses, 2)
  assert.deepEqual(Object.keys(discord.audios), ['c1', 'c2'])
})
