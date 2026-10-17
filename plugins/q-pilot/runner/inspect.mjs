// The legacy single-run inspector: a loopback server for one session (`createInspector`), used when a run is started
// without the q-pilot Dashboard (dash-server.mjs). The run's state, frames and gate live in session.mjs; this file is
// the HTTP side. It shows each observation and Jev decision of the pilot loop and can hold it (Pause, Choose next,
// Execute, Run, Stop). Served like jev-ultrafast's demo.py: 127.0.0.1 only, the Host header checked, and a per-run
// token on every API request.
// Every observation is kept as a frame, so the trail can be replayed step by step, during the run and after it: with
// `linger` the dashboard stays up once the run has ended, until the person closes it. "Ask Claude" sends a question
// about the frame on screen to a model the person picks (ask.mjs).
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { existsSync, readFileSync } from 'node:fs'
import { basename } from 'node:path'
import { ACTIONS as SESSION_ACTIONS, SAVE_KEYS, SAVE_SCOPES, VISION_MODELS, VISION_MODES, createSession, summaryOf } from './session.mjs'

export const DEFAULT_PORT = 8767
const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/q-theme.css': ['q-theme.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] }
const ACTIONS = new Set([...SESSION_ACTIONS, 'close'])
/** Allowed once the run has ended (the dashboard stays up for review). */
const AFTER_END = new Set(['close', 'trace'])
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
 *
 * `settings`: { sources, save } from the mod. `sources` is {key: {value, scope, overridden}} for the settings the page
 * shows; `save({ keys, scope })` hands a change to the mod, which writes it (absent: no Save button).
 */
export async function createInspector({ port = DEFAULT_PORT, mode = 'run', asker = null, sessionModel = null, openTrace = null, vision = null, settings = null } = {}) {
  const token = randomBytes(24).toString('base64url')
  const clients = new Set()
  let actual = port, closed = false, ended = false, endedAt = null
  const onClient = [], onClose = []
  const closeNow = () => {
    if (closed) return
    closed = true
    for (const f of onClose.splice(0)) f()
  }
  const session = createSession({
    mode, sessionModel, openTrace, vision,
    settings: settings?.sources ? { sources: settings.sources, canSave: Boolean(settings.save) } : null,
    ask: asker ? { via: asker.via, models: asker.models.map(({ alias, id, label, note }) => ({ alias, id, label, note })), default: asker.models[0].alias } : null,
    transport: {
      push: state => {
        const data = `data: ${JSON.stringify(state)}\n\n`
        for (const res of clients) res.write(data)
      },
      viewers: () => clients.size,
    },
  })
  const { state, push } = session
  const control = action => {
    if (action !== 'close') return session.control(action)
    closeNow()
    push()
    return true
  }
  const frameOf = n => session.frame(n)
  /** The page API lists sessions like the dashboard does; here there is exactly one: `local`. */
  const summary = () => summaryOf({ id: 'local', runId: 'local', flowId: 'local', kind: 'task', name: state.name ?? 'task' }, state, { endedAt })

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
      res.write(`event: sessions\ndata: ${JSON.stringify({ sessions: [summary()], focus: null })}\n\n`)
      res.write(`data: ${JSON.stringify(state)}\n\n`)
      req.on('close', () => {
        clients.delete(res)
        // After the run, a dashboard whose last window is gone is not coming back: close it a little later.
        if (ended && !clients.size) setTimeout(() => !clients.size && closeNow(), IDLE_CLOSE_MS).unref?.()
      })
      for (const f of onClient.splice(0)) f()
      return
    }
    if (url.pathname === '/api/config') {
      const token_ = req.method === 'GET' ? url.searchParams.get('t') : req.headers['x-pilot-token']
      if (token_ !== token) return send(403, '{"error":"bad token"}')
      return send(503, JSON.stringify({ error: 'Settings can be changed only when the dashboard was started by Claude Code (/q-pilot dashboard).' }))
    }
    if (req.method === 'GET' && url.pathname === '/api/sessions') {
      if (url.searchParams.get('t') !== token) return send(403, '{"error":"bad token"}')
      return send(200, JSON.stringify({ sessions: [summary()], project: null, focus: null }))
    }
    if (req.method === 'GET' && url.pathname === '/api/frame') {
      if (url.searchParams.get('t') !== token) return send(403, '{"error":"bad token"}')
      const f = frameOf(Number(url.searchParams.get('i')))
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
        const frame = frameOf(q.frame) ?? session.frameList().at(-1) ?? null
        const row = { id: state.asks.length + 1, question: q.question.slice(0, 1000), model: q.model, step: frame?.step ?? null, pending: true, at: Date.now() }
        state.asks.unshift(row)
        if (state.asks.length > MAX_ASKS) state.asks.pop()
        push()
        const r = await asker.ask({ goal: state.goal, question: row.question, model: q.model, frame, history: state.history })
        Object.assign(row, { pending: false, answer: r.error ? null : session.redact(r.text ?? ''), error: r.error ? session.redact(r.error) : null, model: r.model, label: r.label, ms: r.ms })
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
        // The run reads the vision object at every step: a change applies from the next decision on.
        session.applyVision(v)
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
    start: session.start,
    observed: session.observed,
    decided: session.decided,
    acted: session.acted,
    changed: session.changed,
    boxed: session.boxed,
    helping: session.helping,
    extend: session.extend,
    stale: session.stale,
    gate: session.gate,
    end(r) {
      ended = true
      endedAt = Date.now()
      session.end(r)
    },
    files: session.files,
    frame: frameOf,
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