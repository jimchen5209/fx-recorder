// One LiveKit signaling session (the /rtc websocket) that subscribes to audio and publishes no media.
// Adapted from jimchen5209/Discord-Voice-log (branch fluxer/f4-voice @ 155dd56, src/Fluxer/Voice/LiveKitSession.ts, AGPL-3.0-only),
// itself adapted from james58899/MusicBot (branch fluxer, Component/FluxerVoice.ts, MIT, Copyright (c) 2017 鄭仁翔).
// Receiving is new here: both references answer the subscriber offer but consume no track.

import { EventEmitter } from 'node:events'
import {
  DataPacket,
  DataPacket_Kind,
  DisconnectReason,
  LeaveRequest,
  LeaveRequest_Action,
  type ParticipantInfo,
  ParticipantInfo_State,
  Ping,
  SessionDescription,
  SignalRequest,
  SignalResponse,
  SignalTarget,
  TrackSource,
  TrackType,
  TrickleRequest,
  UpdateSubscription,
  UserPacket
} from '@livekit/protocol'
import { type MediaStreamTrack, RTCPeerConnection, RTCRtpCodecParameters } from 'werift'
import WebSocket from 'ws'
import { parseEndpoint } from '../Discovery'

const STEP_TIMEOUT_MS = 20 * 1000

// Fluxer clients only screen share in h264/vp9/vp8 while any participant has not advertised what it can decode.
// The bot subscribes to no video, so it claims every codec (payload types/priorities are the client's fixed table).
// From james58899/MusicBot@8d00269 (MIT, Copyright (c) 2017 鄭仁翔), unchanged.
const CODEC_ADVERTISEMENT = new DataPacket({
  kind: DataPacket_Kind.RELIABLE,
  value: {
    case: 'user',
    value: new UserPacket({
      topic: 'fluxer.rtc.codec-negotiation.v1',
      payload: Buffer.from(
        JSON.stringify({
          op: 1,
          d: {
            protocol: 'livekit',
            data: { mode: 'livekit-sfu' },
            codecs: [
              // biome-ignore lint/style/useNamingConvention: Fluxer field names
              { name: 'opus', type: 'audio', payload_type: 120, priority: 1000, encode: true, decode: true },
              ...['AV1', 'H265', 'H264', 'VP9', 'VP8'].map((name, i) => ({
                name,
                type: 'video',
                // biome-ignore lint/style/useNamingConvention: Fluxer field name
                payload_type: [101, 105, 103, 109, 107][i],
                // biome-ignore lint/style/useNamingConvention: Fluxer field name
                rtx_payload_type: [102, 106, 104, 110, 108][i],
                priority: 5000 - i * 1000,
                encode: false,
                decode: true
              }))
            ],
            // biome-ignore lint/style/useNamingConvention: Fluxer field name
            rtc_connection_id: null,
            experiments: []
          }
        })
      )
    })
  }
}).toBinary()

function signalUrl(endpoint: string, token: string) {
  const url = parseEndpoint(endpoint)
  url.protocol = url.protocol === 'http:' || url.protocol === 'ws:' ? 'ws:' : 'wss:'
  url.pathname = `${url.pathname.replace(/\/+$/, '')}/rtc`
  url.search = new URLSearchParams({
    // biome-ignore lint/style/useNamingConvention: LiveKit query parameter
    access_token: token,
    // biome-ignore lint/style/useNamingConvention: LiveKit query parameter
    auto_subscribe: '0',
    sdk: 'js',
    version: '2.23.0',
    protocol: '16',
    // biome-ignore lint/style/useNamingConvention: LiveKit query parameter
    adaptive_stream: '0'
  }).toString()
  return url
}

export interface RemoteTrackInfo {
  trackSid: string
  participantSid: string
  identity: string
  // From the identity user_<userId>_<connectionId>, else the metadata; undefined when neither has it
  userId: string | undefined
  connectionId: string | undefined
  source: string
  muted: boolean
}

