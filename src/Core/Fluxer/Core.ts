// One Fluxer instance, official or self-hosted. Gateway handling follows jimchen5209/Discord-Voice-log
// (branch fluxer/f4-voice @ 155dd56, src/Fluxer/Fluxer.ts, AGPL-3.0-only).

import { readFileSync } from 'node:fs'
import { Client, Events, type Guild, Routes } from '@fluxerjs/core'
import type { ILogObj, Logger } from 'tslog'
import type { FluxerInstanceConfig } from '../../Utils/Config'
import { instances } from '../../Utils/Instances'
import { discoverInstance, isTrustedEndpoint } from './Discovery'
import { VoicePresenceTracker, type VoiceStateUpdate } from './Presence'
import { FluxerVoice } from './Voice'
import { FluxerVoiceManager } from './Voice/Manager'

// The voice state fields read here, as the gateway sends them
interface WireVoiceState {
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  channel_id?: string | null
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  user_id?: string
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  connection_id?: string | null
  version?: number
}

function toUpdate(guildId: string, state: WireVoiceState): VoiceStateUpdate | undefined {
  // Without a connection id the update cannot be told apart from the user's other connections
  if (!state.user_id || !state.connection_id) return undefined
  return { guildId, userId: state.user_id, connectionId: state.connection_id, channelId: state.channel_id ?? null, version: state.version }
}

// The SDK fetches /gateway/bot on every connect and sends the token in IDENTIFY to the URL it gets: only wss:// on the
// origin's host or a subdomain is allowed. isRetryable: false makes the SDK give up instead of retrying.
function guardGateway(client: Client, origin: string) {
  const rest = client.rest
  const get = rest.get.bind(rest)
  rest.get = (async (route: string, options?: Parameters<typeof get>[1]) => {
    const result = await get(route, options)
    if (route.split('?')[0] === Routes.gatewayBot()) {
      const url = (result as { url?: unknown } | null)?.url
      if (typeof url !== 'string' || !isTrustedEndpoint(url, origin, 'wss:')) {
        throw Object.assign(new Error(`Gateway ${JSON.stringify(url)} must be a wss:// URL on ${new URL(origin).hostname} or a subdomain`), {
          isRetryable: false
        })
      }
    }
    return result
  }) as typeof rest.get
}

export class Fluxer {
  public readonly instance: FluxerInstanceConfig
  private logger: Logger<ILogObj>
  private client: Client | undefined
  private manager: FluxerVoiceManager | undefined
  private tracker = new VoicePresenceTracker()
  // channelId -> recorded channel, made on the first Ready
  private voices = new Map<string, FluxerVoice>()
  // Set while a Guild Create carrying voice states is handled, see listen()
  private syncedGuildId: string | undefined

  constructor(instance: FluxerInstanceConfig) {
    this.instance = instance
    this.logger = instances.mainLogger.getSubLogger({ name: `Fluxer:${instance.id}` })
  }

  // Discovery, then login. The token only goes to the API and gateway under the configured origin.
  public async start() {
    const origin = this.instance.origin
    const endpoints = await discoverInstance(origin)
    this.logger.info(`Instance ${origin}: API ${endpoints.apiPublic}, api_code_version ${endpoints.apiCodeVersion}`)
    if (endpoints.apiCodeVersion !== 1) this.logger.warn(`api_code_version ${endpoints.apiCodeVersion} is untested; this version was written for 1`)
    if (!endpoints.voiceEnabled) this.logger.warn('The instance says voice is not enabled: recording will not work')

    const client = new Client({
      // biome-ignore lint/style/useNamingConvention: Fluxer field name
      instance: { api: endpoints.apiPublic, api_public: endpoints.apiPublic, ...(endpoints.media ? { media: endpoints.media } : {}) },
      suppressIntentWarning: true,
      // Ready after every guild's snapshot, so the voice states are known before joining
      waitForGuilds: true
    })
    this.client = client
    guardGateway(client, origin)
    this.manager = new FluxerVoiceManager(client, this.logger, (guildId, channelId) => this.tracker.connectionsOf(guildId, client.user?.id ?? '', channelId))
    this.listen(client, this.manager)
    try {
      await client.login(this.instance.botToken)
    } catch (error) {
      await this.disconnect()
      throw error
    }
  }

