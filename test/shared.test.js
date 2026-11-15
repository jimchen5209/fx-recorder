// Shared: Config (reading, defaults, migration, validation, exit codes), MessageQueue and FailSafe.
// Config runs in a temp cwd; process.exit throws instead, so the test sees where the constructor stopped.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const { fakeLogger, useTempCwd } = require('./helpers')

const { Config } = require('../dist/Shared/Config')
const { MessageQueue } = require('../dist/Shared/MessageQueue')
const { FailSafe } = require('../dist/Shared/FailSafe')

class Exit extends Error {
  constructor(code) {
    super(`exit ${code}`)
    this.code = code
  }
}

// Loads config.json (written from `file` when given) and returns the config or the exit code, with the log
function load(t, file) {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  t.mock.method(process, 'exit', (code) => {
    throw new Exit(code)
  })
  if (file !== undefined) fs.writeFileSync('config.json', typeof file === 'string' ? file : JSON.stringify(file))
  const records = []
  try {
    return { config: new Config(fakeLogger(records)), records }
  } catch (error) {
    if (!(error instanceof Exit)) throw error
    return { exit: error.code, records }
  }
}
const saved = () => JSON.parse(fs.readFileSync('config.json', 'utf8'))
const fatal = (records) => records.filter(([level]) => level === 'fatal').map(([, message]) => message)

const channel = { id: 'c1', fileDest: [{ type: 'telegram', id: 't1', sendAll: true, sendPerUser: false }], timeZone: 'UTC', sendIntervalSecond: 30, ignoreUsers: [] }
const valid = () => ({
  configVersion: 2.3,
  discord: { token: 'discord-secret', channels: [channel], admins: ['a1'], logErrorsToAdmin: true },
  fluxer: [],
  telegram: { token: 'telegram-secret', admins: [], logErrorsToAdmin: false },
  logging: { debug: false, raw: false }
})

test('Config: no config.json writes the empty config and exits 78', (t) => {
  const { exit } = load(t)
  assert.equal(exit, 78)
  const written = saved()
  assert.equal(written.configVersion, 2.3)
  assert.equal(written.discord.channels[0].timeZone, 'Asia/Taipei')
  assert.deepEqual(
    written.fluxer.map((instance) => [instance.id, instance.enabled]),
    [['official', false]]
  )
})

test('Config: a valid file loads, fills missing fields with defaults and is saved back', (t) => {
  const file = valid()
  delete file.logging
  file.discord.channels = [{ id: 'c1' }]
  const { config } = load(t, file)
  assert.equal(config.discord.token, 'discord-secret')
  assert.deepEqual(config.discord.channels[0], {
    id: 'c1',
    fileDest: [{ type: 'telegram', id: '', sendAll: true, sendPerUser: true }],
    timeZone: 'Asia/Taipei',
    sendIntervalSecond: 60,
    ignoreUsers: []
  })
  assert.deepEqual(config.logging, { debug: false, raw: false })
  assert.equal(config.telegram.baseApiUrl, undefined)
  assert.equal(saved().discord.channels[0].sendIntervalSecond, 60, 'saved with the defaults filled in')
})

test('Config: the legacy logging.Debug flag still turns debug on', (t) => {
  const file = valid()
  file.logging = { Debug: true }
  assert.equal(load(t, file).config.logging.debug, true)
})

test('Config: no fluxer key gets the disabled official instance', (t) => {
  const file = valid()
  delete file.fluxer
  assert.deepEqual(
    load(t, file).config.fluxer.map((instance) => [instance.id, instance.enabled]),
    [['official', false]]
  )
})

test('Config: an empty fluxer list stays empty', (t) => {
  assert.deepEqual(load(t, valid()).config.fluxer, [])
})

test('Config: an older version is backed up and migrated, then the bot exits 78', (t) => {
  const file = valid()
  file.configVersion = 2.2
  const { exit } = load(t, file)
  assert.equal(exit, 78)
  assert.equal(JSON.parse(fs.readFileSync('config-2.2.json', 'utf8')).configVersion, 2.2, 'the old file is kept')
  assert.equal(saved().configVersion, 2.3)
})

test('Config: a second migration of the same version gets a numbered backup; no version is legacy', (t) => {
  const tmp = useTempCwd()
  t.after(() => tmp.cleanup())
  t.mock.method(process, 'exit', (code) => {
    throw new Exit(code)
  })
  fs.writeFileSync('config-legacy.json', '{}')
  const file = valid()
  delete file.configVersion
  fs.writeFileSync('config.json', JSON.stringify(file))
  assert.throws(() => new Config(fakeLogger()), Exit)
  assert.ok(fs.existsSync('config-legacy-1.json'))
})

test('Config: a newer version exits 78 and leaves the file alone', (t) => {
  const file = valid()
  file.configVersion = 9
  const text = JSON.stringify(file)
  const { exit, records } = load(t, text)
  assert.equal(exit, 78)
  assert.equal(fs.readFileSync('config.json', 'utf8'), text)
  assert.match(fatal(records)[0], /newer than me/)
})

