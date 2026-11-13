// P0 spike (docs/plans/PLAN-recorder-fluxer.md §5 P0): join one Fluxer voice channel, receive every microphone track
// for FLUXER_SPIKE_SECONDS, write spike-out/<userId>-<connectionId>-<trackSid>.wav and spike-out/events.jsonl, then leave.
// Standalone: not wired into src/index.ts. Run: pnpm build && pnpm spike:fluxer (Ctrl+C ends early and still saves).
// The gateway part follows jimchen5209/Discord-Voice-log (fluxer/f4-voice @ 155dd56, src/Fluxer/Fluxer.ts and Voice/Connection.ts).

import { randomUUID } from 'node:crypto'
import { appendFileSync, closeSync, mkdirSync, openSync, writeSync } from 'node:fs'
import { join } from 'node:path'
import { OpusEncoder } from '@discordjs/opus'
import { Client, Events, GatewayOpcodes, Routes } from '@fluxerjs/core'
import type { MediaStreamTrack, RtpPacket } from 'werift'
import { discoverInstance, isTlsEndpoint, isTrustedEndpoint } from '../Core/Fluxer/Discovery'
import { LiveKitSession as LiveKitReceiver, type RemoteTrackInfo } from '../Core/Fluxer/Voice/LiveKitSession'

const OUT_DIR = 'spike-out'
const JOIN_TIMEOUT_MS = 20 * 1000
const WINDOW_MS = 5000

function env(name: string, fallback?: string) {
  const value = process.env[name] || fallback
  if (!value) throw new Error(`Missing environment variable ${name}`)
  return value
}

const origin = env('FLUXER_ORIGIN')
const botToken = env('FLUXER_BOT_TOKEN')
const guildId = env('FLUXER_GUILD_ID')
const channelId = env('FLUXER_CHANNEL_ID')
const seconds = Number(env('FLUXER_SPIKE_SECONDS', '60'))
if (!origin.startsWith('https://')) throw new Error('FLUXER_ORIGIN must be an https:// origin')
if (!Number.isFinite(seconds) || seconds <= 0) throw new Error('FLUXER_SPIKE_SECONDS must be a positive number')

mkdirSync(OUT_DIR, { recursive: true })
const eventsFile = join(OUT_DIR, 'events.jsonl')
// Never pass a token here: only presence and length go into events
function log(type: string, data: object = {}) {
  appendFileSync(eventsFile, `${JSON.stringify({ t: Math.round(performance.now()), type, ...data })}\n`)
  console.log(type, JSON.stringify(data))
}

// One received track: Opus RTP decoded to 48 kHz stereo s16le into a WAV, with gap statistics
class TrackRecorder {
  private fd: number
  // Raw RTP payloads for offline analysis: [u16 length][u16 seq][u32 timestamp][payload] per packet
  private rawFd: number
  private bytes = 0
  // @discordjs/opus, as Dysnomia uses; opusscript failed on most packets in earlier runs
  private decoder = new OpusEncoder(48000, 2)
  private lastSeq: number | undefined
  private lastTs: number | undefined
  private stats = { packets: 0, lost: 0, reordered: 0, decodeErrors: 0, tsGaps: 0, maxTsGapMs: 0 }
  private window = { packets: 0, maxTsGapMs: 0 }
  private timer: NodeJS.Timeout
  private name: string

  constructor(
    track: MediaStreamTrack,
    private info: RemoteTrackInfo | undefined
  ) {
    this.name = info ? `${info.userId ?? 'unknown'}-${info.connectionId ?? 'unknown'}-${info.trackSid}` : `unmatched-${track.ssrc}`
    this.fd = openSync(join(OUT_DIR, `${this.name}.wav`), 'w')
    writeSync(this.fd, wavHeader(0))
    this.rawFd = openSync(join(OUT_DIR, `${this.name}.rtp`), 'w')
    track.onReceiveRtp.subscribe((packet) => this.onRtp(packet))
    // Packets per window show whether silence or mute still sends packets
    this.timer = setInterval(() => {
      log('rtp-window', { track: this.name, ...this.window })
      this.window = { packets: 0, maxTsGapMs: 0 }
    }, WINDOW_MS)
  }