// Fluxer identity is user_<userId>_<connectionId>; the metadata carries user_id and connection_id too
export function parseIdentity(identity: string, metadata: string) {
  const match = /^user_(\d+)_(.+)$/.exec(identity)
  if (match) return { userId: match[1], connectionId: match[2] }
  try {
    // biome-ignore lint/style/useNamingConvention: Fluxer field names
    const meta = JSON.parse(metadata) as { user_id?: unknown; connection_id?: unknown }
    return {
      userId: typeof meta.user_id === 'string' ? meta.user_id : undefined,
      connectionId: typeof meta.connection_id === 'string' ? meta.connection_id : undefined
    }
  } catch {
    return { userId: undefined, connectionId: undefined }
  }
}

/**
 * @emits event(type: string, data: object) - anything worth logging; never carries a token
 * @emits track(track: MediaStreamTrack, info: RemoteTrackInfo | undefined) - a subscribed track arrived on the subscriber peer
 * @emits lost(reason: string) - the session ended (once)
 */
export class LiveKitSession extends EventEmitter {
  public lost = false
  public tokenRefreshes = 0
  public readonly tracks = new Map<string, RemoteTrackInfo>()
  private ws: WebSocket | undefined
  private sub: RTCPeerConnection | undefined
  // Publisher peer with no media: it only carries the data channel for the codec advertisement
  private pub: RTCPeerConnection | undefined
  private data: ReturnType<RTCPeerConnection['createDataChannel']> | undefined
  private selfIdentity: string | undefined
  private subscribed = new Set<string>()
  private ssrcToSid = new Map<number, string>()
  private pingTimer: NodeJS.Timeout | undefined
  private endpoint: string
  private token: string
  // false: only joins the room, which makes the bot show up in the channel; tracks are left alone
  private subscribe: boolean

  constructor(endpoint: string, token: string, subscribe = true) {
    super()
    this.endpoint = endpoint
    this.token = token
    this.subscribe = subscribe
  }

