// LiveKitSession against a fake LiveKit signal server on 127.0.0.1 (the ws package, protobuf from @livekit/protocol):
// joining, subscribing to microphones only, the SSRC to track map, tracks ending, token refresh, server leave and
// socket loss, and that the access token never shows up in the session's events.
const test = require('node:test')
const assert = require('node:assert/strict')
const { once } = require('node:events')
const { WebSocketServer } = require('ws')
const lk = require('@livekit/protocol')
const { LiveKitSession } = require('../dist/Fluxer/Voice/LiveKitSession')

const TOKEN = 'secret-access-token'
const mic = (sid) => new lk.TrackInfo({ sid, type: lk.TrackType.AUDIO, source: lk.TrackSource.MICROPHONE })
const participant = (sid, identity, tracks, state = lk.ParticipantInfo_State.ACTIVE) => new lk.ParticipantInfo({ sid, identity, tracks, state })
const response = (kase, value) => new lk.SignalResponse({ message: { case: kase, value } }).toBinary()

// A server that takes one connection; requests are what the session sent, decoded
async function serve(t) {
  const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(wss, 'listening')
  const requests = []
  const state = { requests }
  state.connected = new Promise((resolve) => {
    wss.on('connection', (socket, request) => {
      state.socket = socket
      state.url = new URL(request.url, 'ws://x')
      socket.on('message', (data) => requests.push(lk.SignalRequest.fromBinary(data).message))
      resolve(socket)
    })
  })
  state.endpoint = `ws://127.0.0.1:${wss.address().port}`
  t.after(() => wss.close())
  return state
}

const others = [
  participant('PA2', 'user_2_c2', [mic('TR1'), new lk.TrackInfo({ sid: 'TR2', type: lk.TrackType.AUDIO, source: lk.TrackSource.SCREEN_SHARE_AUDIO })]),
  participant('PA3', 'user_3_c3', [new lk.TrackInfo({ sid: 'TR3', type: lk.TrackType.VIDEO, source: lk.TrackSource.CAMERA })])
]

// An open session with two others in the room; events are collected
async function joined(t) {
  const server = await serve(t)
  const session = new LiveKitSession(server.endpoint, TOKEN)
  const events = []
  session.on('event', (type, data) => events.push([type, data]))
  t.after(() => session.close())
  const opening = session.open()
  const socket = await server.connected
  socket.send(response('join', new lk.JoinResponse({ participant: participant('PA1', 'user_1_me', []), otherParticipants: others, pingInterval: 5, pingTimeout: 15 })))
  await opening
  return { server, socket, session, events }
}
const until = async (check) => {
  for (let i = 0; i < 100 && !check(); i++) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(check(), 'timed out')
}

test('open: connects to <endpoint>/rtc with the token and resolves on join', async (t) => {
  const { server } = await joined(t)
  assert.equal(server.url.pathname, '/rtc')
  assert.equal(server.url.searchParams.get('access_token'), TOKEN)
  assert.equal(server.url.searchParams.get('auto_subscribe'), '0')
})

test('join: microphone tracks of others are subscribed; screen share audio is known but not subscribed; video is ignored', async (t) => {
  const { server, session } = await joined(t)
  await until(() => server.requests.some((m) => m.case === 'subscription'))
  const subscription = server.requests.find((m) => m.case === 'subscription').value
  assert.deepEqual(subscription.trackSids, ['TR1'])
  assert.equal(subscription.subscribe, true)
  assert.deepEqual([...session.tracks.keys()], ['TR1', 'TR2'])
  assert.deepEqual(session.tracks.get('TR1'), { trackSid: 'TR1', participantSid: 'PA2', identity: 'user_2_c2', userId: '2', connectionId: 'c2', source: 'MICROPHONE', muted: false })
})

