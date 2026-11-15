// The gateway side of Fluxer voice: joining and leaving channels with Voice State Update (opcode 4), one connection per channel.
// Adapted from jimchen5209/Discord-Voice-log (branch fluxer/f4-voice @ 155dd56, src/Fluxer/Voice/Connection.ts, AGPL-3.0-only),
// itself from james58899/MusicBot (branch fluxer, Component/FluxerVoice.ts, MIT, Copyright (c) 2017 鄭仁翔). Playback is left out;
// sessions are per channel, since Fluxer lets the bot be in several channels of a guild.

import { randomUUID } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { type Client, type ClientEventListener, type ClientEventName, Events, GatewayOpcodes } from '@fluxerjs/core'
import type { ILogObj, Logger } from 'tslog'
import { isTlsEndpoint } from '../Discovery'

const JOIN_TIMEOUT_MS = 20 * 1000

// Voice State Update (opcode 4); mutation_id is echoed in Voice State Ack
interface VoiceStateData {
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  channel_id: string | null
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  connection_id?: string
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  mutation_id?: string
}

interface VoiceServerData {
  token?: string | null
  endpoint?: string | null
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  connection_id?: string | null
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  channel_id?: string | null
  // biome-ignore lint/style/useNamingConvention: Fluxer field name
  e2ee_key?: string | null
}

// What the LiveKit side needs; token is a secret: never log it
export interface VoiceGrant {
  endpoint: string
  token: string
  connectionId: string
  encrypted: boolean
}

export class FluxerVoiceManager {
  private client: Client
  private logger: Logger<ILogObj>
  // The bot's connection ids in a channel, as the gateway last said
  private ownConnections: (guildId: string, channelId: string) => string[]
  // channelId -> connection
  private connections = new Map<string, FluxerVoiceConnection>()
  private unsubscribe: (() => void)[] = []

  constructor(client: Client, logger: Logger<ILogObj>, ownConnections: (guildId: string, channelId: string) => string[]) {
    this.client = client
    this.logger = logger
    this.ownConnections = ownConnections
    this.listen(Events.VoiceStateAck, (ack) => {
      for (const connection of this.connections.values()) {
        if (ack.mutation_id && connection.mutationId === ack.mutation_id) connection.onAck(ack.connection_id ?? undefined, ack.status, ack.error_code, ack.error_message)
      }
    })
    this.listen(Events.VoiceServerUpdate, (data) => {
      // By connection id; while joining, the Ack may not have come (none was seen in testing), so by channel
      const connection =
        [...this.connections.values()].find((c) => c.connectionId && c.connectionId === data.connection_id) ?? (data.channel_id ? this.connections.get(data.channel_id) : undefined)
      // Otherwise another connection of the bot, e.g. one left over from before a restart
      if (connection?.mutationId || (connection?.connectionId && connection.connectionId === data.connection_id)) connection.onServer(data)
    })
    this.listen(Events.VoiceStateUpdate, (state) => {
      if (!state.guild_id || state.user_id !== client.user?.id || !state.connection_id) return
      const connection = [...this.connections.values()].find((c) => c.connectionId === state.connection_id)
      // Disconnected or moved away by a moderator, or the channel was deleted
      if (connection && state.channel_id !== connection.channelId) connection.onRemoved(state.channel_id !== null)
    })
  }

  public join(guildId: string, channelId: string) {
    this.connections.get(channelId)?.leave()
    // Connections of the bot in this channel that no session owns, e.g. from before a restart
    for (const connectionId of this.ownConnections(guildId, channelId)) this.sendLeave(guildId, connectionId)
    const connection = new FluxerVoiceConnection(this, guildId, channelId, this.logger)
    this.connections.set(channelId, connection)
    connection.join()
    return connection
  }

  public release(connection: FluxerVoiceConnection) {
    if (this.connections.get(connection.channelId) === connection) this.connections.delete(connection.channelId)
  }

  public sendJoin(guildId: string, channelId: string, mutationId: string) {
    // biome-ignore lint/style/useNamingConvention: Fluxer field names
    this.sendVoiceState(guildId, { channel_id: channelId, mutation_id: mutationId })
  }

  public sendLeave(guildId: string, connectionId: string) {
    // biome-ignore lint/style/useNamingConvention: Fluxer field names
    this.sendVoiceState(guildId, { channel_id: null, connection_id: connectionId })
  }

