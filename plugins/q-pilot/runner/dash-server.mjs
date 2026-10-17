// The q-pilot Dashboard: one loopback server per project that every run reports to. Runners register their sessions
// over /rpc (runner token) and the person's tab reads them over /api (page token); the dashboard is a broker and a
// store, the runner stays the owner of the browser. Ask Claude and Save as default are answered through the mod: the
// dashboard's stderr carries the same ask and settings-save marks a runner's would.
// `node dash-server.mjs --root <root> [--port n]` starts it; the mod spawns it once per Claude session.
// A run never depends on it: the runner's client goes on without a dashboard that is gone (dash-client.mjs).
import { createServer, get as httpGet } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { spawn } from 'node:child_process'
import { basename, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { redact } from './redact.mjs'
import { ASK_MODELS, askViaMod, createAsker } from './ask.mjs'
import { saveViaMod } from './settings-save.mjs'
import { configViaMod } from './config-bridge.mjs'
import { ACTIONS, SAVE_KEYS, SAVE_SCOPES, VISION_MODELS, VISION_MODES, GROUP_ID, summaryOf } from './session.mjs'
import { listRuns, loadFrame } from './history.mjs'
import { resolvePlaywright } from './driver.mjs'

export const DEFAULT_PORT = 8767
const IDLE_MS = 15 * 60_000
const PARENT_WATCH_MS = 5000
/** A comment line on every open stream: a quiet one (a paused run) must not hit the client's body timeout. */
const PING_MS = 15_000
const PRUNE_REQUESTS_MS = 24 * 3600_000
const REPLY_MS = 3000
const SESSION_ID = /^\d{8}-\d{6}-[0-9a-f]{4}:[a-z0-9-]+$/
const KINDS = ['task', 'test', 'gate', 'flow']
const TARGETS = ['chromium', 'chrome-cdp', 'electron']
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/q-theme.css': ['q-theme.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] }
const MAX_FRAMES = 120
const MAX_ENDED = 20
/** Only the newest ended sessions keep their screenshots in memory. */
const KEEP_SHOTS = 5
const MAX_ASKS = 30
const HISTORY_RUNS = 200
const INPUT_TYPES = ['click', 'dblclick', 'move', 'wheel', 'key', 'text']
const OPENER = { darwin: ['open'], win32: ['cmd', '/c', 'start', '""'] }
const HOLDING = ['paused', 'held', 'control']

const safeEqual = (a, b) => typeof a === 'string' && typeof b === 'string' && a.length === b.length && timingSafeEqual(Buffer.from(a), Buffer.from(b))
const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
const within = (dir, file) => typeof file === 'string' && resolve(file).startsWith(resolve(dir) + sep)
const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null)

const headless = (env = process.env) => env.Q_PILOT_HEADLESS === '1' || Boolean(env.CI) || (process.platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY)

/** Opens `url` in the person's default browser (their own profile), apart from the browser under test. */
function openInUserBrowser(url, log) {
  const [cmd, ...args] = OPENER[process.platform] ?? ['xdg-open']
  try {
    const child = spawn(cmd, [...args, url], { detached: true, stdio: 'ignore' })
    child.on('error', e => log(`[q-pilot] could not open the dashboard (${e.message}); open ${url} yourself`))
    child.unref()
  } catch (e) {
    log(`[q-pilot] could not open the dashboard (${e.message}); open ${url} yourself`)
  }
}

const pidAlive = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (e) {
    return e.code === 'EPERM'
  }
}

/** The descriptor of a live dashboard for `root`, or null (missing, dead pid, or it does not answer with its token). */
async function liveDescriptor(file, root) {
  const d = readJson(file)
  if (!d || d.root !== root || !Number.isInteger(d.port) || typeof d.runnerToken !== 'string' || !pidAlive(d.pid)) return null
  try {
    const r = await fetch(`http://127.0.0.1:${d.port}/rpc/health`, { headers: { 'x-q-runner': d.runnerToken }, signal: AbortSignal.timeout(500) })
    return r.ok ? d : null
  } catch {
    return null
  }
}

const listen = (server, port) =>
  new Promise((res, rej) => {
    server.once('error', rej)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', rej)
      res(server.address().port)
    })
  })

/**
 * Starts the dashboard for `root`. Returns { url, port, file, reused, pageToken, runnerToken, close() }. With `reused`
 * another live dashboard already serves this root: nothing is started.
 * `onIdle` is called once the dashboard shut itself down for being unused (the CLI exits there).
 */
