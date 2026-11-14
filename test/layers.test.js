// The layer rules, checked on the sources: recording knows no platform, app or delivery; Discord and Fluxer do not
// import each other; the voice connections leave segments and sending to RecordingSession.
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')

const src = path.join(__dirname, '..', 'src')
const sources = (dir) => fs.readdirSync(path.join(src, dir), { recursive: true }).filter((file) => file.endsWith('.ts')).map((file) => path.join(dir, file))
const importsOf = (file) => [...fs.readFileSync(path.join(src, file), 'utf8').matchAll(/(?:from|import\()\s*'([^']+)'/g)].map((match) => match[1])

test('Recording imports no platform, SDK, app or delivery', () => {
  const forbidden = /(^|\/)(Discord|Fluxer|Telegram|App|Delivery)\/|@projectdysnomia|@fluxerjs|werift|livekit|node-telegram-bot-api/
  for (const file of sources('Recording')) {
    const bad = importsOf(file).filter((spec) => forbidden.test(spec))
    assert.deepEqual(bad, [], file)
  }
})

test('Discord and Fluxer do not import each other', () => {
  for (const [dir, other] of [
    ['Discord', /(^|\/)Fluxer\/|@fluxerjs|werift|livekit/],
    ['Fluxer', /(^|\/)Discord\/|@projectdysnomia/]
  ]) {
    for (const file of sources(dir)) assert.deepEqual(importsOf(file).filter((spec) => other.test(spec)), [], file)
  }
})

test('the voice connections keep no segment timer or sending of their own', () => {
  for (const file of ['Discord/VoiceConnection.ts', 'Fluxer/VoiceConnection.ts']) {
    const text = fs.readFileSync(path.join(src, file), 'utf8')
    for (const word of ['setInterval', 'getFilePeriod', 'readdirSync', 'unlinkSync']) assert.ok(!text.includes(word), `${file} has ${word}`)
  }
})