  // On the shard that has the guild
  private sendVoiceState(guildId: string, data: VoiceStateData) {
    const shardCount = Math.max(this.client.ws.getShardCount(), 1)
    const shardId = Number((BigInt(guildId) >> 22n) % BigInt(shardCount))
    this.client.sendToGateway(shardId, {
      op: GatewayOpcodes.VoiceStateUpdate,
      // biome-ignore lint/style/useNamingConvention: Fluxer field names
      d: { guild_id: guildId, self_mute: false, self_deaf: false, ...data }
    })
  }

  // Leaves every channel; the client is not used afterwards
  public dispose() {
    for (const connection of [...this.connections.values()]) connection.leave()
    for (const unsubscribe of this.unsubscribe) unsubscribe()
    this.unsubscribe = []
  }

  private listen<E extends ClientEventName>(event: E, handler: ClientEventListener<E>) {
    this.client.on(event, handler)
    this.unsubscribe.push(() => this.client.off(event, handler))
  }
}

/**
 * The bot's gateway connection in one voice channel.
 * @emits grant(grant: VoiceGrant) - a voice server grant: the first, and again on a new grant for the connection
 * @emits closed(reason: string) - the connection ended (once)
 */
export class FluxerVoiceConnection extends EventEmitter {
  public readonly guildId: string
  public readonly channelId: string
  // Set while a join waits for its grant
  public mutationId: string | undefined
  public connectionId: string | undefined
  private manager: FluxerVoiceManager
  private logger: Logger<ILogObj>
  private closed = false
  private joinTimer: NodeJS.Timeout | undefined

  constructor(manager: FluxerVoiceManager, guildId: string, channelId: string, logger: Logger<ILogObj>) {
    super()
    this.manager = manager
    this.guildId = guildId
    this.channelId = channelId
    this.logger = logger
  }

  public join() {
    this.logger.info('Joining...')
    this.mutationId = randomUUID()
    this.manager.sendJoin(this.guildId, this.channelId, this.mutationId)
    this.joinTimer = setTimeout(() => this.close('the voice server did not answer the join'), JOIN_TIMEOUT_MS)
  }

  public leave() {
    this.close('left')
  }

  public onAck(connectionId: string | undefined, status: string | undefined, errorCode: string | undefined, errorMessage: string | undefined) {
    if (connectionId) this.connectionId = connectionId
    if (status === 'rejected' || errorCode) this.close(`the join was refused: ${errorCode ?? ''} ${errorMessage ?? ''}`.trim())
  }

  public onServer(data: VoiceServerData) {
    if (this.closed) return
    if (data.connection_id) this.connectionId = data.connection_id
    // A grant without endpoint and token is peer-to-peer, which bots never get, or no voice server
    if (!data.endpoint || !data.token) {
      this.close('the grant has no voice server')
      return
    }
    if (!isTlsEndpoint(data.endpoint)) {
      this.close(`voice server ${JSON.stringify(data.endpoint)} must be a wss:// or https:// URL`)
      return
    }
    if (!this.connectionId) {
      this.close('the grant has no connection id')
      return
    }
    clearTimeout(this.joinTimer)
    this.mutationId = undefined
    const encrypted = Boolean(data.e2ee_key)
    this.logger.info(`Voice server granted for connection ${this.connectionId}${encrypted ? ' (encrypted media)' : ''}`)
    if (encrypted) this.logger.warn('The channel encrypts call media, which is not supported: recordings would be noise')
    this.emit('grant', { endpoint: data.endpoint, token: data.token, connectionId: this.connectionId, encrypted } satisfies VoiceGrant)
  }

  // moved: into another channel, so the connection is left on purpose; otherwise it is already gone
  public onRemoved(moved: boolean) {
    this.close(moved ? 'moved to another channel by a moderator' : 'removed from the voice channel', moved)
  }

  private close(reason: string, sendLeave = true) {
    if (this.closed) return
    this.closed = true
    clearTimeout(this.joinTimer)
    this.mutationId = undefined
    if (sendLeave && this.connectionId) this.manager.sendLeave(this.guildId, this.connectionId)
    this.manager.release(this)
    this.logger.info(`Voice connection ${this.connectionId ?? '(none)'} ended: ${reason}`)
    this.emit('closed', reason)
  }
}
