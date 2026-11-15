// Turns Fluxer voice states into joins, leaves and moves of each connection. A user can have several
// connections, in one channel or in several, and each one is reported on its own. Pure: no SDK, no I/O.
// From jimchen5209/Discord-Voice-log (branch fluxer/f4-voice @ 155dd56, src/Fluxer/Presence.ts, AGPL-3.0-only).

export interface VoiceStateUpdate {
  guildId: string
  userId: string
  connectionId: string
  // null when the connection left
  channelId: string | null
  // Only goes up for the participant, but a leave keeps the version of the connection's last state.
  // A live connection ignores older versions; an ended one also ignores its own, so it cannot come back.
  version?: number
}

// One connection's change: left the channel it was in, entered a channel, or both
export interface PresenceDelta {
  guildId: string
  userId: string
  connectionId: string
  left?: string
  entered?: string
}

interface Connection {
  userId: string
  channelId: string
  version?: number
}

// How long the version of an ended connection is kept, so a late update cannot bring it back
const ENDED_TTL_MS = 10 * 60 * 1000

export class VoicePresenceTracker {
  // guildId -> connectionId -> connection
  private guilds = new Map<string, Map<string, Connection>>()
  // `${guildId}:${connectionId}` -> last version and when it ended
  private ended = new Map<string, { version: number; at: number }>()

  // A snapshot (Guild Create or Guild Sync): replaces what is known for the guild and reports nothing
  public rebaseline(guildId: string, states: VoiceStateUpdate[]) {
    const connections = new Map<string, Connection>()
    for (const state of states) {
      if (state.channelId === null) continue
      connections.set(state.connectionId, { userId: state.userId, channelId: state.channelId, version: state.version })
    }
    this.guilds.set(guildId, connections)
  }

  // The guild was lost or became unavailable: nothing is known until the next snapshot
  public forget(guildId: string) {
    this.guilds.delete(guildId)
  }

  // Users with at least one connection in the channel; undefined when the guild is not known (no snapshot yet, or lost)
  public usersIn(guildId: string, channelId: string): string[] | undefined {
    const connections = this.guilds.get(guildId)
    if (!connections) return undefined
    const users = new Set<string>()
    for (const connection of connections.values()) {
      if (connection.channelId === channelId) users.add(connection.userId)
    }
    return [...users]
  }

  // Connection ids the user has in the guild, or in one channel of it
  public connectionsOf(guildId: string, userId: string, channelId?: string): string[] {
    return [...(this.guilds.get(guildId) ?? [])]
      .filter(([, connection]) => connection.userId === userId && (channelId === undefined || connection.channelId === channelId))
      .map(([id]) => id)
  }

  // Undefined when the connection did not change channel: a duplicate, a stale update, a mute,
  // or the end of a connection that was never seen
  public apply(update: VoiceStateUpdate, now = Date.now()): PresenceDelta | undefined {
    this.pruneEnded(now)
    const { guildId, userId, connectionId, channelId, version } = update
    let connections = this.guilds.get(guildId)
    if (!connections) {
      connections = new Map()
      this.guilds.set(guildId, connections)
    }
    const endedKey = `${guildId}:${connectionId}`
    const previous = connections.get(connectionId)
    if (version !== undefined) {
      if (previous?.version !== undefined && version < previous.version) return
      const ended = previous ? undefined : this.ended.get(endedKey)
      if (ended && version <= ended.version) return
    }

    if (channelId === null) {
      connections.delete(connectionId)
      if (version !== undefined) this.ended.set(endedKey, { version, at: now })
    } else {
      connections.set(connectionId, { userId, channelId, version })
      this.ended.delete(endedKey)
    }

    if (channelId === (previous?.channelId ?? null)) return
    return { guildId, userId, connectionId, left: previous?.channelId, entered: channelId ?? undefined }
  }

  private pruneEnded(now: number) {
    for (const [key, { at }] of this.ended) {
      if (now - at > ENDED_TTL_MS) this.ended.delete(key)
    }
  }
}
