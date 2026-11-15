// Fluxer gateway side: instance discovery, the guard on where the bot token may go, the voice join state machine
// (FluxerVoiceManager), and how Fluxer routes gateway events to its channels. No network: HTTP goes to an undici
// MockAgent (it also serves Node's fetch), and the gateway client is a fake emitter.
const test = require('node:test')
const assert = require('node:assert/strict')
const path = require('node:path')
const { EventEmitter } = require('node:events')
const { Events } = require('@fluxerjs/core')
const { stubApp, fakeLogger, useTempCwd } = require('./helpers')

stubApp()
const { discoverInstance, parseEndpoint, isTlsEndpoint } = require('../dist/Fluxer/Discovery')
const { FluxerVoiceManager } = require('../dist/Fluxer/Voice/Manager')
const { Fluxer } = require('../dist/Fluxer/Fluxer')

// The undici that @fluxerjs/rest uses; its global dispatcher is shared with Node's fetch
const rest = require.resolve('@fluxerjs/rest', { paths: [path.dirname(require.resolve('@fluxerjs/core'))] })
const undici = require(require.resolve('undici', { paths: [path.dirname(rest)] }))

// Node's fetch uses the global dispatcher; @fluxerjs/rest makes its own undici Agent on its first request, so that
// constructor hands out the mock too
function mockHttp(t) {
  const agent = new undici.MockAgent()
  agent.disableNetConnect()
  const previous = undici.getGlobalDispatcher()
  const Agent = undici.Agent
  undici.setGlobalDispatcher(agent)
  undici.Agent = function MockedAgent() {
    return agent
  }
  t.after(() => {
    undici.setGlobalDispatcher(previous)
    undici.Agent = Agent
  })
  return agent
}

const discovery = (overrides = {}) => ({
  endpoints: { api_public: 'https://fx.example/api', media: 'https://media.fx.example', ...overrides.endpoints },
  api_code_version: 1,
  features: { voice_enabled: true },
  ...overrides.top
})

test('discovery: the document gives the API, media, code version and voice flag', async (t) => {
  mockHttp(t).get('https://fx.example').intercept({ path: '/.well-known/fluxer' }).reply(200, discovery())
  assert.deepEqual(await discoverInstance('https://fx.example'), { apiPublic: 'https://fx.example/api', media: 'https://media.fx.example', apiCodeVersion: 1, voiceEnabled: true })
})

test('discovery: a missing or odd field falls back; an http media URL is dropped', async (t) => {
  mockHttp(t)
    .get('https://fx.example')
    .intercept({ path: '/.well-known/fluxer' })
    .reply(200, { endpoints: { api_public: 'https://api.fx.example', media: 'http://media.fx.example' } })
  assert.deepEqual(await discoverInstance('https://fx.example'), { apiPublic: 'https://api.fx.example', media: undefined, apiCodeVersion: 0, voiceEnabled: false })
})

for (const [name, reply, error] of [
  ['an HTTP error', (agent) => agent.reply(500, 'down'), /answered HTTP 500/],
  ['no endpoints', (agent) => agent.reply(200, { features: {} }), /has no endpoints/],
  ['an API on another host', (agent) => agent.reply(200, discovery({ endpoints: { api_public: 'https://fx.example.evil.com/api' } })), /must be an https:\/\/ URL on fx\.example/],
  ['an http API', (agent) => agent.reply(200, discovery({ endpoints: { api_public: 'http://fx.example/api' } })), /must be an https:\/\/ URL/],
  ['a redirect (not followed)', (agent) => agent.reply(302, '', { headers: { location: 'https://evil.example/.well-known/fluxer' } }), /fetch failed|redirect/]
]) {
  test(`discovery: ${name} fails`, async (t) => {
    reply(mockHttp(t).get('https://fx.example').intercept({ path: '/.well-known/fluxer' }))
    await assert.rejects(discoverInstance('https://fx.example'), error)
  })
}