  // shortcut: packets are decoded in arrival order with no jitter buffer and gaps are not filled with silence, fine for a spike; P4 relies on the mixer's wall clock
  private onRtp(packet: RtpPacket) {
    const { sequenceNumber: seq, timestamp: ts } = packet.header
    this.stats.packets++
    this.window.packets++
    // LiveKit E2EE frames end in [IV][IV length = 12][key index]; these two bytes are format fields, not key material
    if (this.stats.packets === 1) {
      const p = packet.payload
      log('first-payload', { track: this.name, length: p.length, firstByte: p[0], ivLengthByte: p[p.length - 2], keyIndexByte: p[p.length - 1] })
    }
    if (this.lastSeq !== undefined && this.lastTs !== undefined) {
      const seqDelta = (seq - this.lastSeq) & 0xffff
      if (seqDelta === 0 || seqDelta > 0x8000) {
        this.stats.reordered++
        return
      }
      this.stats.lost += seqDelta - 1
      const gapMs = (((ts - this.lastTs) >>> 0) - 960) / 48
      if (gapMs > 0) {
        this.stats.tsGaps++
        this.stats.maxTsGapMs = Math.max(this.stats.maxTsGapMs, gapMs)
        this.window.maxTsGapMs = Math.max(this.window.maxTsGapMs, gapMs)
      }
    }
    this.lastSeq = seq
    this.lastTs = ts
    const head = Buffer.alloc(8)
    head.writeUInt16LE(packet.payload.length, 0)
    head.writeUInt16LE(seq, 2)
    head.writeUInt32LE(ts, 4)
    writeSync(this.rawFd, Buffer.concat([head, packet.payload]))
    try {
      const pcm = this.decoder.decode(packet.payload)
      writeSync(this.fd, pcm)
      this.bytes += pcm.length
    } catch (error) {
      if (this.stats.decodeErrors === 0)
        log('decode-error', { track: this.name, seq, length: packet.payload.length, head: packet.payload.subarray(0, 4).toString('hex'), message: String(error) })
      this.stats.decodeErrors++
    }
  }

  public close() {
    clearInterval(this.timer)
    writeSync(this.fd, wavHeader(this.bytes), 0, 44, 0)
    closeSync(this.fd)
    closeSync(this.rawFd)
    log('track-summary', { track: this.name, userId: this.info?.userId, source: this.info?.source, seconds: this.bytes / 192000, ...this.stats })
  }
}

// 48 kHz, 2 channels, 16-bit PCM
function wavHeader(dataBytes: number) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
  header.write('WAVEfmt ', 8)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(2, 22)
  header.writeUInt32LE(48000, 24)
  header.writeUInt32LE(192000, 28)
  header.writeUInt16LE(4, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(dataBytes, 40)
  return header
}

