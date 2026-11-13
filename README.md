# fx_record_ts_bot

## How to use

1. Install [node.js](https://nodejs.org/en/) (Recommend using [nvm](https://github.com/nvm-sh/nvm)), [ffmpeg](https://ffmpeg.org/)
2. Clone this repo
3. Install dependencies with `npm install`
4. Build with `npm run build:prod`
5. Run `npm run installMixer` to install Native C++ Mixer (Optional but recommended)
6. Run `npm run start` the first time to generate `config.json`
7. Create and grab your discord bot token [here](https://discordapp.com/developers/applications/)
8. Fill `config.json`
9. Install `pm2` via `npm install -g pm2` (Optional but recommended)
10. Start the bot with `npm run start` or `pm2 reload ecosystem.config.js`

## Fluxer (official or self-hosted)

Add one entry per Fluxer instance to `fluxer` in `config.json`. Each instance needs its own bot token. A new or upgraded `config.json` has the official instance (`"id": "official"`, `https://fluxer.com`) turned off; set `enabled` to `true` and fill it in to use it.

```json
"fluxer": [
    {
        "id": "main",
        "enabled": true,
        "origin": "https://chat.example.com",
        "botToken": "",
        "admins": [],
        "logErrorsToAdmin": false,
        "channels": [
            {
                "id": "<voice channel id>",
                "guildId": "<guild id>",
                "fileDest": [{ "type": "telegram", "id": "<chat id>", "sendAll": true, "sendPerUser": true }],
                "timeZone": "Asia/Taipei",
                "sendIntervalSecond": 60,
                "ignoreUsers": []
            }
        ]
    }
]
```

- `id`: a name for the instance, using only `a-z`, `0-9` and `-`. It names the instance's folders under `temp/`, so do not change it once used.
- `origin`: the instance's https:// address. The bot token is only sent to this host or its subdomains; the voice server may be on another host.
- `fileDest` can also be `{ "type": "fluxer", "instance": "main", "id": "<text channel id>", ... }` to post recordings to a Fluxer text channel, from Discord or Fluxer channels.
- Bot permissions: View Channel and Connect on the voice channel; View Channel, Send Messages and Attach Files on any Fluxer text channel in `fileDest`; Change Nickname to show 🔴 while recording (optional).
- `admins` (Fluxer user ids) get warnings and errors of that instance's channels by direct message when `logErrorsToAdmin` is `true`, as Discord admins do for Discord channels. Telegram admins get both.
- To run Fluxer only, leave `discord.token` empty. Any `discord` destination is then an error.
- Tell the people in the channel that it is recorded, and do not record where the law requires consent you do not have.
- Only Fluxer's current voice (LiveKit) is supported. Channels with encrypted media (end-to-end encryption on) record noise, and Fluxer's new voice system will need its own support.