export async function startDash({ root, port = DEFAULT_PORT, log = line => console.error(line), idleMs = IDLE_MS, openUrl = null, openTrace = null, askTransport = null, env = process.env, onIdle = null, replyMs = REPLY_MS, pingMs = PING_MS, window: windowMode = 'app', openWindow = null, config: configOpt, configWaitMs } = {}) {
  root = resolve(root)
  const dir = join(root, '.q-pilot', 'dashboard')
  const file = join(dir, 'server.json')
  // One folder per process: the ask and save counters start at 0, and an answer file left by an earlier process must not
  // be taken for the answer to a new request.
  const requestsDir = join(dir, 'requests', `${Date.now()}-${process.pid}`)
  const runsRoot = join(root, '.q-pilot', 'runs')
  const project = basename(root)
  const old = await liveDescriptor(file, root)
  if (old) {
    log(`[q-pilot] dash ${JSON.stringify({ url: old.url, file, reused: true })}`)
    return { url: old.url, port: old.port, file, reused: true, close: async () => {} }
  }

  const pageToken = randomBytes(24).toString('base64url')
  const runnerToken = randomBytes(24).toString('base64url')
  const clients = new Map() // page SSE response -> { s }
  const sessions = new Map() // id -> live or ended-in-memory record
  const endedOrder = []
  const asks = new Map() // id -> ask rows
  const saves = new Map() // id -> last Save row
  const asker = createAsker({ via: 'session', transport: askTransport ?? askViaMod({ runDir: requestsDir, log }) })
  let save
  // Settings go through the mod; a dashboard started by hand has none (`config: null`).
  const config = configOpt === null ? null : configOpt ?? configViaMod({ dir: requestsDir, log, waitMs: configWaitMs })
  let actual = port, down = false, lastList = '', lastActive = Date.now(), histLimit = HISTORY_RUNS, hist = []
  let opening = 0, fellBack = false
  // `window: 'app'` opens the dashboard as a standalone app window (app-window.mjs) and falls back to the default
  // browser when none can be started. An injected `openUrl` without `openWindow` is the only opener (tests).
  const appFor = mode => mode === 'app' && Boolean(openWindow || !openUrl)
  const launch = async (url, mode) => {
    if (appFor(mode)) {
      try {
        const fn = openWindow ?? (await import('./app-window.mjs')).openAppWindow
        const r = await fn(url, {})
        if (r?.ok) return
        if (!fellBack) log(`[q-pilot] app window unavailable (${r?.reason ?? 'unknown'}); opening a tab instead`)
      } catch (e) {
        if (!fellBack) log(`[q-pilot] app window unavailable (${e.message}); opening a tab instead`)
      }
      fellBack = true
    }
    ;(openUrl ?? (u => openInUserBrowser(u, log)))(url)
  }
  /** Opens `url` unless a window was just opened and has not connected yet (a second launch would be a second window). */
  const openOnce = (url, mode = windowMode, throttle = true) => {
    if (throttle && Date.now() - opening < 15_000) return false
    opening = Date.now()
    launch(url, mode).catch(() => {})
    return true
  }

  const openTraceFile = openTrace ?? (f => {
    let cli
    try { cli = join(resolvePlaywright(root, env).path, 'cli.js') } catch {}
    if (!cli || !existsSync(cli)) return log('[q-pilot] no Playwright CLI found to open the trace')
    spawn(process.execPath, [cli, 'show-trace', f], { detached: true, stdio: 'ignore' }).unref()
  })
  const refreshHistory = () => {
    try { hist = listRuns(root, { limit: histLimit }) } catch { hist = [] }
  }

  // ---- the store -------------------------------------------------------------------------------------------------
  const runIdOf = id => id.split(':')[0]
  const isSecret = rec => Boolean(rec.meta.secret || rec.state.secret)
  const viewersOf = id => [...clients.values()].filter(c => c.s === id).length
  const liveRec = id => {
    const rec = sessions.get(id)
    return rec && !rec.ended && !rec.incomplete ? rec : null
  }
  const histOf = id => hist.find(h => h.id === id) ?? null

  const summaryOfRec = rec => {
    const s = summaryOf(rec.meta, rec.state, { endedAt: rec.endedAt, source: rec.ended || rec.incomplete ? 'memory' : 'live' })
    if (rec.incomplete) s.status = 'incomplete'
    if (rec.ended) s.status = 'ended'
    return s
  }
  const summaryOfHist = h => {
    const { goal, runDir, files, trail, frames, error, checks, vision, settings, steps, ...s } = h
    return s
  }
  const list = () => {
    const mem = [...sessions.values()].map(summaryOfRec)
    const ids = new Set(mem.map(s => s.id))
    return [...mem, ...hist.filter(h => !ids.has(h.id)).map(summaryOfHist)].sort((a, b) => b.startedAt - a.startedAt)
  }
  const askBlock = { via: 'session', models: ASK_MODELS.map(({ alias, id, label, note }) => ({ alias, id, label, note })), default: ASK_MODELS[0].alias }
  const overlay = (id, state) => ({
    ...state,
    ask: askBlock,
    asks: asks.get(id) ?? [],
    settings: { sources: {}, changed: [], ...state.settings, canSave: true, save: saves.get(id) ?? null },
  })
  const stateOf = id => {
    const rec = sessions.get(id)
    if (rec) {
      const state = { ...rec.state, id, kind: rec.meta.kind, secret: isSecret(rec), screenshot: null, files: rec.files }
      if (rec.ended) state.status = 'ended'
      if (isSecret(rec)) state.screenshots = false
      return overlay(id, state)
    }
    const h = histOf(id)
    if (!h) return null
    return overlay(id, {
      id, kind: h.kind, secret: h.secret, live: null, status: 'ended', mode: 'run', name: h.name, goal: h.goal, deadline: null, startedAt: h.startedAt, pausedMs: 0,
      step: h.frames.at(-1)?.step ?? 0, url: '', title: '', view: null, boxes: [], screenshot: null, screenshots: false, elements: [], decision: null,
      history: h.trail, note: h.status === 'incomplete' ? 'This run did not finish.' : null, outcome: h.outcome, error: h.error, checks: h.checks,
      frames: h.frames, files: h.files, helper: null, vision: null, box: null, settings: h.settings,
    })
  }

  const held = new WeakMap()
  /** A tab that cannot keep up gets only the latest of each event, once it drains. */
  const sse = (res, event, data) => {
    if (res.writableNeedDrain) {
      let h = held.get(res)
      if (!h) {
        held.set(res, (h = new Map()))
        res.once('drain', () => {
          held.delete(res)
          for (const [e, d] of h) res.write(`event: ${e}\ndata: ${JSON.stringify(d)}\n\n`)
        })
      }
      return h.set(event, data)
    }
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)
  }
  const broadcastSessions = () => {
    const l = list()
    const text = JSON.stringify(l)
    if (text === lastList) return
    lastList = text
    for (const res of clients.keys()) sse(res, 'sessions', { sessions: l, focus: null, project })
  }
  /** Tells every tab to select `id` (the UI takes `focus` from the sessions event). */
  const focus = id => {
    for (const res of clients.keys()) sse(res, 'sessions', { sessions: list(), focus: id, project })
  }
  const broadcastState = id => {
    const state = stateOf(id)
    if (state) for (const [res, c] of clients) if (c.s === id) sse(res, 'state', state)
  }
  const changed = id => {
    broadcastSessions()
    broadcastState(id)
  }
  const sendCommand = (rec, cmd) => {
    if (!rec.runners.size) return false
    const data = `data: ${JSON.stringify({ cid: randomBytes(6).toString('hex'), ...cmd })}\n\n`
    for (const res of rec.runners) res.write(data)
    return true
  }
  /** A command the runner answers: resolves with its reply, or { ok: false, timeout } after REPLY_MS. */
  const request = (rec, cmd) =>
    new Promise(resolveReply => {
      const cid = randomBytes(6).toString('hex')
      if (!rec.runners.size) return resolveReply({ ok: false, gone: true })
      const timer = setTimeout(() => (rec.pending.delete(cid), resolveReply({ ok: false, timeout: true })), replyMs)
      rec.pending.set(cid, r => (clearTimeout(timer), resolveReply(r)))
      for (const res of rec.runners) res.write(`data: ${JSON.stringify({ cid, ...cmd })}\n\n`)
    })
  const syncViewers = id => {
    const rec = sessions.get(id)
    if (!rec) return
    const n = viewersOf(id)
    if (n !== rec.viewers) {
      rec.viewers = n
      sendCommand(rec, { type: 'viewers', n })
    }
  }
  const dropEnded = () => {
    while (endedOrder.length > MAX_ENDED) sessions.delete(endedOrder.shift())
    for (const id of endedOrder.slice(0, -KEEP_SHOTS)) {
      const rec = sessions.get(id)
      if (rec) for (const f of rec.frames.values()) f.screenshot = null
    }
  }
  /** Nothing of a secret session is kept as pixels, whatever a runner sends. */
  const scrub = rec => {
    for (const f of rec.frames.values()) f.screenshot = null
    rec.live = null
  }

  // ---- http ------------------------------------------------------------------------------------------------------
  const server = createServer(async (req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body))
    }
    const fail = (status, error) => send(status, { error })
    const origin = `http://127.0.0.1:${actual}`
    // DNS rebinding: only our own host name reaches anything.
    if (req.headers.host !== `127.0.0.1:${actual}`) return send(403, 'Forbidden', 'text/plain')
    const url = new URL(req.url, origin)
    const post = req.method === 'POST'
    if (post && req.headers.origin !== undefined && req.headers.origin !== origin) return fail(403, 'local dashboard requests only')
    /** The request body, or null after answering 413. */
    const body = cap =>
      new Promise(done => {
        const len = Number(req.headers['content-length'])
        const tooBig = () => {
          res.writeHead(413, { 'content-type': 'application/json', connection: 'close' })
          res.end('{"error":"body too large"}', () => req.destroy())
          done(null)
        }
        if (len > cap) return tooBig()
        const chunks = []
        let size = 0
        req.on('data', c => {
          size += c.length
          if (size > cap) {
            req.removeAllListeners('data')
            return tooBig()
          }
          chunks.push(c)
        })
        req.on('end', () => size <= cap && done(Buffer.concat(chunks)))
        req.on('error', () => done(null))
      })
    const jsonBody = async cap => {
      const buf = await body(cap)
      if (!buf) return null
      try {
        const v = JSON.parse(buf.toString('utf8'))
        if (v && typeof v === 'object' && !Array.isArray(v)) return v
      } catch {}
      fail(400, 'a JSON object is required')
      return null
    }
    try {
      if (req.method === 'GET' && STATIC[url.pathname]) {
        const [f, type] = STATIC[url.pathname]
        return send(200, readFileSync(new URL(`./inspector/${f}`, import.meta.url), 'utf8').replace('__TOKEN__', pageToken), type)
      }
      if (url.pathname.startsWith('/rpc/')) return await rpc(req, res, url, { send, fail, body, jsonBody })
      if (url.pathname.startsWith('/api/')) return await api(req, res, url, { send, fail, jsonBody, origin })
      send(404, 'Not found', 'text/plain')
    } catch (e) {
      if (!res.headersSent) fail(500, e.message)
      else res.end()
    }
  })

  /** Runner API: /rpc/*, runner token. */
  async function rpc(req, res, url, { send, fail, body, jsonBody }) {
    if (!safeEqual(req.headers['x-q-runner'], runnerToken)) return fail(403, 'bad runner token')
    const parts = url.pathname.split('/').slice(2) // after /rpc
    if (req.method === 'GET' && parts[0] === 'health' && parts.length === 1) return send(200, { ok: true, pid: process.pid })
    // The person asked for the tab (`/q-pilot dashboard`): no throttle, and a tab that is already connected is focused instead.
    if (req.method === 'POST' && parts[0] === 'open' && parts.length === 1) {
      const m = await jsonBody(1024)
      if (!m) return
      const mode = m.window === 'app' || m.window === 'tab' ? m.window : windowMode
      const target = typeof m.s === 'string' && sessions.has(m.s) ? `#s=${encodeURIComponent(m.s)}` : ''
      if (clients.size) {
        if (target) focus(m.s)
        return send(200, { url: out.url, opened: false })
      }
      return send(200, { url: out.url, opened: openOnce(`${out.url}${target}`, mode, appFor(mode)) })
    }
    if (parts[0] !== 'sessions') return fail(404, 'not found')
    if (req.method === 'POST' && parts.length === 1) {
      const m = await jsonBody(16 * 1024)
      if (!m) return
      if (typeof m.id !== 'string' || !SESSION_ID.test(m.id)) return fail(400, 'bad session id')
      if (!KINDS.includes(m.kind)) return fail(400, 'bad session kind')
      const [runId, flowId] = m.id.split(':')
      if (typeof m.runDir !== 'string' || !within(runsRoot, m.runDir) || basename(m.runDir) !== runId) return fail(400, 'runDir must be this run\'s folder under .q-pilot/runs')
      if (liveRec(m.id)) return fail(409, 'session already live')
      const target = m.target && TARGETS.includes(m.target.kind) ? { kind: m.target.kind, label: str(m.target.label, 60) ?? m.target.kind } : { kind: 'chromium', label: 'Chromium' }
      const meta = {
        id: m.id, runId, flowId, kind: m.kind, group: typeof m.group === 'string' && GROUP_ID.test(m.group) ? m.group : null, name: str(m.name, 120) ?? flowId, target, runDir: resolve(m.runDir), secret: Boolean(m.secret),
        goal: str(m.goal, 2000), startedAt: Number.isFinite(m.startedAt) ? m.startedAt : Date.now(), mode: m.mode === 'pause' ? 'pause' : 'run',
      }
      if (endedOrder.includes(m.id)) endedOrder.splice(endedOrder.indexOf(m.id), 1)
      sessions.set(m.id, {
        meta, frames: new Map(), live: null, runners: new Set(), pending: new Map(), viewers: 0, ended: false, incomplete: false, endedAt: null, files: {},
        state: { status: 'starting', mode: meta.mode, name: meta.name, goal: meta.goal, startedAt: meta.startedAt, history: [], frames: [], checks: [], secret: meta.secret },
      })
      refreshHistoryLater()
      changed(m.id)
      // The tab: opened once, by the first session that asks for it, and only when none is watching already.
      if (m.open === true && (m.kind === 'task' || m.kind === 'test')) {
        if (clients.size) focus(m.id)
        else if (!headless(env)) openOnce(`${out.url}#s=${encodeURIComponent(m.id)}`)
      }
      return send(201, { id: m.id, url: `${out.url}#s=${m.id}` })
    }
    let id
    try { id = decodeURIComponent(parts[1] ?? '') } catch { return fail(400, 'bad session id') }
    const rec = sessions.get(id)
    if (!rec) return fail(404, 'no such session')
    const op = parts[2]
    if (req.method === 'GET' && op === 'commands' && parts.length === 3) {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      rec.runners.add(res)
      res.write(`data: ${JSON.stringify({ cid: 'v0', type: 'viewers', n: viewersOf(id) })}\n\n`)
      rec.viewers = viewersOf(id)
      req.on('close', () => {
        rec.runners.delete(res)
        // A runner that went away without ending its session is not coming back.
        if (!rec.runners.size && !rec.ended && !down) {
          rec.incomplete = true
          endedOrder.push(id)
          dropEnded()
          rec.live = null
          changed(id)
        }
      })
      return
    }
    if (!isPost(req)) return fail(404, 'not found')
    if (op === 'state') {
      const s = await jsonBody(1024 * 1024)
      if (!s) return
      rec.state = { ...s, screenshot: null }
      // Files named after the end (the runner reports them once it has the result) count when they are this run's own.
      for (const k of ['trace', 'decisions', 'screenshot']) if (within(rec.meta.runDir, s.files?.[k])) rec.files[k] = s.files[k]
      if (isSecret(rec)) scrub(rec)
      changed(id)
      return send(204, '')
    }
    if (op === 'frames') {
      const f = await jsonBody(2 * 1024 * 1024)
      if (!f) return
      if (!Number.isInteger(f.i)) return fail(400, 'a frame needs an integer i')
      if (isSecret(rec) || typeof f.screenshot !== 'string') f.screenshot = null
      rec.frames.set(f.i, f)
      while (rec.frames.size > MAX_FRAMES) rec.frames.delete(Math.min(...rec.frames.keys()))
      return send(204, '')
    }
    if (op === 'live') {
      const buf = await body(1024 * 1024)
      if (!buf) return
      if (isSecret(rec) || !buf.length) return send(204, '')
      const w = Number(req.headers['x-q-w']) || 0, h = Number(req.headers['x-q-h']) || 0
      rec.live = { buf, w, h, ts: Number(req.headers['x-q-ts']) || Date.now() }
      const event = `event: live\ndata: ${JSON.stringify({ s: id, w, h, jpeg: buf.toString('base64') })}\n\n`
      for (const [c, v] of clients) if (v.s === id && !c.writableNeedDrain) c.write(event)
      return send(204, '')
    }
    if (op === 'reply') {
      const r = await jsonBody(64 * 1024)
      if (!r) return
      rec.pending.get(r.cid)?.(r)
      rec.pending.delete(r.cid)
      return send(204, '')
    }
    if (op === 'end') {
      const e = await jsonBody(1024 * 1024)
      if (!e) return
      const files = {}
      for (const k of ['trace', 'decisions', 'screenshot']) if (typeof e.files?.[k] === 'string' && within(rec.meta.runDir, e.files[k])) files[k] = e.files[k]
      rec.files = files
      rec.ended = true
      rec.endedAt = Date.now()
      rec.live = null
      rec.state = { ...rec.state, status: 'ended', outcome: str(e.outcome, 40), error: str(e.error, 2000), checks: Array.isArray(e.checks) ? e.checks : [], files }
      for (const r of rec.runners) r.end()
      rec.runners.clear()
      endedOrder.push(id)
      dropEnded()
      changed(id)
      return send(204, '')
    }
    return fail(404, 'not found')
  }
  const isPost = req => req.method === 'POST'

  /** Page API: /api/*, page token. */
  async function api(req, res, url, { send, fail, jsonBody }) {
    const token = req.method === 'GET' ? url.searchParams.get('t') : req.headers['x-pilot-token']
    if (!safeEqual(token, pageToken)) return fail(403, 'bad token')
    const path = url.pathname
    const sid = url.searchParams.get('s')
    if (req.method === 'GET' && path === '/api/events') {
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      const c = { s: sid }
      clients.set(res, c)
      sse(res, 'sessions', { sessions: list(), focus: null, project })
      const state = sid && stateOf(sid)
      if (state) sse(res, 'state', state)
      const rec = sid && sessions.get(sid)
      if (rec?.live && !isSecret(rec)) sse(res, 'live', { s: sid, w: rec.live.w, h: rec.live.h, jpeg: rec.live.buf.toString('base64') })
      if (sid) syncViewers(sid)
      req.on('close', () => {
        clients.delete(res)
        if (sid) syncViewers(sid)
      })
      return
    }
    if (path === '/api/config') return configApi(req, send, fail, jsonBody)
    if (req.method === 'GET' && path === '/api/sessions') {
      if (url.searchParams.get('more') === '1') histLimit += HISTORY_RUNS
      refreshHistory()
      return send(200, { sessions: list(), project, focus: null })
    }
    if (req.method === 'GET' && path === '/api/frame') {
      const i = Number(url.searchParams.get('i'))
      const rec = sessions.get(sid)
      if (rec) {
        const f = rec.frames.get(i)
        return f ? send(200, { ...f, s: sid, screenshot: isSecret(rec) ? null : f.screenshot }) : fail(404, 'no such frame')
      }
      const h = histOf(sid)
      const f = h && loadFrame(h, i)
      return f ? send(200, { ...f, s: sid }) : fail(404, 'no such frame')
    }
    if (req.method === 'GET' && path === '/api/file') {
      const kind = url.searchParams.get('kind')
      const rec = sessions.get(sid)
      const secret = rec ? isSecret(rec) : histOf(sid)?.secret
      const files = rec ? rec.files : histOf(sid)?.files
      const f = files && Object.hasOwn(files, kind) ? files[kind] : null
      if (!f || (secret && kind === 'screenshot') || !SESSION_ID.test(sid) || !within(join(runsRoot, runIdOf(sid)), f) || !existsSync(f)) return fail(404, 'no such file')
      res.writeHead(200, { 'content-type': f.endsWith('.zip') ? 'application/zip' : f.endsWith('.png') ? 'image/png' : 'application/json', 'content-disposition': `attachment; filename="${basename(f)}"`, 'cache-control': 'no-store' })
      return res.end(readFileSync(f))
    }
    if (!isPost(req)) return fail(404, 'not found')
    const v = await jsonBody(path === '/api/input' ? 4096 : 8192)
    if (!v) return
    const id = typeof v.s === 'string' ? v.s : null
    const rec = id && sessions.get(id)
    const h = id && !rec ? histOf(id) : null
    if (!rec && !h) return fail(404, 'no such session')
    const live = rec && liveRec(id)

    if (path === '/api/open') {
      focus(id)
      return send(200, { ok: true })
    }
    if (path === '/api/control') {
      if (!ACTIONS.includes(v.action)) return fail(400, 'unknown action')
      if (v.action === 'trace') {
        const f = (rec ? rec.files : h.files).trace
        if (!f || !existsSync(f)) return fail(409, 'not available now')
        openTraceFile(f)
        return send(200, { ok: true })
      }
      if (!live) return fail(409, 'the run has ended')
      if (rec.meta.kind === 'gate' || rec.meta.kind === 'flow') return fail(409, 'this run cannot be paused or stopped from here')
      const r = await request(live, { type: 'control', action: v.action })
      if (!r.ok) return fail(r.timeout ? 504 : 409, r.timeout ? 'the run did not answer' : r.error ?? 'not available now')
      return send(200, { ok: true, mode: rec.state.mode, status: rec.state.status })
    }
    if (path === '/api/settings') {
      if (!live) return fail(409, 'the run has ended')
      if (!rec.state.vision) return fail(409, 'no vision settings for this run')
      if ((isSecret(rec) || rec.state.vision.blocked) && (v.mode ?? 'off') !== 'off') return fail(409, rec.state.vision.blocked ?? 'Vision is off: this run types a secret fixture.')
      if (v.mode !== undefined && !VISION_MODES.includes(v.mode)) return fail(400, 'unknown vision mode')
      if (v.model !== undefined && !VISION_MODELS.some(m => m.id === v.model)) return fail(400, 'unknown vision model')
      const cmd = { type: 'settings', ...(v.mode !== undefined && { mode: v.mode }), ...(v.model !== undefined && { model: v.model }), ...(v.box !== undefined && { box: Boolean(v.box) }) }
      if (isSecret(rec)) Object.assign(cmd, { box: false })
      const r = await request(live, cmd)
      if (!r.ok) return fail(r.timeout ? 504 : 409, r.timeout ? 'the run did not answer' : r.error ?? 'not available now')
      return send(200, { ok: true, ...cmd, type: undefined })
    }
    if (path === '/api/settings/save') {
      if (!SAVE_SCOPES.includes(v.scope)) return fail(400, `scope must be one of ${SAVE_SCOPES.join(', ')}`)
      const keys = v.keys && typeof v.keys === 'object' && !Array.isArray(v.keys) ? Object.keys(v.keys) : []
      if (!keys.length) return fail(400, 'keys must hold at least one setting')
      const bad = keys.find(k => !Object.hasOwn(SAVE_KEYS, k))
      if (bad) return fail(400, `${bad} cannot be saved from the dashboard (${Object.keys(SAVE_KEYS).join(', ')})`)
      const wrong = keys.find(k => !SAVE_KEYS[k](v.keys[k]))
      if (wrong) return fail(400, `bad value for ${wrong}`)
      const request1 = { keys: Object.fromEntries(keys.map(k => [k, v.keys[k]])), scope: v.scope }
      let done
      try { done = (save ??= saveViaMod({ runDir: requestsDir, log }))(request1) } catch (e) { return fail(500, `could not hand the change to the session: ${e.message}`) }
      const row = { status: 'pending', scope: request1.scope, keys: request1.keys, message: null }
      saves.set(id, row)
      changed(id)
      done.then(r => {
        Object.assign(row, r.ok ? { status: 'saved', message: r.message ?? null } : { status: 'error', message: r.error ?? 'not saved' })
        if (!down) broadcastState(id)
      })
      return send(200, { ok: true, pending: true, scope: request1.scope })
    }
    if (path === '/api/ask') {
      if (typeof v.question !== 'string' || !v.question.trim()) return fail(400, 'a question is required')
      const secret = rec ? isSecret(rec) : h.secret
      if (secret && !live) return fail(409, 'Ask is off after a run that typed a secret')
      const frame = rec ? rec.frames.get(v.frame) ?? [...rec.frames.values()].at(-1) ?? null : loadFrame(h, v.frame) ?? null
      const state = rec ? rec.state : { goal: h.goal, history: h.trail }
      const row = { id: (asks.get(id)?.[0]?.id ?? 0) + 1, question: v.question.slice(0, 1000), model: v.model, step: frame?.step ?? null, pending: true, at: Date.now() }
      const rows = asks.get(id) ?? []
      asks.set(id, rows)
      rows.unshift(row)
      if (rows.length > MAX_ASKS) rows.pop()
      changed(id)
      const r = await asker.ask({ goal: state.goal, question: row.question, model: v.model, frame, history: state.history ?? [] })
      let texts = [r.error ? null : r.text ?? '', r.error ?? null]
      // The runner knows the run's secrets: its answer is the one that goes on screen.
      if (live) {
        const red = await request(live, { type: 'redact', texts: texts.map(t => t ?? '') })
        if (red.ok && Array.isArray(red.value)) texts = texts.map((t, k) => (t === null ? null : String(red.value[k] ?? '')))
        else if (secret) texts = [null, 'The answer was withheld: the run could not redact it.']
      }
      const clean = t => (t === null ? null : redact(t))
      Object.assign(row, { pending: false, answer: clean(texts[0]), error: clean(texts[1]), model: r.model, label: r.label, ms: r.ms })
      changed(id)
      return send(200, row)
    }
    if (path === '/api/input') {
      const ev = v.ev
      if (!live || isSecret(rec) || !['task', 'test'].includes(rec.meta.kind) || !HOLDING.includes(rec.state.status)) return fail(409, 'take control is not available now')
      if (!ev || typeof ev !== 'object' || !INPUT_TYPES.includes(ev.type)) return fail(400, 'unknown input event')
      const r = await request(live, { type: 'input', ev })
      if (!r.ok) return fail(r.timeout ? 504 : r.gone ? 409 : 400, r.error ?? 'the run did not answer')
      return send(200, { ok: true })
    }
    return fail(404, 'not found')
  }

  const CONFIG_KEY = /^[A-Za-z][A-Za-z0-9]{0,40}$/
  /** GET /api/config (the rows) and POST /api/config (set or unset one key), both through the mod. */
  async function configApi(req, send, fail, jsonBody) {
    if (!config) return fail(503, 'Settings can be changed only when the dashboard was started by Claude Code (/q-pilot dashboard).')
    let request
    if (req.method === 'GET') request = { op: 'get' }
    else if (req.method === 'POST') {
      const v = await jsonBody(4096)
      if (!v) return
      if (v.op !== 'set' && v.op !== 'unset') return fail(400, 'op must be set or unset')
      if (typeof v.key !== 'string' || !CONFIG_KEY.test(v.key)) return fail(400, 'bad setting key')
      if (!SAVE_SCOPES.includes(v.scope)) return fail(400, `scope must be one of ${SAVE_SCOPES.join(', ')}`)
      if (v.op === 'set' && (typeof v.value !== 'string' || v.value.length > 500)) return fail(400, 'value must be a string of at most 500 characters')
      request = v.op === 'set' ? { op: 'set', key: v.key, value: v.value, scope: v.scope } : { op: 'unset', key: v.key, scope: v.scope }
    } else return fail(404, 'not found')
    const answer = await config(request)
    if (answer.timeout) return fail(504, answer.error)
    if (answer.error) return send(400, answer)
    if (request.key === 'dashboardWindow') {
      const row = answer.settings?.find(r => r.key === 'dashboardWindow')
      const w = row ? row.value : request.value
      if (w === 'app' || w === 'tab') windowMode = w
    }
    return send(200, answer)
  }

  // The history is rebuilt from the run dirs at start and when a new session registers.
  let histTimer = null
  const refreshHistoryLater = () => {
    histTimer ??= setTimeout(() => { histTimer = null; refreshHistory(); broadcastSessions() }, 200).unref()
  }

  try {
    const parent = join(dir, 'requests')
    for (const d of existsSync(parent) ? readdirSync(parent) : []) if (Date.now() - statSync(join(parent, d)).mtimeMs > PRUNE_REQUESTS_MS) rmSync(join(parent, d), { recursive: true, force: true })
  } catch {}
  mkdirSync(requestsDir, { recursive: true })
  writeFileSync(join(dir, '.gitignore'), '*\n')
  try {
    actual = await listen(server, port)
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e
    actual = await listen(server, 0)
  }
  const out = { url: `http://127.0.0.1:${actual}/`, port: actual, file, reused: false, pageToken, runnerToken, pid: process.pid, requestsDir }
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, JSON.stringify({ v: 1, pid: process.pid, port: actual, url: out.url, runnerToken, root, startedAt: Date.now() }), { mode: 0o600 })
  renameSync(tmp, file)
  refreshHistory()

  const tick = setInterval(() => {
    const busy = clients.size > 0 || [...sessions.values()].some(r => !r.ended && !r.incomplete)
    if (busy) lastActive = Date.now()
    else if (Date.now() - lastActive >= idleMs) shutdown().then(() => onIdle?.())
  }, Math.max(20, Math.min(30_000, idleMs / 4)))
  tick.unref()
  const ping = setInterval(() => {
    for (const res of clients.keys()) res.write(': ping\n\n')
    for (const rec of sessions.values()) for (const res of rec.runners) res.write(': ping\n\n')
  }, pingMs)
  ping.unref()

  async function shutdown() {
    if (down) return
    down = true
    clearInterval(tick)
    clearInterval(ping)
    clearTimeout(histTimer)
    for (const res of clients.keys()) {
      sse(res, 'bye', {})
      res.end()
    }
    clients.clear()
    for (const rec of sessions.values()) for (const r of rec.runners) r.end()
    // Only the descriptor this process wrote.
    if (readJson(file)?.pid === process.pid) rmSync(file, { force: true })
    const closed = new Promise(r => server.close(() => r()))
    server.closeAllConnections?.()
    await closed
  }
  out.close = shutdown
  log(`[q-pilot] dash ${JSON.stringify({ url: out.url, file, reused: false })}`)
  return out
}