test('offer: the SSRC to track map comes from the a=ssrc msid lines', async (t) => {
  const { socket, session, events } = await joined(t)
  const sdp = ['v=0', 'a=ssrc:111 msid:PA2|TR1 TR1', 'a=ssrc:111 cname:PA2|TR1', 'a=msid:PA2|TR1 TR1'].join('\r\n')
  socket.send(response('offer', new lk.SessionDescription({ type: 'offer', sdp, id: 7 })))
  await until(() => events.some(([type]) => type === 'offer'))
  assert.equal(session.findTrack({ ssrc: 111 })?.trackSid, 'TR1')
  assert.equal(session.findTrack({ ssrc: 222 }), undefined)
})

test('a track dropped from an update, an unpublished track, or a participant who left ends that track once', async (t) => {
  const { socket, session } = await joined(t)
  const ended = []
  session.on('trackEnded', (info) => ended.push(info.trackSid))
  socket.send(response('update', new lk.ParticipantUpdate({ participants: [participant('PA2', 'user_2_c2', [mic('TR1')])] })))
  await until(() => ended.length === 1)
  socket.send(response('trackUnpublished', new lk.TrackUnpublishedResponse({ trackSid: 'TR1' })))
  socket.send(response('trackUnpublished', new lk.TrackUnpublishedResponse({ trackSid: 'TR1' })))
  await until(() => ended.length === 2)
  socket.send(response('update', new lk.ParticipantUpdate({ participants: [participant('PA4', 'user_4_c4', [mic('TR4')])] })))
  socket.send(response('update', new lk.ParticipantUpdate({ participants: [participant('PA4', 'user_4_c4', [], lk.ParticipantInfo_State.DISCONNECTED)] })))
  await until(() => ended.length === 3)
  await new Promise((resolve) => setTimeout(resolve, 50))
  assert.deepEqual(ended, ['TR2', 'TR1', 'TR4'])
  assert.equal(session.tracks.size, 0)
})

test('refresh token: kept for reconnecting, and only its length goes into events', async (t) => {
  const { socket, session, events } = await joined(t)
  socket.send(response('refreshToken', 'new-secret-token'))
  await until(() => session.token === 'new-secret-token')
  assert.equal(session.tokenRefreshes, 1)
  assert.deepEqual(events.find(([type]) => type === 'refresh-token')[1], { count: 1, length: 16 })
  assert.ok(!JSON.stringify(events).includes('secret'), 'no token in events')
})

for (const [name, leave, fatal] of [
  ['removed for good (disconnect, cannot reconnect)', { action: lk.LeaveRequest_Action.DISCONNECT, canReconnect: false }, true],
  ['asked to reconnect', { action: lk.LeaveRequest_Action.RECONNECT, canReconnect: true }, false]
]) {
  test(`server leave: ${name} is lost${fatal ? ', fatally' : ''}, once`, async (t) => {
    const { socket, session } = await joined(t)
    const lost = []
    session.on('lost', (isFatal, reason) => lost.push([isFatal, reason]))
    socket.send(response('leave', new lk.LeaveRequest(leave)))
    await until(() => lost.length === 1)
    socket.close()
    await new Promise((resolve) => setTimeout(resolve, 50))
    assert.equal(lost.length, 1)
    assert.equal(lost[0][0], fatal)
    assert.ok(session.lost)
  })
}

test('the socket closing is a lost session, not fatal', async (t) => {
  const { socket, session } = await joined(t)
  const lost = []
  session.on('lost', (isFatal, reason) => lost.push([isFatal, reason]))
  socket.close(1001, 'bye')
  await until(() => lost.length === 1)
  assert.equal(lost[0][0], false)
  assert.match(lost[0][1], /signal socket closed \(1001 bye\)/)
})

test('open fails when the socket closes before the join', async (t) => {
  const server = await serve(t)
  const session = new LiveKitSession(server.endpoint, TOKEN)
  t.after(() => session.close())
  const opening = session.open()
  ;(await server.connected).close()
  await assert.rejects(opening, /LiveKit: signal socket closed/)
})

test('close sends a leave and reports no loss', async (t) => {
  const { server, session } = await joined(t)
  const lost = []
  session.on('lost', () => lost.push(1))
  session.close()
  await until(() => server.requests.some((m) => m.case === 'leave'))
  assert.deepEqual(lost, [])
})
