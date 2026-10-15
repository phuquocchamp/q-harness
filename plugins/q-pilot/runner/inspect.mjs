// The live inspector: a loopback dashboard, like jev-ultrafast's, that shows each observation and Jev decision of
// the pilot loop and can hold it (Pause, Choose next, Execute, Run, Stop). It only gets redacted data: the elements
// as sent to Jev, history lines, and screenshots, which are left out when the run types a secret fixture.
// Served like jev-ultrafast's demo.py: 127.0.0.1 only, the Host header checked, and a per-run token on every
// API request. Time spent paused counts against the run's budget: the caller's timeouts do not move.
// Every observation is kept as a frame (screenshot, elements, Jev's decision, what ran), so the trail can be replayed
// step by step, during the run and after it: with `linger` the dashboard stays up once the run has ended, until the
// person closes it. "Ask Claude" sends a question about the frame on screen to a model the person picks (ask.mjs).
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { elementIndex } from './snapshot.mjs'
import { redact } from './redact.mjs'

export const DEFAULT_PORT = 8767
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/q-theme.css': ['q-theme.css', 'text/css'] }
const ACTIONS = new Set(['pause', 'run', 'choose', 'execute', 'stop', 'close', 'trace'])
/** Allowed once the run has ended (the dashboard stays up for review). */
const AFTER_END = new Set(['close', 'trace'])
const MAX_HISTORY = 200
const MAX_FRAMES = 120
const MAX_ASKS = 30
/** A lingering dashboard with no window open this long is closed; one left open goes at most LINGER_MS. */
const IDLE_CLOSE_MS = 30_000
export const LINGER_MS = 30 * 60_000

const listen = (server, port) =>
  new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      server.off('error', reject)
      resolve(server.address().port)
    })
  })

/**
 * Starts the dashboard server. `port` is tried first; when it is taken a free port is used. `mode`: 'run' (go on
 * without holding) or 'pause' (hold before the first Jev request). Returns the inspector the pilot loop reports to.
 */
const VISION_MODES = ['off', 'gated', 'always']
const VISION_MODELS = [
  { id: 'jev-1.13.0', label: 'Jev 1.13', note: 'stable (jev-latest)' },
  { id: 'jev-1.14.0', label: 'Jev 1.14', note: 'preview' },
]

const SAVE_SCOPES = ['user', 'project', 'local']
/** What "Save as default" may store: the vision settings only (never a personal key). */
const SAVE_KEYS = { vision: v => VISION_MODES.includes(v), visionModel: v => VISION_MODELS.some(m => m.id === v), box: v => typeof v === 'boolean' }
/** The settings of the run's inspector that have a source chip. */
const VISION_KEYS = { vision: 'mode', visionModel: 'model', box: 'box' }

/**
 * `settings`: { sources, save } from the mod. `sources` is {key: {value, scope, overridden}} for the settings the page
 * shows; `save({ keys, scope })` hands a change to the mod, which writes it (absent: no Save button).
 */