async function main() {
  const endpoints = await discoverInstance(origin)
  log('discovery', { apiPublic: endpoints.apiPublic, apiCodeVersion: endpoints.apiCodeVersion, voiceEnabled: endpoints.voiceEnabled })
  if (!endpoints.voiceEnabled) log('warning', { message: 'discovery says voice is not enabled' })

  const client = new Client({
    // biome-ignore lint/style/useNamingConvention: Fluxer field name
    instance: { api: endpoints.apiPublic, api_public: endpoints.apiPublic, ...(endpoints.media ? { media: endpoints.media } : {}) },
    suppressIntentWarning: true,
    waitForGuilds: true
  })
  // The SDK sends the token in IDENTIFY to whatever /gateway/bot returns: only wss:// on the origin's host is allowed
  const get = client.rest.get.bind(client.rest)
  client.rest.get = (async (route: string, options?: Parameters<typeof get>[1]) => {
    const result = await get(route, options)
    if (route.split('?')[0] === Routes.gatewayBot()) {
      const url = (result as { url?: unknown } | null)?.url
      if (typeof url !== 'string' || !isTrustedEndpoint(url, origin, 'wss:')) {
        throw Object.assign(new Error(`Gateway ${JSON.stringify(url)} must be a wss:// URL on ${new URL(origin).hostname} or a subdomain`), { isRetryable: false })
      }
    }
    return result
  }) as typeof client.rest.get

  const ready = new Promise<void>((resolve) => client.once(Events.Ready, () => resolve()))
  await client.login(botToken)
  await ready
  log('gateway-ready', { botUserId: client.user?.id })

  // biome-ignore lint/style/useNamingConvention: Fluxer field names
  const sendVoiceState = (data: { channel_id: string | null; connection_id?: string; mutation_id?: string }) => {
    const shardCount = Math.max(client.ws.getShardCount(), 1)
    const shardId = Number((BigInt(guildId) >> 22n) % BigInt(shardCount))
    // biome-ignore lint/style/useNamingConvention: Fluxer field names
    client.sendToGateway(shardId, { op: GatewayOpcodes.VoiceStateUpdate, d: { guild_id: guildId, self_mute: false, self_deaf: false, ...data } })
  }

  const mutationId = randomUUID()
  let connectionId: string | undefined
  let receiver: LiveKitReceiver | undefined
  const recorders: TrackRecorder[] = []

  const server = new Promise<{ endpoint: string; token: string }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('no Voice Server Update within 20 s')), JOIN_TIMEOUT_MS)
    client.on(Events.VoiceStateAck, (ack) => {
      if (ack.mutation_id !== mutationId) return
      log('voice-state-ack', { status: ack.status, connectionId: ack.connection_id, errorCode: ack.error_code, errorMessage: ack.error_message })
      if (ack.connection_id) connectionId = ack.connection_id
      if (ack.status === 'rejected' || ack.error_code) {
        clearTimeout(timer)
        reject(new Error(`join refused: ${ack.error_code ?? ''} ${ack.error_message ?? ''}`.trim()))
      }
    })
    client.on(Events.VoiceServerUpdate, (data) => {
      if (data.guild_id !== guildId) return
      // Another connection of the bot, e.g. one left over from before a restart
      if (connectionId && data.connection_id && data.connection_id !== connectionId) return
      const endpointUrl = data.endpoint ? new URL(/^[a-z]+:\/\//i.test(data.endpoint) ? data.endpoint : `wss://${data.endpoint}`) : undefined
      log('voice-server-update', {
        connectionId: data.connection_id,
        channelId: data.channel_id,
        endpointHost: endpointUrl?.host,
        endpointPath: endpointUrl?.pathname,
        endpointSameHostAsOrigin: endpointUrl ? isTrustedEndpoint(endpointUrl.toString(), origin, endpointUrl.protocol as 'wss:') : undefined,
        hasToken: Boolean(data.token),
        tokenLength: data.token?.length ?? 0,
        hasE2eeKey: Boolean(data.e2ee_key)
      })
      if (data.e2ee_key) log('warning', { message: 'encrypted channel (e2ee_key set): decoded audio is not trustworthy' })
      if (data.connection_id) connectionId = data.connection_id
      if (receiver) return // a token refresh or move after joining; only logged in the spike
      clearTimeout(timer)
      // Without endpoint and token the grant is peer-to-peer, which bots never get, or there is no voice server
      if (!data.endpoint || !data.token) reject(new Error('the grant has no voice server (P2P or no endpoint/token): unsupported'))
      // Any host is allowed; it only gets this connection's voice grant, never the bot token
      else if (!isTlsEndpoint(data.endpoint)) reject(new Error(`voice server ${endpointUrl?.host} must be wss:// or https://`))
      else resolve({ endpoint: data.endpoint, token: data.token })
    })
    client.on(Events.VoiceStateUpdate, (state) => {
      if (state.user_id !== client.user?.id) return
      log('own-voice-state', { connectionId: state.connection_id, channelId: state.channel_id })
    })
  })

  let finished = false
  const finish = async (reason: string) => {
    if (finished) return
    finished = true
    log('finish', { reason, tokenRefreshes: receiver?.tokenRefreshes ?? 0 })
    receiver?.close()
    for (const recorder of recorders) recorder.close()
    if (connectionId) {
      // biome-ignore lint/style/useNamingConvention: Fluxer field names
      sendVoiceState({ channel_id: null, connection_id: connectionId })
      // Give the gateway a moment to send the leave
      await new Promise((resolve) => setTimeout(resolve, 1000))
    }
    await client.destroy().catch(() => undefined)
    process.exit(reason.startsWith('error') ? 1 : 0)
  }
  process.once('SIGINT', () => void finish('SIGINT'))
  process.once('SIGTERM', () => void finish('SIGTERM'))

  // biome-ignore lint/style/useNamingConvention: Fluxer field names
  sendVoiceState({ channel_id: channelId, mutation_id: mutationId })
  try {
    const { endpoint, token } = await server
    receiver = new LiveKitReceiver(endpoint, token)
    receiver.on('event', (type: string, data: object) => log(type, data))
    receiver.on('track', (track: MediaStreamTrack, info: RemoteTrackInfo | undefined) => {
      if (!info) log('warning', { message: 'a track did not match any known track sid; saved as unmatched-<ssrc>.wav' })
      else if (!info.userId) log('warning', { message: `no user id for ${info.identity}` })
      recorders.push(new TrackRecorder(track, info))
    })
    receiver.once('lost', (_fatal: boolean, reason: string) => void finish(`error: LiveKit session lost: ${reason}`))
    await receiver.open()
  } catch (error) {
    // Leave the channel on the way out; messages name URLs and codes, never a token
    log('error', { message: error instanceof Error ? error.message : String(error) })
    await finish('error: join failed')
    return
  }
  log('recording', { seconds })
  setTimeout(() => void finish('time up'), seconds * 1000)
}

main().catch((error) => {
  // Messages here name URLs and codes, never a token
  log('error', { message: error instanceof Error ? error.message : String(error) })
  process.exit(1)
})