test('Config: every problem is listed, then the bot exits 78; tokens never appear in the log', (t) => {
  const file = valid()
  file.discord.token = ''
  file.discord.channels = [{ ...channel, fileDest: [{ type: 'discord', id: 'd1', sendAll: true, sendPerUser: false }] }]
  file.fluxer = [
    { id: 'Bad Id', enabled: false, origin: 'https://a.example', channels: [] },
    { id: 'self', enabled: true, origin: 'http://b.example', botToken: '', channels: [{ id: '', guildId: '' }] },
    {
      id: 'self',
      enabled: true,
      origin: 'https://c.example',
      botToken: 'fluxer-secret',
      channels: [{ id: 'v1', guildId: 'g1', fileDest: [{ type: 'fluxer', id: 'x', instance: 'off', sendAll: true, sendPerUser: false }] }]
    }
  ]
  const { exit, records } = load(t, file)
  assert.equal(exit, 78)
  const problems = fatal(records).join('\n')
  for (const expected of [
    'fluxer[0].id "Bad Id" must use only a-z, 0-9 and -',
    'fluxer[1].origin "http://b.example" must be an https:// URL',
    'fluxer[1] is enabled but has no botToken',
    'fluxer[1].channels[0] has no id',
    'fluxer[1].channels[0] has no guildId',
    'fluxer[2].id "self" is used twice',
    'fluxer[2].channels[0].fileDest[0] sends to fluxer instance "off", which is not an enabled instance'
  ]) {
    assert.ok(problems.includes(expected), `missing: ${expected}\n${problems}`)
  }
  // Discord is off here (no token, a Fluxer instance enabled), so its channels are not checked
  assert.ok(!problems.includes('discord.channels'))
  assert.ok(!/secret/.test(JSON.stringify(records)))
})

test('Config: a discord destination with Discord off is a problem', (t) => {
  const file = valid()
  file.discord.token = ''
  file.fluxer = [
    {
      id: 'self',
      enabled: true,
      origin: 'https://c.example',
      botToken: 'x',
      channels: [{ id: 'v1', guildId: 'g1', fileDest: [{ type: 'discord', id: 'd1', sendAll: true, sendPerUser: false }] }]
    }
  ]
  const { exit, records } = load(t, file)
  assert.equal(exit, 78)
  assert.match(fatal(records).join('\n'), /fluxer\[0\]\.channels\[0\]\.fileDest\[0\] sends to discord, but Discord is off/)
})

for (const [name, token, fluxerEnabled, expected] of [
  ['with a token', 'x', false, true],
  ['without a token and no Fluxer instance (it then fails on the empty token)', '', false, true],
  ['off without a token when a Fluxer instance is enabled', '', true, false]
]) {
  test(`Config: Discord is ${expected ? 'on' : 'off'} ${name}`, (t) => {
    const file = valid()
    file.discord.token = token
    if (fluxerEnabled) file.fluxer = [{ id: 'self', enabled: true, origin: 'https://c.example', botToken: 'x', channels: [] }]
    assert.equal(load(t, file).config.discordEnabled, expected)
  })
}

test('MessageQueue: messages within the wait are sent together with how long the oldest waited', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const queue = new MessageQueue(1000)
  const batches = []
  queue.on('process', (messages, queueTime) => batches.push([messages, queueTime]))
  queue.addMessage('a')
  t.mock.timers.tick(400)
  queue.addMessage('b')
  t.mock.timers.tick(999)
  assert.deepEqual(batches, [])
  t.mock.timers.tick(1)
  assert.deepEqual(batches, [[['a', 'b'], 1400]])
  t.mock.timers.tick(5000)
  assert.equal(batches.length, 1, 'an empty queue sends nothing')
})

test('MessageQueue: reaching maxSize sends at once', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const queue = new MessageQueue(1000, 3)
  const batches = []
  queue.on('process', (messages) => batches.push(messages))
  for (const message of ['a', 'b', 'c']) queue.addMessage(message)
  assert.deepEqual(batches, [['a', 'b', 'c']])
})

// Found in U1: scheduleProcess is a field made before the constructor sets debounceTime, so the wait is always 1000 ms
test('MessageQueue: the debounce time given is used', { todo: true }, (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'] })
  const queue = new MessageQueue(200)
  const batches = []
  queue.on('process', (messages) => batches.push(messages))
  queue.addMessage('a')
  t.mock.timers.tick(200)
  assert.deepEqual(batches, [['a']])
})

test('FailSafe: true once on the fifth hit within a second of each other, until reset', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failSafe = new FailSafe()
  const hits = () => Array.from({ length: 5 }, () => failSafe.checkHitExceed())
  assert.deepEqual(hits(), [false, false, false, false, true])
  assert.deepEqual(hits(), [false, false, false, false, false], 'only once until reset')
  failSafe.resetError()
  assert.deepEqual(hits(), [false, false, false, false, true])
  assert.equal(failSafe.maxTimes, 5)
})

test('FailSafe: a second without hits starts the count again', (t) => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const failSafe = new FailSafe()
  for (let i = 0; i < 4; i++) failSafe.checkHitExceed()
  t.mock.timers.tick(1000)
  assert.equal(failSafe.checkHitExceed(), false)
})