test('voice endpoints: no scheme means wss, the path is kept, only TLS counts', () => {
  assert.equal(parseEndpoint('voice.example/livekit').toString(), 'wss://voice.example/livekit')
  assert.ok(isTlsEndpoint('voice.example'))
  assert.ok(isTlsEndpoint('https://voice.example'))
  assert.ok(!isTlsEndpoint('ws://voice.example'))
  assert.ok(!isTlsEndpoint('http://voice.example'))
  assert.ok(!isTlsEndpoint('wss://'))
})

test('start: a gateway URL off the configured host is refused, so the token never goes there', async (t) => {
  const agent = mockHttp(t)
  const requests = []
  agent.get('https://fx.example').intercept({ path: '/.well-known/fluxer' }).reply(200, discovery())
  agent
    .get('https://fx.example')
    .intercept({ path: (p) => p.startsWith('/api'), method: () => true })
    .reply((options) => {
      requests.push(options.path)
      return { statusCode: 200, data: options.path.includes('/gateway/bot') ? { url: 'wss://gateway.evil.example', shards: 1 } : {} }
    })
    .persist()
  const fluxer = new Fluxer({ id: 'self', enabled: true, origin: 'https://fx.example', botToken: 'secret', admins: [], logErrorsToAdmin: false, channels: [] })
  await assert.rejects(fluxer.start(), /must be a wss:\/\/ URL on fx\.example or a subdomain/)
  assert.ok(requests.some((p) => p.includes('/gateway/bot')))
  assert.equal(fluxer.client, undefined, 'given up and cleaned up')
})

// A gateway client: an emitter with the few calls the manager makes
function fakeClient() {
  const client = new EventEmitter()
  client.user = { id: 'bot' }
  client.ws = { getShardCount: () => 1 }
  client.sent = []
  client.sendToGateway = (shard, payload) => client.sent.push([shard, payload.d])
  return client
}
function managerOf(client, own = () => []) {
  return new FluxerVoiceManager(client, fakeLogger(), own)
}
const server = (data) => ({ connection_id: 'conn', channel_id: 'v1', endpoint: 'voice.example', token: 'lk', ...data })

test('join: leaves the bot’s stray connections in the channel, then asks to join with a mutation id', () => {
  const client = fakeClient()
  const connection = managerOf(client, () => ['old']).join('1', 'v1')
  assert.deepEqual(client.sent[0], [0, { guild_id: '1', self_mute: false, self_deaf: false, channel_id: null, connection_id: 'old' }])
  assert.deepEqual(client.sent[1], [0, { guild_id: '1', self_mute: false, self_deaf: false, channel_id: 'v1', mutation_id: connection.mutationId }])
})

test('join: the shard comes from the guild id', () => {
  const client = fakeClient()
  client.ws.getShardCount = () => 4
  managerOf(client).join(String(5n << 22n), 'v1')
  assert.equal(client.sent[0][0], 1)
})

test('join: a grant after the ack gives endpoint, token and connection id; the token is never logged', () => {
  const client = fakeClient()
  const records = []
  const connection = new FluxerVoiceManager(client, fakeLogger(records), () => []).join('1', 'v1')
  const grants = []
  connection.on('grant', (grant) => grants.push(grant))
  client.emit(Events.VoiceStateAck, { mutation_id: connection.mutationId, connection_id: 'conn', status: 'ok' })
  client.emit(Events.VoiceServerUpdate, server({ e2ee_key: 'k' }))
  assert.deepEqual(grants, [{ endpoint: 'voice.example', token: 'lk', connectionId: 'conn', encrypted: true }])
  assert.equal(connection.mutationId, undefined)
  assert.ok(records.some(([level, message]) => level === 'warn' && /encrypts call media/.test(message)))
  assert.ok(!JSON.stringify(records).includes('"lk"') && !JSON.stringify(records).includes(' lk'))
})

