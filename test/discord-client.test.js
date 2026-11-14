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
  const discord = new Discord({ token: 'test', channels: [channel({ id: 'c1' })], admins: [], logErrorsToAdmin: false }, fakeLogger())
  const client = discord.client
  client.disconnects = []
  client.statuses = 0
  client.disconnect = (options) => client.disconnects.push(options)
  client.editStatus = () => client.statuses++
  client.user = { id: 'bot', username: 'bot' }
  return { discord, client }
}
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
})