  // Resolves on the join response; tracks arrive later through 'track'
  public async open() {
    // The ws package, not Node's WebSocket: Node's drops the server's last "leave" before the close
    const ws = new WebSocket(signalUrl(this.endpoint, this.token))
    this.ws = ws
    const joined = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('LiveKit: timed out waiting for join')), STEP_TIMEOUT_MS)
      this.once('joined', () => {
        clearTimeout(timer)
        resolve()
      })
      this.once('lost', (reason: string) => {
        clearTimeout(timer)
        reject(new Error(`LiveKit: ${reason}`))
      })
    })
    ws.on('message', (data: Buffer) => {
      this.onSignal(SignalResponse.fromBinary(data)).catch((error) => this.emit('event', 'signal-error', { message: String(error) }))
    })
    ws.on('close', (code, reason) => this.markLost(`signal socket closed (${code} ${reason.toString()})`))
    ws.on('error', (error) => this.emit('event', 'socket-error', { message: error.message }))
    await joined
  }

  public close() {
    if (!this.lost) this.send({ case: 'leave', value: new LeaveRequest({ reason: DisconnectReason.CLIENT_INITIATED }) })
    this.lost = true
    clearInterval(this.pingTimer)
    this.ws?.removeAllListeners('close')
    this.ws?.close()
    this.sub?.close().catch(() => undefined)
    this.pub?.close().catch(() => undefined)
  }

  // Data messages are not replayed to late joiners, so this is resent on every participant update
  private advertiseCodecs() {
    if (this.data?.readyState === 'open') this.data.send(Buffer.from(CODEC_ADVERTISEMENT))
  }

  private markLost(reason: string) {
    if (this.lost) return
    this.lost = true
    clearInterval(this.pingTimer)
    this.emit('lost', reason)
  }

  private send(message: SignalRequest['message']) {
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(new SignalRequest({ message }).toBinary())
  }

  // Records every participant's tracks and subscribes to new microphone tracks
  private onParticipants(participants: ParticipantInfo[]) {
    const toSubscribe: string[] = []
    for (const participant of participants) {
      if (participant.identity === this.selfIdentity) continue
      const { userId, connectionId } = parseIdentity(participant.identity, participant.metadata)
      const gone = participant.state === ParticipantInfo_State.DISCONNECTED
      this.emit('event', 'participant', {
        sid: participant.sid,
        identity: participant.identity,
        userId,
        connectionId,
        state: ParticipantInfo_State[participant.state],
        tracks: participant.tracks.map((t) => ({ sid: t.sid, type: TrackType[t.type], source: TrackSource[t.source], muted: t.muted }))
      })
      for (const [sid, info] of this.tracks) {
        if (info.participantSid === participant.sid && (gone || !participant.tracks.some((t) => t.sid === sid))) this.tracks.delete(sid)
      }
      if (gone) continue
      for (const track of participant.tracks) {
        if (track.type !== TrackType.AUDIO) continue
        this.tracks.set(track.sid, {
          trackSid: track.sid,
          participantSid: participant.sid,
          identity: participant.identity,
          userId,
          connectionId,
          source: TrackSource[track.source],
          muted: track.muted
        })
        if (track.source === TrackSource.MICROPHONE && !this.subscribed.has(track.sid)) {
          this.subscribed.add(track.sid)
          toSubscribe.push(track.sid)
        }
      }
    }
    if (toSubscribe.length === 0 || !this.subscribe) return
    this.emit('event', 'subscribe', { trackSids: toSubscribe })
    this.send({ case: 'subscription', value: new UpdateSubscription({ trackSids: toSubscribe, subscribe: true }) })
  }

  // Not fatal when it fails: recording only needs the subscriber
  private async openPublisher(config: ConstructorParameters<typeof RTCPeerConnection>[0]) {
    const pub = new RTCPeerConnection(config)
    this.pub = pub
    pub.onIceCandidate.subscribe((candidate) => {
      if (candidate) this.send({ case: 'trickle', value: new TrickleRequest({ candidateInit: JSON.stringify(candidate.toJSON()), target: SignalTarget.PUBLISHER }) })
    })
    pub.connectionStateChange.subscribe((state) => this.emit('event', 'publisher-state', { state }))
    this.data = pub.createDataChannel('_reliable')
    this.data.onopen = () => this.advertiseCodecs()
    await pub.setLocalDescription(await pub.createOffer())
    this.send({ case: 'offer', value: new SessionDescription({ type: 'offer', sdp: pub.localDescription?.sdp ?? '', id: 1 }) })
  }

  // werift leaves msid off the track (random id, no streamId), so the track sid comes from the offer by SSRC
  private findTrack(track: MediaStreamTrack) {
    const sid = track.ssrc === undefined ? undefined : this.ssrcToSid.get(track.ssrc)
    return sid ? this.tracks.get(sid) : undefined
  }

  private async onSignal({ message }: SignalResponse) {
    switch (message.case) {
      case 'join': {
        const join = message.value
        this.selfIdentity = join.participant?.identity
        const iceServers = join.iceServers.map((server) => ({ urls: server.urls[0], username: server.username || undefined, credential: server.credential || undefined }))
        const codecs = {
          audio: [new RTCRtpCodecParameters({ mimeType: 'audio/opus', clockRate: 48000, channels: 2, parameters: 'minptime=10;useinbandfec=1;stereo=1;sprop-stereo=1' })],
          video: []
        }
        const sub = new RTCPeerConnection({ iceServers, codecs })
        this.sub = sub
        sub.onIceCandidate.subscribe((candidate) => {
          if (candidate) this.send({ case: 'trickle', value: new TrickleRequest({ candidateInit: JSON.stringify(candidate.toJSON()), target: SignalTarget.SUBSCRIBER }) })
        })
        sub.connectionStateChange.subscribe((state) => {
          this.emit('event', 'subscriber-state', { state })
          if (state === 'failed' || state === 'closed') this.markLost(`subscriber peer ${state}`)
        })
        // Per transceiver, not sub.onTrack: LiveKit reuses a freed m-line for the next track with a new SSRC, and werift's peer-level
        // onTrack then repeats the old track (receiver.tracks[0]) while the new SSRC's packets go to a new track only the transceiver reports
        sub.onTransceiverAdded.subscribe((transceiver) =>
          transceiver.onTrack.subscribe((track) => {
            const info = this.findTrack(track)
            this.emit('event', 'track', { msidStream: track.streamId, msidTrack: track.id, ssrc: track.ssrc, codec: track.codec?.mimeType, matched: info?.trackSid })
            this.emit('track', track, info)
          })
        )
        this.pingTimer = setInterval(() => this.send({ case: 'pingReq', value: new Ping({ timestamp: BigInt(Date.now()) }) }), (join.pingInterval || 5) * 1000)
        this.emit('event', 'join', {
          identity: this.selfIdentity,
          subscriberPrimary: join.subscriberPrimary,
          serverVersion: join.serverInfo?.version,
          serverRegion: join.serverInfo?.region,
          otherParticipants: join.otherParticipants.length
        })
        this.emit('joined')
        this.onParticipants(join.otherParticipants)
        this.openPublisher({ iceServers, codecs }).catch((error) => this.emit('event', 'publisher-error', { message: String(error) }))
        break
      }
      case 'update':
        this.advertiseCodecs()
        this.onParticipants(message.value.participants)
        break
      // The server's subscriber offer, again after each subscription change
      case 'offer': {
        const sub = this.sub
        if (!sub) return
        const msid = message.value.sdp.split(/\r?\n/).filter((line) => line.startsWith('a=msid:') || line.startsWith('a=ssrc:'))
        this.emit('event', 'offer', { id: message.value.id, msid })
        // LiveKit: a=ssrc:<ssrc> msid:<participantSid>|<trackSid> <trackSid> (seen on a self-hosted instance, LiveKit 1.12.0)
        for (const line of msid) {
          const match = /^a=ssrc:(\d+) msid:\S+ (\S+)$/.exec(line)
          if (match) this.ssrcToSid.set(Number(match[1]), match[2])
        }
        await sub.setRemoteDescription({ type: 'offer', sdp: message.value.sdp })
        await sub.setLocalDescription(await sub.createAnswer())
        this.send({ case: 'answer', value: new SessionDescription({ type: 'answer', sdp: sub.localDescription?.sdp ?? '', id: message.value.id }) })
        break
      }
      case 'answer':
        await this.pub?.setRemoteDescription({ type: 'answer', sdp: message.value.sdp })
        break
      case 'trickle': {
        const peer = message.value.target === SignalTarget.PUBLISHER ? this.pub : this.sub
        await peer?.addIceCandidate(JSON.parse(message.value.candidateInit))
        break
      }
      case 'mute':
        this.emit('event', 'mute', { sid: message.value.sid, muted: message.value.muted })
        break
      case 'trackUnpublished':
        this.emit('event', 'track-unpublished', { sid: message.value.trackSid })
        break
      case 'refreshToken':
        this.token = message.value
        this.tokenRefreshes++
        this.emit('event', 'refresh-token', { count: this.tokenRefreshes, length: message.value.length })
        break
      case 'leave':
        this.emit('event', 'leave', {
          action: LeaveRequest_Action[message.value.action],
          reason: DisconnectReason[message.value.reason],
          canReconnect: message.value.canReconnect
        })
        this.markLost(`server leave (action ${LeaveRequest_Action[message.value.action]}, reason ${DisconnectReason[message.value.reason]})`)
        break
    }
  }
}
