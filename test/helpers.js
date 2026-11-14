// Shared setup for the offline tests. They run against dist/ (pnpm build first) and never call the real createApp():
// it reads config.json and may call process.exit.
const path = require('node:path')
const fs = require('node:fs')
const os = require('node:os')
const { spawnSync } = require('node:child_process')

const dist = path.join(__dirname, '..', 'dist')

const noop = () => undefined
function fakeLogger(records = []) {
  const logger = { settings: { minLevel: 3 }, getSubLogger: () => logger }
  for (const level of ['silly', 'trace', 'debug', 'info', 'warn', 'error', 'fatal']) logger[level] = (...args) => records.push([level, ...args])
  return logger
}

// Puts a fake App/App module in require.cache before anything under dist/ requires it, so getApp() returns a fake app;
// returns that app to tweak per test
function stubApp(overrides = {}) {
  const file = path.join(dist, 'App', 'App.js')
  const app = {
    mainLogger: fakeLogger(),
    config: {
      logging: { debug: false, raw: false },
      discord: { token: '', channels: [], admins: [], logErrorsToAdmin: false },
      telegram: { token: '', admins: [], logErrorsToAdmin: false },
      fluxer: []
    },
    discord: undefined,
    fluxer: [],
    telegram: undefined,
    ...overrides
  }
  require.cache[file] = { id: file, filename: file, loaded: true, exports: { getApp: () => app } }
  return app
}

// Replaces a dist module with fake exports, so modules that require it later get the fake
function stubModule(relative, exports) {
  const file = path.join(dist, relative)
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}

// A throwaway cwd with temp/, as src/index.ts makes at startup; returns a cleanup function
function useTempCwd() {
  const previous = process.cwd()
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fx-recorder-test-'))
  fs.mkdirSync(path.join(dir, 'temp'))
  process.chdir(dir)
  return {
    dir,
    cleanup: () => {
      process.chdir(previous)
      fs.rmSync(dir, { recursive: true, force: true })
    }
  }
}

const hasFfmpeg = spawnSync('ffmpeg', ['-version']).status === 0 && spawnSync('ffprobe', ['-version']).status === 0

// s16le stereo 48 kHz: `ms` of a sine on the chosen channels (left/right/both)
function tone(ms, { freq = 440, amp = 8000, channels = 'both' } = {}) {
  const frames = Math.round((48000 * ms) / 1000)
  const buf = Buffer.alloc(frames * 4)
  for (let i = 0; i < frames; i++) {
    const v = Math.round(Math.sin((2 * Math.PI * freq * i) / 48000) * amp)
    if (channels !== 'right') buf.writeInt16LE(v, i * 4)
    if (channels !== 'left') buf.writeInt16LE(v, i * 4 + 2)
  }
  return buf
}

function channel(overrides = {}) {
  return { id: 'chan1', storageKey: 'chan1', fileDest: [], timeZone: 'Asia/Taipei', sendIntervalSecond: 60, ignoreUsers: [], ...overrides }
}

module.exports = { dist, noop, fakeLogger, stubApp, stubModule, useTempCwd, hasFfmpeg, tone, channel }