test('join: a grant before any ack is matched by channel', () => {
  const client = fakeClient()
  const connection = managerOf(client).join('1', 'v1')
  const grants = []
  connection.on('grant', (grant) => grants.push(grant))
  client.emit(Events.VoiceServerUpdate, server())
  assert.equal(grants.length, 1)
})

for (const [name, event, reason] of [
  ['a refused ack', (client, c) => client.emit(Events.VoiceStateAck, { mutation_id: c.mutationId, status: 'rejected', error_code: 'NO', error_message: 'full' }), /refused: NO full/],
  ['a grant without a voice server (peer to peer)', (client) => client.emit(Events.VoiceServerUpdate, server({ endpoint: null })), /no voice server/],
  ['a grant with a plain-text endpoint', (client) => client.emit(Events.VoiceServerUpdate, server({ endpoint: 'ws://voice.example' })), /must be a wss:\/\/ or https:\/\/ URL/],
  ['a grant without a connection id', (client) => client.emit(Events.VoiceServerUpdate, server({ connection_id: null })), /no connection id/]
]) {
  test(`join: ${name} ends the connection`, () => {
    const client = fakeClient()
    const connection = managerOf(client).join('1', 'v1')
    const closed = []
    connection.on('closed', (why) => closed.push(why))
    event(client, connection)
    assert.equal(closed.length, 1)
    assert.match(closed[0], reason)
  })
}

test('join: no answer within 20 s ends the connection', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const connection = managerOf(fakeClient()).join('1', 'v1')
  const closed = []
  connection.on('closed', (why) => closed.push(why))
  t.mock.timers.tick(20 * 1000)
  assert.deepEqual(closed, ['the voice server did not answer the join'])
})

test('a grant for another of the bot’s connections (one left from before a restart) is ignored', () => {
  const client = fakeClient()
  const connection = managerOf(client).join('1', 'v1')
  client.emit(Events.VoiceStateAck, { mutation_id: connection.mutationId, connection_id: 'conn' })
  client.emit(Events.VoiceServerUpdate, server())
  const grants = []
  connection.on('grant', (grant) => grants.push(grant))
  client.emit(Events.VoiceServerUpdate, server({ connection_id: 'stray', channel_id: 'v1' }))
  assert.deepEqual(grants, [])
})

test('removed by a moderator: closed without sending a leave; moved: closed and the move is left', () => {
  for (const [channel, leaves] of [
    [null, 0],
    ['v2', 1]
  ]) {
    const client = fakeClient()
    const connection = managerOf(client).join('1', 'v1')
    client.emit(Events.VoiceStateAck, { mutation_id: connection.mutationId, connection_id: 'conn' })
    const before = client.sent.length
    const closed = []
    connection.on('closed', (why) => closed.push(why))
    client.emit(Events.VoiceStateUpdate, { guild_id: '1', user_id: 'bot', connection_id: 'conn', channel_id: channel })
    assert.equal(closed.length, 1)
    assert.equal(client.sent.length - before, leaves)
  }
})

test('voice states of other users or other connections leave the connection alone', () => {
  const client = fakeClient()
  const connection = managerOf(client).join('1', 'v1')
  client.emit(Events.VoiceStateAck, { mutation_id: connection.mutationId, connection_id: 'conn' })
  const closed = []
  connection.on('closed', (why) => closed.push(why))
  client.emit(Events.VoiceStateUpdate, { guild_id: '1', user_id: 'someone', connection_id: 'conn', channel_id: null })
  client.emit(Events.VoiceStateUpdate, { guild_id: '1', user_id: 'bot', connection_id: 'other', channel_id: null })
  client.emit(Events.VoiceStateUpdate, { guild_id: '1', user_id: 'bot', connection_id: 'conn', channel_id: 'v1' })
  assert.deepEqual(closed, [])
})