  public async disconnect() {
    const client = this.client
    if (!client) return
    this.logger.info('Shutting down...')
    // The rest of each recording is sent first; a fluxer destination still needs the client
    await Promise.all([...this.voices.values()].map((voice) => voice.stop()))
    this.voices.clear()
    this.client = undefined
    this.manager?.dispose()
    this.manager = undefined
    await client.destroy().catch(() => undefined)
  }

  // For a fluxer destination: a message, with a file when given. Throws when the instance is not connected or the upload fails.
  public async send(channelId: string, content: string, file?: { name: string; path: string }) {
    const client = this.client
    if (!client?.isReady()) throw new Error(`Fluxer instance ${this.instance.id} is not connected`)
    await client.channels.send(channelId, file ? { content, files: [{ name: file.name, data: readFileSync(file.path) }] } : content)
  }

  private listen(client: Client, manager: FluxerVoiceManager) {
    client.on(Events.Ready, () => {
      this.logger.info(`Logged in as ${client.user?.username} (${client.user?.id})`)
      if (this.voices.size === 0) {
        for (const channel of this.instance.channels) {
          this.voices.set(channel.id, new FluxerVoice(this.instance.id, channel, manager, this.tracker, () => client.user?.id ?? '', this.logger))
        }
      }
      for (const voice of this.voices.values()) voice.update()
    })
    client.on(Events.Error, (error) => this.logger.error(error))
    client.on(Events.ShardError, (shardId, error) => this.logger.error(`Gateway shard ${shardId}:`, error))
    client.on(Events.ShardDisconnect, (shardId, code) => this.logger.warn(`Gateway shard ${shardId} disconnected (${code})`))
    client.on(Events.ShardReconnecting, (shardId) => this.logger.info(`Gateway shard ${shardId} reconnecting`))
    client.on(Events.ShardResumed, (shardId) => this.logger.info(`Gateway shard ${shardId} resumed`))

    // A Guild Create or Guild Sync with voice states sends this first; Guild Create then sends GuildAvailable or GuildCreate
    // in the same handler. One without voice states sends only the latter, which then means nobody is in voice.
    client.on(Events.VoiceStatesSync, ({ guildId, voiceStates }) => {
      this.tracker.rebaseline(
        guildId,
        voiceStates.flatMap((state) => toUpdate(guildId, state) ?? [])
      )
      this.updateGuild(guildId)
      this.syncedGuildId = guildId
      queueMicrotask(() => {
        this.syncedGuildId = undefined
      })
    })
    const snapshot = (guild: Guild) => {
      if (this.syncedGuildId === guild.id) return
      this.tracker.rebaseline(guild.id, [])
      this.updateGuild(guild.id)
    }
    client.on(Events.GuildAvailable, snapshot)
    client.on(Events.GuildCreate, snapshot)
    // Unknown until the next Guild Create: the bot stays where it is meanwhile
    client.on(Events.GuildUnavailable, (guild) => this.tracker.forget(guild.id))
    client.on(Events.GuildDelete, (guild) => this.tracker.forget(guild.id))

    client.on(Events.VoiceStateUpdate, (state) => {
      // Calls have no guild
      if (!state.guild_id) return
      const update = toUpdate(state.guild_id, state)
      const delta = update && this.tracker.apply(update)
      if (!delta) return
      for (const channelId of [delta.left, delta.entered]) {
        const voice = channelId ? this.voices.get(channelId) : undefined
        if (!voice || !channelId) continue
        this.logger.info(`[${channelId}] User ${delta.userId} connection ${delta.connectionId} ${channelId === delta.entered ? 'joined' : 'left'}`)
        voice.update()
      }
    })
  }

  private updateGuild(guildId: string) {
    for (const voice of this.voices.values()) {
      if (voice.guildId === guildId) voice.update()
    }
  }
}