/** `--open`: asks the running dashboard of `root` to open its tab in the person's browser. Prints its URL. */
async function openRunning(root, window) {
  const d = await liveDescriptor(join(root, '.q-pilot', 'dashboard', 'server.json'), root)
  if (!d) {
    console.error('[q-pilot] no dashboard is running for this project')
    return 1
  }
  try {
    const r = await fetch(`${d.url}rpc/open`, { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify(window ? { window } : {}), signal: AbortSignal.timeout(3000) })
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
  } catch (e) {
    console.error(`[q-pilot] could not reach the dashboard (${e.message})`)
    return 1
  }
  console.log(d.url)
  return 0
}

/** CLI entry: `node dash-server.mjs --root <root> [--port n] [--window app|tab] [--standalone] [--open]`. */
async function main(argv) {
  const opt = n => argv[argv.indexOf(`--${n}`) + 1]
  const root = opt('root')
  if (!root) {
    console.error('usage: dash-server.mjs --root <root> [--port n] [--open]')
    process.exit(2)
  }
  if (argv.includes('--open')) process.exit(await openRunning(resolve(root), opt('window') === 'tab' ? 'tab' : opt('window') === 'app' ? 'app' : undefined))
  // `--port 0` asks for a free port; the env and the default apply only when the flag is absent.
  const flag = argv.includes('--port') ? Number(opt('port')) : NaN
  const d = await startDash({
    root, port: Number.isInteger(flag) && flag >= 0 ? flag : Number(process.env.Q_PILOT_INSPECT_PORT) || DEFAULT_PORT,
    window: opt('window') === 'tab' ? 'tab' : 'app',
    config: argv.includes('--standalone') ? null : undefined,
    onIdle: () => process.exit(0),
  })
  if (d.reused) process.exit(0)
  const ppid = process.ppid
  setInterval(() => {
    if (process.ppid === 1 || process.ppid !== ppid) d.close().finally(() => process.exit(0))
  }, PARENT_WATCH_MS)
  for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => d.close().finally(() => process.exit(0)))
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main(process.argv.slice(2))
