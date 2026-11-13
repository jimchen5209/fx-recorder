// From jimchen5209/Discord-Voice-log (branch fluxer/f4-voice @ 155dd56, src/Fluxer/Discovery.ts and Voice/LiveKitSession.ts, AGPL-3.0-only).
// Instance discovery (GET /.well-known/fluxer) and the rule for where the bot token may go.
// Endpoints are used as the document gives them, path included; nothing is built from the origin.

const DISCOVERY_PATH = '/.well-known/fluxer'
const DISCOVERY_TIMEOUT_MS = 10 * 1000

export interface FluxerEndpoints {
  // REST base for bots, e.g. https://fluxer.com/api
  apiPublic: string
  // Media host for avatar URLs, when the document has one
  media?: string
  apiCodeVersion: number
  voiceEnabled: boolean
}

// The token only goes to the configured origin's host or a subdomain of it, over https/wss
export function isTrustedEndpoint(endpoint: string, origin: string, protocol: 'https:' | 'wss:') {
  let url: URL
  try {
    url = new URL(endpoint)
  } catch {
    return false
  }
  const host = new URL(origin).hostname
  return url.protocol === protocol && (url.hostname === host || url.hostname.endsWith(`.${host}`))
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Sends no token and follows no redirect. Errors name the URL but never a token.
export async function discoverInstance(origin: string): Promise<FluxerEndpoints> {
  const url = new URL(DISCOVERY_PATH, origin).toString()
  const response = await fetch(url, {
    redirect: 'error',
    signal: AbortSignal.timeout(DISCOVERY_TIMEOUT_MS),
    headers: { accept: 'application/json' }
  })
  if (!response.ok) throw new Error(`Instance discovery ${url} answered HTTP ${response.status}`)
  const document: unknown = await response.json()
  if (!isRecord(document) || !isRecord(document.endpoints)) throw new Error(`Instance discovery ${url} has no endpoints`)

  const apiPublic = document.endpoints.api_public
  if (typeof apiPublic !== 'string' || !isTrustedEndpoint(apiPublic, origin, 'https:')) {
    throw new Error(`Instance discovery ${url}: endpoints.api_public ${JSON.stringify(apiPublic)} must be an https:// URL on ${new URL(origin).hostname} or a subdomain`)
  }
  const media = document.endpoints.media
  const features = isRecord(document.features) ? document.features : {}
  return {
    apiPublic,
    media: typeof media === 'string' && media.startsWith('https://') ? media : undefined,
    apiCodeVersion: typeof document.api_code_version === 'number' ? document.api_code_version : 0,
    voiceEnabled: features.voice_enabled === true
  }
}

// The voice server from Voice Server Update may be on any host: it only gets that connection's grant, never the bot token.
// It must use TLS; a scheme-less endpoint is wss://, and the path is kept (self-hosted: e.g. /livekit).
export function parseEndpoint(endpoint: string) {
  return new URL(/^[a-z]+:\/\//i.test(endpoint) ? endpoint : `wss://${endpoint}`)
}

export function isTlsEndpoint(endpoint: string) {
  try {
    return ['wss:', 'https:'].includes(parseEndpoint(endpoint).protocol)
  } catch {
    return false
  }
}