test('leave sends one leave and closes once; joining the channel again replaces the old connection', () => {
  const client = fakeClient()
  const manager = managerOf(client)
  const first = manager.join('1', 'v1')
  client.emit(Events.VoiceStateAck, { mutation_id: first.mutationId, connection_id: 'conn' })
  const closed = []
  first.on('closed', (why) => closed.push(why))
  const before = client.sent.length
  first.leave()
  first.leave()
  assert.deepEqual(closed, ['left'])
  assert.deepEqual(client.sent.slice(before), [[0, { guild_id: '1', self_mute: false, self_deaf: false, channel_id: null, connection_id: 'conn' }]])
  const second = manager.join('1', 'v1')
  const third = manager.join('1', 'v1')
  assert.notEqual(second, third)
})

test('dispose leaves every channel and stops listening', () => {
  const client = fakeClient()
  const manager = managerOf(client)
  const connection = manager.join('1', 'v1')
  const closed = []
  connection.on('closed', (why) => closed.push(why))
  manager.dispose()
  assert.deepEqual(closed, ['left'])
  assert.equal(client.listenerCount(Events.VoiceServerUpdate), 0)
})

// Fluxer with its gateway handlers on a fake client; the voices' update() is watched instead of joining
function fluxerOn(t) {
  const tmp = useTempCwd()
  t.mock.timers.enable({ apis: ['setTimeout', 'setInterval'] })
  t.after(() => {
    t.mock.timers.reset()
    tmp.cleanup()
  })
  const fluxer = new Fluxer({
    id: 'self',
    enabled: true,
    origin: 'https://fx.example',
    botToken: 'x',
    admins: [],
    logErrorsToAdmin: false,
    channels: ['v1', 'v2'].map((id) => ({ id, guildId: '1', fileDest: [], timeZone: 'UTC', sendIntervalSecond: 60, ignoreUsers: [] }))
  })
  const client = new EventEmitter()
  client.user = { id: 'bot', username: 'bot' }
  fluxer.listen(client, { join: () => new EventEmitter() })
  const updates = []
  const watch = () => {
    for (const [id, voice] of fluxer.voices) voice.update = () => updates.push(id)
  }
  return { fluxer, client, updates, watch }
}

test('Fluxer: the first ready makes a voice per channel; a later ready keeps them', (t) => {
  const { fluxer, client } = fluxerOn(t)
  client.emit(Events.Ready)
  const voices = [...fluxer.voices.values()]
  assert.deepEqual([...fluxer.voices.keys()], ['v1', 'v2'])
  client.emit(Events.Ready)
  assert.deepEqual([...fluxer.voices.values()], voices)
})

test('Fluxer: a voice state change updates the channels it left and entered', (t) => {
  const { fluxer, client, updates, watch } = fluxerOn(t)
  client.emit(Events.Ready)
  watch()
  client.emit(Events.VoiceStatesSync, { guildId: '1', voiceStates: [] })
  updates.length = 0
  client.emit(Events.VoiceStateUpdate, { guild_id: '1', user_id: 'u1', connection_id: 'c', channel_id: 'v1', version: 1 })
  client.emit(Events.VoiceStateUpdate, { guild_id: '1', user_id: 'u1', connection_id: 'c', channel_id: 'v2', version: 2 })
  client.emit(Events.VoiceStateUpdate, { channel_id: 'v1', user_id: 'u1', connection_id: 'c' }) // a call: no guild
  assert.deepEqual(updates, ['v1', 'v1', 'v2'])
  assert.deepEqual(fluxer.tracker.usersIn('1', 'v2'), ['u1'])
})

test('Fluxer: a Guild Create right after its voice states keeps them; a later one without them empties the guild', async (t) => {
  const { fluxer, client } = fluxerOn(t)
  client.emit(Events.Ready)
  client.emit(Events.VoiceStatesSync, { guildId: '1', voiceStates: [{ user_id: 'u1', connection_id: 'c', channel_id: 'v1' }] })
  client.emit(Events.GuildCreate, { id: '1' })
  assert.deepEqual(fluxer.tracker.usersIn('1', 'v1'), ['u1'])
  await Promise.resolve()
  client.emit(Events.GuildCreate, { id: '1' })
  assert.deepEqual(fluxer.tracker.usersIn('1', 'v1'), [])
  client.emit(Events.GuildUnavailable, { id: '1' })
  assert.equal(fluxer.tracker.usersIn('1', 'v1'), undefined)
})

