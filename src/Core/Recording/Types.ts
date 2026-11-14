// A channel being recorded, on any platform: the fields recording uses. A platform's channel config has them all.
export interface RecordingChannel {
  id: string
  // Names its folder under temp/: Discord uses the channel id, Fluxer fluxer-<instance>-<channel>
  storageKey: string
  timeZone: string
  sendIntervalSecond: number
  ignoreUsers: string[]
}
