// Fluxer pure logic: presence tracking, trusted endpoints, identity parsing, TrackReceiver decoding.
// No network: TrackReceiver gets a fake track fed with Opus packets encoded here from a synthetic tone.
const test = require('node:test')
const assert = require('node:assert/strict')
const { stubInstances, fakeLogger, tone } = require('./helpers')

stubInstances()
const { VoicePresenceTracker } = require('../dist/Core/Fluxer/Presence')
const { isTrustedEndpoint } = require('../dist/Core/Fluxer/Discovery')
const { parseIdentity } = require('../dist/Core/Fluxer/Voice/LiveKitSession')

const g = 'g1'
const state = (userId, connectionId, channelId, version) => ({ guildId: g, userId, connectionId, channelId, version })

test('presence: unknown guild is undefined, a user with two connections counts once', () => {
  const tracker = new VoicePresenceTracker()
  assert.equal(tracker.usersIn(g, 'c1'), undefined)
  tracker.rebaseline(g, [state('u1', 'a', 'c1'), state('u1', 'b', 'c1'), state('u2', 'c', 'c2'), state('u3', 'd', null)])
  assert.deepEqual(tracker.usersIn(g, 'c1'), ['u1'])
  assert.deepEqual(tracker.connectionsOf(g, 'u1', 'c1').sort(), ['a', 'b'])
})

test('presence: join, switch and leave are reported per connection; duplicates are not', () => {
  const tracker = new VoicePresenceTracker()
  tracker.rebaseline(g, [])
  assert.deepEqual(tracker.apply(state('u1', 'a', 'c1', 1)), { guildId: g, userId: 'u1', connectionId: 'a', left: undefined, entered: 'c1' })
  assert.equal(tracker.apply(state('u1', 'a', 'c1', 2)), undefined, 'same channel (mute etc.)')
  assert.deepEqual(tracker.apply(state('u1', 'a', 'c2', 3)), { guildId: g, userId: 'u1', connectionId: 'a', left: 'c1', entered: 'c2' })
  assert.deepEqual(tracker.apply(state('u1', 'a', null, 3)), { guildId: g, userId: 'u1', connectionId: 'a', left: 'c2', entered: undefined })
  assert.deepEqual(tracker.usersIn(g, 'c2'), [])
})

test('presence: older versions are ignored, an ended connection cannot come back until the TTL', () => {
  const tracker = new VoicePresenceTracker()
  tracker.rebaseline(g, [])
  tracker.apply(state('u1', 'a', 'c1', 5), 0)
  assert.equal(tracker.apply(state('u1', 'a', 'c2', 4), 0), undefined)
  tracker.apply(state('u1', 'a', null, 5), 0)
  assert.equal(tracker.apply(state('u1', 'a', 'c1', 5), 1000), undefined, 'late update of the ended connection')
  assert.ok(tracker.apply(state('u1', 'a', 'c1', 5), 11 * 60 * 1000), 'after the ended TTL')
})

test('presence: forget makes the guild unknown again', () => {
  const tracker = new VoicePresenceTracker()
  tracker.rebaseline(g, [state('u1', 'a', 'c1')])
  tracker.forget(g)
  assert.equal(tracker.usersIn(g, 'c1'), undefined)
})

test('trusted endpoint: the origin host or a subdomain, with the right scheme', () => {
  const origin = 'https://chat.example.org'
  assert.ok(isTrustedEndpoint('wss://gateway.chat.example.org/?v=1', origin, 'wss:'))
  assert.ok(isTrustedEndpoint('https://chat.example.org/api', origin, 'https:'))
  assert.ok(!isTrustedEndpoint('ws://gateway.chat.example.org', origin, 'wss:'))
  assert.ok(!isTrustedEndpoint('wss://evilchat.example.org', origin, 'wss:'))
  assert.ok(!isTrustedEndpoint('wss://chat.example.org.evil.com', origin, 'wss:'))
  assert.ok(!isTrustedEndpoint('not a url', origin, 'wss:'))
})

test('identity: user_<id>_<connection>, else metadata, else nothing', () => {
  assert.deepEqual(parseIdentity('user_123_abc_def', ''), { userId: '123', connectionId: 'abc_def' })
  assert.deepEqual(parseIdentity('bot', JSON.stringify({ user_id: '9', connection_id: 'x' })), { userId: '9', connectionId: 'x' })
  assert.deepEqual(parseIdentity('bot', '{bad'), { userId: undefined, connectionId: undefined })
})

// An optional dependency; Fluxer support needs it
let OpusEncoder
try {
  ;({ OpusEncoder } = require('@discordjs/opus'))
} catch {
  // skipped below
}
const skipOpus = !OpusEncoder && '@discordjs/opus not installed'

test('TrackReceiver: 20 ms and 10 ms Opus frames and the 3-byte silence frame decode to 48 kHz stereo s16le', { skip: skipOpus }, () => {
  const { TrackReceiver } = require('../dist/Core/Fluxer/Voice/TrackReceiver')
  const encoder = new OpusEncoder(48000, 2)
  let onRtp
  const track = { ssrc: 1, onReceiveRtp: { subscribe: (fn) => (onRtp = fn) } }
  const stored = []
  const recorder = { storeBuffer: (pcm, user, sourceId) => stored.push({ bytes: pcm.length, user, sourceId }) }
  let active = true
  new TrackReceiver(track, { trackSid: 'TR_1', connectionId: 'conn', userId: 'u1-conn', participantSid: 'PA', identity: 'user_1_conn', source: 'MICROPHONE', muted: false }, recorder, () => active, fakeLogger())
  const packet = (payload, timestamp) => ({ header: { timestamp }, payload })

  onRtp(packet(encoder.encode(tone(20)), 0))
  onRtp(packet(encoder.encode(tone(10)), 960))
  onRtp(packet(Buffer.from([0xf8, 0xff, 0xfe]), 1440))
  active = false
  onRtp(packet(encoder.encode(tone(20)), 2400))

  assert.deepEqual(stored, [
    { bytes: 3840, user: 'u1-conn', sourceId: 'conn:TR_1' },
    { bytes: 1920, user: 'u1-conn', sourceId: 'conn:TR_1' },
    { bytes: 3840, user: 'u1-conn', sourceId: 'conn:TR_1' }
  ])
})

test('TrackReceiver: an undecodable packet is dropped and logged, not thrown', { skip: skipOpus }, () => {
  const { TrackReceiver } = require('../dist/Core/Fluxer/Voice/TrackReceiver')
  let onRtp
  const records = []
  const stored = []
  new TrackReceiver(
    { ssrc: 1, onReceiveRtp: { subscribe: (fn) => (onRtp = fn) } },
    { trackSid: 'T', connectionId: 'c', userId: 'u', participantSid: 'P', identity: 'x', source: 'MICROPHONE', muted: false },
    { storeBuffer: () => stored.push(1) },
    () => true,
    fakeLogger(records)
  )
  // Code-3 packet with a frame count of 0: corrupt. (An empty payload is not: Opus conceals it as a lost packet.)
  onRtp({ header: { timestamp: 0 }, payload: Buffer.from([0x03, 0x00]) })
  assert.equal(stored.length, 0)
  assert.equal(records.filter(([level]) => level === 'warn').length, 1)
})
