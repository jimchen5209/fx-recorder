// Recorder routing: sources per user, ignoreUsers, endSource/endStream. RecordSaver is faked, so no FFmpeg.
const test = require('node:test')
const assert = require('node:assert/strict')
const { stubApp, stubModule, channel, tone } = require('./helpers')

stubApp()
const saverCalls = []
class FakeSaver {
  constructor(config) {
    saverCalls.push(['new', config.storageKey])
  }
  setRecvMixer() {}
  setUserMixers() {}
  startSession() {}
  addUser(user) {
    saverCalls.push(['addUser', user])
  }
  removeUser(user) {
    saverCalls.push(['removeUser', user])
  }
  endSession() {
    return { start: 'x', perUserFiles: [] }
  }
}
stubModule('Core/Discord/Recorder/RecordSaver.js', { RecordSaver: FakeSaver })
const log = console.log
console.log = () => undefined // the mixer logs every track
const { Recorder } = require('../dist/Core/Discord/Recorder/Recorder')
test.after(() => {
  console.log = log
})

function started(config = channel()) {
  saverCalls.length = 0
  const recorder = new Recorder(config)
  recorder.startStream()
  return recorder
}
const mixers = (recorder) => ({ recv: recorder.recvMixer, users: recorder.userMixers })

test('single source (Discord): one source per user, found by user id', (t) => {
  const recorder = started()
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'u1')
  recorder.storeBuffer(tone(20), 'u1')
  const { recv, users } = mixers(recorder)
  assert.equal(recv.getSources('u1').length, 1)
  assert.equal(users.u1.getSources('u1').length, 1)
  assert.deepEqual(
    saverCalls.filter(([c]) => c === 'addUser'),
    [['addUser', 'u1']]
  )
})

test('ignoreUsers and an empty user make no mixer', (t) => {
  const recorder = started(channel({ ignoreUsers: ['bot'] }))
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'bot')
  recorder.storeBuffer(tone(20), '')
  assert.equal(mixers(recorder).recv.count(), 0)
  assert.deepEqual(Object.keys(mixers(recorder).users), [])
})

test('endStream ends the source and closes the per-user file', (t) => {
  const recorder = started()
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'u1')
  const source = mixers(recorder).recv.getSources('u1')[0]
  recorder.endStream('u1')
  assert.ok(source.stream.writableEnded)
  assert.deepEqual(saverCalls.at(-1), ['removeUser', 'u1'])
})

test('endSource(user, user) is endStream(user)', (t) => {
  const recorder = started()
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'u1')
  recorder.endSource('u1', 'u1')
  assert.deepEqual(saverCalls.at(-1), ['removeUser', 'u1'])
})

test('two sources of one user: the file ends only with the last one', (t) => {
  const recorder = started()
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'u1', 's1')
  recorder.storeBuffer(tone(20), 'u1', 's2')
  const { recv, users } = mixers(recorder)
  assert.equal(recv.getSources('u1').length, 2)
  assert.equal(users.u1.count(), 2)
  const [first, second] = recv.getSources('u1')
  recorder.endSource('u1', 's1')
  assert.ok(first.stream.writableEnded)
  assert.ok(!second.stream.writableEnded)
  assert.ok(!saverCalls.some(([c]) => c === 'removeUser'))
  recorder.endSource('u1', 's2')
  assert.ok(second.stream.writableEnded)
  assert.deepEqual(saverCalls.at(-1), ['removeUser', 'u1'])
})

test('the saver gets the storageKey, not the channel id', () => {
  saverCalls.length = 0
  new Recorder(channel({ id: 'c9', storageKey: 'fluxer-official-c9' }))
  assert.deepEqual(saverCalls[0], ['new', 'fluxer-official-c9'])
})

// Fails for now: after endStream the stopped mixer stays in the map, so a user who comes back writes into it and
// gets no new per-user file
test('a returning user gets a new per-user mixer and file', { todo: true }, (t) => {
  const recorder = started()
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'u1')
  const before = mixers(recorder).users.u1
  recorder.endStream('u1')
  recorder.storeBuffer(tone(20), 'u1')
  assert.notEqual(mixers(recorder).users.u1, before, 'a new per-user mixer for the returning user')
  assert.equal(saverCalls.filter(([c]) => c === 'addUser').length, 2)
})
