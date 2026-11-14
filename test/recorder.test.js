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

// A leaves and comes back while B stays
test('a returning user gets a new per-user mixer and file, and a new source in the mixed recording', (t) => {
  const recorder = started()
  t.after(() => recorder.stop())
  recorder.storeBuffer(tone(20), 'u1')
  recorder.storeBuffer(tone(20), 'u2')
  const before = mixers(recorder).users.u1
  const [oldSource] = mixers(recorder).recv.getSources('u1')
  recorder.endStream('u1')
  assert.equal(mixers(recorder).users.u1, undefined, 'the stopped mixer is dropped')

  recorder.storeBuffer(tone(20), 'u1')
  const { recv, users } = mixers(recorder)
  assert.notEqual(users.u1, before, 'a new per-user mixer for the returning user')
  assert.equal(saverCalls.filter(([c, user]) => c === 'addUser' && user === 'u1').length, 2)
  // The ended source may still be draining in the mixer; nothing is written into it
  const live = recv.getSources('u1').filter((source) => !source.stream.writableEnded)
  assert.equal(live.length, 1)
  assert.notEqual(live[0], oldSource)
  assert.ok(users.u2, 'the user who stayed keeps recording')
})
