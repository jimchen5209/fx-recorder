import type { DiscordChannel } from '../../Utils/Config'

// A channel being recorded, on any platform. storageKey names its folder under temp/: Discord uses the channel id.
export interface RecordingChannel extends DiscordChannel {
  storageKey: string
}