// A connected client: what it was asked to do is noted
function connectedClient() {
  const did = []
  return {
    did,
    isReady: () => true,
    user: { id: 'bot', username: 'bot', setPresence: (presence) => did.push(['presence', presence]) },
    channels: { send: async (id, payload) => did.push(['send', id, payload]) },
    users: {
      fetch: async (id) => {
        if (id === 'gone') throw new Error('unknown user')
        return { createDM: async () => ({ send: async (text) => did.push(['dm', id, text]) }) }
      }
    },
    guilds: { get: (id) => (id === '1' ? { members: { fetchMe: async () => ({ edit: async (edit) => did.push(['nick', edit.nick]) }) } } : undefined) },
    destroy: async () => did.push(['destroy'])
  }
}

test('Fluxer: as a destination, a message or a file goes to the channel', async (t) => {
  const { fluxer } = fluxerOn(t)
  const client = connectedClient()
  fluxer.client = client
  require('node:fs').writeFileSync('temp/a.mp3', 'mp3')
  await fluxer.send('c', 'hi')
  await fluxer.send('c', 'cap', { name: 'a.mp3', path: 'temp/a.mp3' })
  assert.deepEqual(client.did[0], ['send', 'c', 'hi'])
  assert.equal(client.did[1][2].content, 'cap')
  assert.equal(client.did[1][2].files[0].name, 'a.mp3')
  assert.equal(client.did[1][2].files[0].data.toString(), 'mp3')
})

test('Fluxer: admin messages go to each admin by DM, one failing does not stop the others, and only when asked for', async (t) => {
  const { fluxer } = fluxerOn(t)
  const client = connectedClient()
  fluxer.client = client
  fluxer.instance.admins = ['a1', 'gone', 'a2']
  await fluxer.sendAdminMessage('boom')
  assert.deepEqual(client.did, [])
  fluxer.instance.logErrorsToAdmin = true
  await fluxer.sendAdminMessage('boom')
  assert.deepEqual(client.did, [
    ['dm', 'a1', 'boom'],
    ['dm', 'a2', 'boom']
  ])
})

test('Fluxer: presence counts the recorded channels; the nickname gets a red dot in a guild while one of its channels records', async (t) => {
  const { fluxer, client: gateway } = fluxerOn(t)
  gateway.emit(Events.Ready)
  const client = connectedClient()
  fluxer.client = client
  const voice = fluxer.voices.get('v1')
  voice._active = true
  voice.emit('status')
  voice._active = false
  voice.emit('status')
  await new Promise(setImmediate)
  assert.deepEqual(client.did, [
    ['presence', { status: 'dnd', customStatus: { text: 'Recording 1 channel' } }],
    ['presence', { status: 'idle', customStatus: { text: 'Idle' } }],
    ['nick', '🔴 bot'],
    ['nick', null]
  ])
})

test('Fluxer: disconnect stops every channel, then the client', async (t) => {
  const { fluxer, client: gateway } = fluxerOn(t)
  gateway.emit(Events.Ready)
  const client = connectedClient()
  fluxer.client = client
  fluxer.manager = { dispose: () => client.did.push(['dispose']) }
  const stopped = []
  for (const [id, voice] of fluxer.voices) voice.stop = async () => stopped.push(id)
  await fluxer.disconnect()
  assert.deepEqual(stopped, ['v1', 'v2'])
  assert.deepEqual(client.did, [['dispose'], ['destroy']])
  assert.equal(fluxer.voices.size, 0)
})

test('Fluxer: sending while not connected fails; admin messages then do nothing', async (t) => {
  const { fluxer } = fluxerOn(t)
  await assert.rejects(fluxer.send('c', 'hi'), /not connected/)
  await fluxer.sendAdminMessage('hi')
  await fluxer.disconnect()
})