export async function createInspector({ port = DEFAULT_PORT, mode = 'run', asker = null, sessionModel = null, openTrace = null, vision = null, settings = null } = {}) {
  const token = randomBytes(24).toString('base64url')
  const clients = new Set()
  const state = {
    status: 'starting', mode, name: null, goal: null, deadline: null, startedAt: Date.now(), pausedMs: 0, step: 0,
    url: '', title: '', view: null, boxes: [], screenshot: null, screenshots: true,
    elements: [], decision: null, history: [], note: null, outcome: null, error: null, checks: [],
    // Frames without their screenshots (fetched one at a time from /api/frame), the asks, and the run's files.
    frames: [], asks: [], files: {},
    ask: asker ? { via: asker.via, models: asker.models.map(({ alias, id, label, note }) => ({ alias, id, label, note })), default: asker.models[0].alias } : null,
    helper: sessionModel ? { model: sessionModel } : null,
    // Jev vision as the run uses it now; the dashboard can change it (/api/settings). `blocked`: why it is forced off.
    vision: vision ? { ...vision, models: VISION_MODELS, modes: VISION_MODES, blocked: null, stats: { steps: 0, seen: 0, boxes: 0 } } : null,
    box: null,
    // Where each setting came from, which of the vision ones this page changed for the run, and the last Save.
    settings: settings?.sources ? { sources: settings.sources, canSave: Boolean(settings.save), changed: [], save: null } : null,
  }
  const frames = []
  let secrets = [], waiter = null, stopped = false, ended = false, actual = port, closed = false
  const onClient = [], onClose = []
  const closeNow = () => {
    if (closed) return
    closed = true
    for (const f of onClose.splice(0)) f()
  }
  const frameMeta = f => ({ i: f.i, step: f.step, url: f.url, title: f.title, label: f.decision?.label ?? null, p: f.decision?.p ?? null, help: f.help ?? null, by: f.by ?? null, shot: Boolean(f.screenshot), vision: Boolean(f.decision?.vision?.used), box: Boolean(f.box) })

  const syncChanged = () => {
    if (!state.settings || !state.vision) return
    state.settings.changed = Object.entries(VISION_KEYS).filter(([k, f]) => k in state.settings.sources && state.settings.sources[k].value !== state.vision[f]).map(([k]) => k)
  }
  const push = () => {
    const data = `data: ${JSON.stringify(state)}\n\n`
    for (const res of clients) res.write(data)
  }
  const release = r => {
    if (!waiter) return
    const w = waiter
    waiter = null
    w.resolve(r)
  }
  const control = action => {
    if (action === 'close') closeNow()
    else if (action === 'trace') {
      if (!state.files.trace || !openTrace) return false
      openTrace(state.files.trace)
      state.note = 'Opening the Playwright trace viewer in its own window.'
    } else if (action === 'stop') {
      stopped = true
      release({ stop: 'stopped from the dashboard' })
    } else if (action === 'pause') state.mode = 'pause'
    else if (action === 'run') {
      state.mode = 'run'
      release({})
    } else if (action === 'choose' && waiter?.kind === 'predict') release({})
    else if (action === 'execute' && waiter?.kind === 'execute') release({})
    else return false
    push()
    return true
  }

  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(body)
    }
    const origin = `http://127.0.0.1:${actual}`
    // DNS rebinding: only our own host name reaches the API.
    if (req.headers.host !== `127.0.0.1:${actual}`) return send(403, 'Forbidden', 'text/plain')
    const url = new URL(req.url, origin)
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      return send(200, readFileSync(new URL(`./inspector/${file}`, import.meta.url), 'utf8').replace('__TOKEN__', token), type)
    }
    if (req.method === 'GET' && url.pathname === '/api/events') {
      if (url.searchParams.get('t') !== token) return send(403, '{"error":"bad token"}')
      res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
      clients.add(res)
      res.write(`data: ${JSON.stringify(state)}\n\n`)
      req.on('close', () => {
        clients.delete(res)
        // After the run, a dashboard whose last window is gone is not coming back: close it a little later.
        if (ended && !clients.size) setTimeout(() => !clients.size && closeNow(), IDLE_CLOSE_MS).unref?.()
      })
      for (const f of onClient.splice(0)) f()
      return
    }
    if (req.method === 'GET' && url.pathname === '/api/frame') {
      if (url.searchParams.get('t') !== token) return send(403, '{"error":"bad token"}')
      const f = frames.find(x => x.i === Number(url.searchParams.get('i')))
      return f ? send(200, JSON.stringify(f)) : send(404, '{"error":"no such frame"}')
    }
    if (req.method === 'GET' && url.pathname === '/api/file') {
      if (url.searchParams.get('t') !== token) return send(403, '{"error":"bad token"}')
      const file = state.files[url.searchParams.get('kind')]
      if (!file || !existsSync(file)) return send(404, '{"error":"no such file"}')
      res.writeHead(200, { 'content-type': file.endsWith('.zip') ? 'application/zip' : 'application/json', 'content-disposition': `attachment; filename="${basename(file)}"`, 'cache-control': 'no-store' })
      return res.end(readFileSync(file))
    }
    if (req.method === 'POST' && url.pathname === '/api/ask') {
      if (req.headers['x-pilot-token'] !== token || (req.headers.origin !== undefined && req.headers.origin !== origin)) return send(403, '{"error":"local dashboard requests only"}')
      if (!asker) return send(409, '{"error":"Ask Claude is not available for this run"}')
      let body = ''
      req.on('data', c => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', async () => {
        let q
        try { q = JSON.parse(body) } catch {}
        if (!q || typeof q.question !== 'string' || !q.question.trim()) return send(400, '{"error":"a question is required"}')
        const frame = frames.find(x => x.i === q.frame) ?? frames.at(-1) ?? null
        const row = { id: state.asks.length + 1, question: q.question.slice(0, 1000), model: q.model, step: frame?.step ?? null, pending: true, at: Date.now() }
        state.asks.unshift(row)
        if (state.asks.length > MAX_ASKS) state.asks.pop()
        push()
        const r = await asker.ask({ goal: state.goal, question: row.question, model: q.model, frame, history: state.history })
        Object.assign(row, { pending: false, answer: r.error ? null : redact(r.text ?? '', secrets), error: r.error ? redact(r.error, secrets) : null, model: r.model, label: r.label, ms: r.ms })
        push()
        send(200, JSON.stringify(row))
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/settings') {
      if (req.headers['x-pilot-token'] !== token || (req.headers.origin !== undefined && req.headers.origin !== origin)) return send(403, '{"error":"local dashboard requests only"}')
      if (!vision) return send(409, '{"error":"no vision settings for this run"}')
      let body = ''
      req.on('data', c => {
        body += c
        if (body.length > 1024) req.destroy()
      })
      req.on('end', () => {
        let v
        try { v = JSON.parse(body) } catch {}
        if (!v || typeof v !== 'object') return send(400, '{"error":"settings must be an object"}')
        if (state.vision.blocked && (v.mode ?? 'off') !== 'off') return send(409, JSON.stringify({ error: state.vision.blocked }))
        if (v.mode !== undefined && !VISION_MODES.includes(v.mode)) return send(400, '{"error":"unknown vision mode"}')
        if (v.model !== undefined && !VISION_MODELS.some(m => m.id === v.model)) return send(400, '{"error":"unknown vision model"}')
        // The run reads this object at every step: a change applies from the next decision on.
        if (v.mode !== undefined) vision.mode = v.mode
        if (v.model !== undefined) vision.model = v.model
        if (v.box !== undefined) vision.box = Boolean(v.box)
        Object.assign(state.vision, { mode: vision.mode, model: vision.model, box: vision.box })
        syncChanged()
        push()
        send(200, JSON.stringify({ ok: true, mode: vision.mode, model: vision.model, box: vision.box }))
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/settings/save') {
      if (req.headers['x-pilot-token'] !== token || (req.headers.origin !== undefined && req.headers.origin !== origin)) return send(403, '{"error":"local dashboard requests only"}')
      if (!settings?.save) return send(409, '{"error":"saving settings is not available for this run"}')
      let body = ''
      req.on('data', c => {
        body += c
        if (body.length > 1024) req.destroy()
      })
      req.on('end', () => {
        let v
        try { v = JSON.parse(body) } catch {}
        if (!v || typeof v !== 'object') return send(400, '{"error":"the request must be an object"}')
        if (!SAVE_SCOPES.includes(v.scope)) return send(400, `{"error":"scope must be one of ${SAVE_SCOPES.join(', ')}"}`)
        const keys = v.keys && typeof v.keys === 'object' && !Array.isArray(v.keys) ? Object.keys(v.keys) : []
        if (!keys.length) return send(400, '{"error":"keys must hold at least one setting"}')
        const bad = keys.find(k => !Object.hasOwn(SAVE_KEYS, k))
        if (bad) return send(400, JSON.stringify({ error: `${bad} cannot be saved from the dashboard (${Object.keys(SAVE_KEYS).join(', ')})` }))
        const wrong = keys.find(k => !SAVE_KEYS[k](v.keys[k]))
        if (wrong) return send(400, JSON.stringify({ error: `bad value for ${wrong}` }))
        const request = { keys: Object.fromEntries(keys.map(k => [k, v.keys[k]])), scope: v.scope }
        let done
        try { done = settings.save(request) } catch (e) { return send(500, JSON.stringify({ error: `could not hand the change to the session: ${e.message}` })) }
        const row = { status: 'pending', scope: request.scope, keys: request.keys, message: null }
        state.settings.save = row
        push()
        // The mod applies it (its stderr marker) and answers through the run dir; the page learns the result from the state.
        done.then(r => {
          Object.assign(row, r.ok ? { status: 'saved', message: r.message ?? null } : { status: 'error', message: r.error ?? 'not saved' })
          push()
        })
        send(200, JSON.stringify({ ok: true, pending: true, scope: request.scope }))
      })
      return
    }
    if (req.method === 'POST' && url.pathname === '/api/control') {
      if (req.headers['x-pilot-token'] !== token || (req.headers.origin !== undefined && req.headers.origin !== origin)) return send(403, '{"error":"local dashboard requests only"}')
      let body = ''
      req.on('data', c => {
        body += c
        if (body.length > 1024) req.destroy()
      })
      req.on('end', () => {
        let action
        try { action = JSON.parse(body).action } catch {}
        if (!ACTIONS.has(action)) return send(400, '{"error":"unknown action"}')
        if (ended && !AFTER_END.has(action)) return send(409, '{"error":"the run has ended"}')
        if (control(action) === false) return send(409, '{"error":"not available now"}')
        send(200, JSON.stringify({ ok: true, mode: state.mode, status: state.status }))
      })
      return
    }
    send(404, 'Not found', 'text/plain')
  })
  try {
    actual = await listen(server, port)
  } catch (e) {
    if (e.code !== 'EADDRINUSE') throw e
    actual = await listen(server, 0)
  }

  return {
    url: `http://127.0.0.1:${actual}/`,
    get clients() { return clients.size },
    state,
    control,
    /** Resolves once a dashboard is connected, or after `ms`. */
    waitForClient: ms => (clients.size ? Promise.resolve(true) : new Promise(r => {
      const t = setTimeout(() => r(false), ms)
      onClient.push(() => { clearTimeout(t); r(true) })
    })),
    start({ name, goal, deadline, secrets: s = [] }) {
      secrets = s
      // A screenshot could show a secret fixture: vision is off for such a run, whatever the dashboard asks.
      if (vision && secrets.length) {
        Object.assign(vision, { mode: 'off', box: false })
        Object.assign(state.vision, { mode: 'off', box: false, blocked: 'Vision is off: this run types a secret fixture, so no screenshot leaves the browser.' })
      }
      Object.assign(state, { name, goal: redact(goal, secrets), deadline: Number.isFinite(deadline) ? deadline : null, status: 'observing', screenshots: !secrets.length })
      if (secrets.length) state.note = 'Screenshots are off: this run types a secret fixture.'
      push()
    },
    /** A fresh observation: overlay boxes, page size and (with a dashboard open and no secrets) a screenshot. */
    async observed(page, snap, step) {
      const index = elementIndex(snap.actions)
      const boxes = []
      for (const a of snap.actions) if (a.rect && index.has(a.node) && !boxes.some(b => b.i === index.get(a.node))) boxes.push({ i: index.get(a.node), rect: a.rect })
      Object.assign(state, { status: 'observing', step, url: redact(snap.url, secrets), title: redact(snap.title, secrets), boxes, decision: null, elements: [], box: null })
      state.view = snap.marker ? { w: snap.marker[4], h: snap.marker[5] } : null
      if (clients.size && !secrets.length) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 3000 }).catch(() => null)
        state.screenshot = buf ? buf.toString('base64') : null
      } else state.screenshot = null
      const f = { i: frames.length ? frames.at(-1).i + 1 : 1, step, url: state.url, title: state.title, view: state.view, boxes, screenshot: state.screenshot, elements: [], decision: null }
      frames.push(f)
      if (frames.length > MAX_FRAMES) frames.shift()
      state.frames = frames.map(frameMeta)
      push()
    },
    decided(detail, label, p) {
      Object.assign(state, { status: 'decided', decision: { ...detail, label, p }, elements: detail?.elements ?? [], note: null })
      if (state.vision) {
        state.vision.stats.steps++
        if (detail?.vision?.used) state.vision.stats.seen++
      }
      const f = frames.at(-1)
      if (f) {
        f.decision = state.decision
        f.elements = state.elements
        state.frames = frames.map(frameMeta)
      }
      push()
    },
    acted(row) {
      const f = frames.at(-1)
      if (f && row.by === 'claude') f.by = 'claude'
      state.history.push({ ...row, frame: f?.i ?? null, pageChanged: null })
      if (state.history.length > MAX_HISTORY) state.history.shift()
      state.status = 'acted'
      push()
    },
    changed(yes) {
      const last = state.history.at(-1)
      if (last && last.pageChanged === null) last.pageChanged = yes
    },
    /** A Box rescue on the frame on screen: where Jev 1.14 located the control, and whether the run clicked it. */
    boxed(r) {
      const f = frames.at(-1)
      const box = { ...r.box, confidence: r.confidence, present: r.present, ok: r.ok, reason: r.reason, model: r.model, ms: r.ms, w: r.w, h: r.h }
      if (f) {
        f.box = box
        state.frames = frames.map(frameMeta)
      }
      state.box = box
      if (state.vision) state.vision.stats.boxes++
      push()
    },
    /** The loop handed the run to Claude (reason), or got the answer back (null). */
    helping(reason) {
      const f = frames.at(-1)
      if (f && reason) {
        f.help = reason
        state.frames = frames.map(frameMeta)
      }
      state.status = reason ? 'helping' : 'observing'
      state.note = reason ? `Jev is stuck (${reason}): the run waits for Claude's answer.` : null
      push()
    },
    /** Time spent waiting for Claude does not count against the run: its deadline moves. */
    extend(ms) {
      if (state.deadline) state.deadline += ms
      push()
    },
    stale() {
      state.note = 'The page changed while the run was held, so the decision was dropped and Jev is asked again.'
      push()
    },
    /**
     * Holds the loop while the dashboard is in pause mode: 'predict' before asking Jev, 'execute' before running a
     * decision. Returns {} (go on), { waited: true } (held, then released), or { stop } with the reason to end.
     */
    async gate(kind) {
      if (stopped) return { stop: 'stopped from the dashboard' }
      if (state.mode === 'run') return {}
      const t0 = Date.now()
      state.status = kind === 'predict' ? 'paused' : 'held'
      push()
      let timer
      const r = await new Promise(resolve => {
        waiter = { kind, resolve }
        if (state.deadline) timer = setTimeout(() => release({ stop: 'time budget exceeded while paused' }), Math.max(0, state.deadline - Date.now()))
      })
      clearTimeout(timer)
      state.pausedMs += Date.now() - t0
      return { waited: true, ...r }
    },
    end({ outcome, error = null, checks = [] }) {
      if (ended) return
      ended = true
      release({ stop: 'the run ended' })
      Object.assign(state, { status: 'ended', outcome, error: error && redact(String(error), secrets), checks })
      push()
    },
    /** The run's files the dashboard offers after the end: { trace, decisions, screenshot } (paths). */
    files(f) {
      state.files = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string' && v))
      push()
    },
    /** The frame's screenshot, for a model that can read one (null without). */
    frame: i => frames.find(x => x.i === i) ?? null,
    /**
     * After the run: resolves when the person closes the dashboard, when its last window has been gone for
     * IDLE_CLOSE_MS (or none ever connected), or after `maxMs`.
     */
    lingering(maxMs = LINGER_MS) {
      if (closed) return Promise.resolve('closed')
      return new Promise(resolve => {
        const t = setTimeout(() => (closeNow(), resolve('timeout')), maxMs)
        t.unref?.()
        onClose.push(() => (clearTimeout(t), resolve('closed')))
        if (!clients.size) setTimeout(() => !clients.size && closeNow(), IDLE_CLOSE_MS).unref?.()
        state.lingering = true
        state.note = 'The run has ended. The inspector stays open for review: click a step in the trail to see it again. Close it when you are done.'
        push()
      })
    },
    async close() {
      for (const res of clients) res.end()
      clients.clear()
      const closed = new Promise(r => server.close(() => r()))
      server.closeAllConnections?.()
      await closed
    },
  }
}
