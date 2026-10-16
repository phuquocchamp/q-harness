// A dev and test server for the dashboard page: the page API of the q-pilot Dashboard with canned sessions (a live
// task, a paused test, a red gate, an ended secret run, an Electron target), so the UI can be built and checked
// without a runner. Run it directly: `node runner/inspector/fixture.mjs [port]`.
import { createServer } from 'node:http'
import { randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const STATIC = { '/': ['index.html', 'text/html'], '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'], '/q-theme.css': ['q-theme.css', 'text/css'], '/icon.svg': ['icon.svg', 'image/svg+xml'] }
const VISION_MODELS = [{ id: 'jev-1.13.0', label: 'Jev 1.13', note: 'stable (jev-latest)' }, { id: 'jev-1.14.0', label: 'Jev 1.14', note: 'preview' }]
const ASK = { via: 'mod', default: 'sonnet', models: [{ alias: 'sonnet', id: 'claude-sonnet-5-5', label: 'Sonnet', note: 'balanced' }, { alias: 'opus', id: 'claude-opus-5-5', label: 'Opus', note: 'most capable' }] }
const SAVE_SCOPES = ['user', 'project', 'local']
const ACTIONS = new Set(['pause', 'run', 'choose', 'execute', 'stop', 'trace', 'control'])
const HOLDING = new Set(['paused', 'held', 'control'])
const VIEW = { w: 1280, h: 720 }
const MIN = 60_000
const DAY = 86_400_000

const BOXES = [
  { i: '1', rect: { x: 96, y: 168, w: 260, h: 44 }, label: 'From', role: 'textbox', operations: ['type'] },
  { i: '2', rect: { x: 380, y: 168, w: 260, h: 44 }, label: 'To', role: 'textbox', operations: ['type'] },
  { i: '3', rect: { x: 664, y: 168, w: 180, h: 44 }, label: 'Depart', role: 'button', operations: ['click'] },
  { i: '4', rect: { x: 868, y: 168, w: 140, h: 44 }, label: 'Search flights', role: 'button', operations: ['click'] },
]
const elementsOf = values => BOXES.map(b => ({ index: b.i, label: b.label, role: b.role, operations: b.operations, value: values[b.i] ?? '' }))

/** A fake page as an SVG image (base64): enough to see the mirror, boxes and the live tag. */
function page(title, tick = 0) {
  const fields = BOXES.map(b => `<rect x="${b.rect.x}" y="${b.rect.y}" width="${b.rect.w}" height="${b.rect.h}" rx="6" fill="#fff" stroke="#c9ced8"/><text x="${b.rect.x + 14}" y="${b.rect.y + 28}" font-size="16" fill="#5b6270">${b.label}</text>`).join('')
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${VIEW.w}" height="${VIEW.h}" viewBox="0 0 ${VIEW.w} ${VIEW.h}" font-family="sans-serif"><rect width="100%" height="100%" fill="#eef1f7"/><rect width="100%" height="64" fill="#1f3a8a"/><text x="32" y="40" font-size="24" fill="#fff">${title}</text>${fields}<rect x="96" y="260" width="912" height="300" rx="8" fill="#fff" stroke="#dde1e9"/><circle cx="${140 + (tick % 20) * 40}" cy="620" r="10" fill="#d92d20"/><text x="96" y="690" font-size="14" fill="#8a91a0">frame ${tick}</text></svg>`
  return Buffer.from(svg).toString('base64')
}

function decision(label, operation, p, target) {
  return { label, operation, p, target: `${target}:x`, latencyMs: 310, operations: { [operation]: p, click: (1 - p) * 0.7, type: (1 - p) * 0.3 }, targets: { [target]: p, 4: (1 - p) / 2 }, elements: elementsOf({}) }
}

function build(now, id) {
  const stamp = t => `${new Date(t).toISOString().slice(0, 10).replaceAll('-', '')}-${new Date(t).toISOString().slice(11, 19).replaceAll(':', '')}-${id()}`
  const sessions = new Map()
  const add = ({ name, flow, kind, target, startedAt, status = 'live', outcome = null, red = false, secret = false, subline, extra = {}, steps = 0, frames = true, duration = 41_000 }) => {
    const runId = stamp(startedAt)
    const sid = `${runId}:${flow}`
    const hist = Array.from({ length: steps }, (_, k) => ({ step: k + 1, action: ['type "Prague" into [1] From', 'type "Berlin" into [2] To', 'click [3] Depart', 'click [4] Search flights'][k % 4], p: 0.93 - k * 0.07, latencyMs: 280 + k * 21, model: k === 2 ? 'jev-1.14.0' : 'jev-1.13.0', by: k === 3 ? 'claude' : 'jev', vision: k === 2, frame: k + 1, pageChanged: k !== 1, fixture: k === 0 && secret ? '$env:USER' : null }))
    const fr = frames ? Array.from({ length: steps }, (_, k) => ({ i: k + 1, step: k + 1, url: 'https://flights.example/search', title: 'Flights', view: VIEW, boxes: BOXES.map(({ i, rect }) => ({ i, rect })), screenshot: secret ? null : page('Flights', k), elements: elementsOf(k > 0 ? { 1: 'Prague' } : {}), decision: decision(hist[k].action, hist[k].action.split(' ')[0], hist[k].p, String((k % 4) + 1)), help: null, by: hist[k].by })) : []
    const done = status === 'ended'
    const summary = { id: sid, runId, flowId: flow, kind, name, subline, target, status: done ? 'ended' : status, outcome, red, secret, startedAt, endedAt: done ? startedAt + duration : null, source: done ? 'memory' : 'live', controls: !done && (kind === 'task' || kind === 'test') }
    const state = {
      id: sid, kind, status: done ? 'ended' : status === 'paused' ? 'paused' : 'observing', mode: status === 'paused' ? 'pause' : 'run', name, goal: 'Find the cheapest flight from Prague to Berlin next Friday', deadline: done ? null : now + 3 * MIN, startedAt, endedAt: summary.endedAt, pausedMs: 0, step: steps,
      url: 'https://flights.example/search', title: 'Flights', view: VIEW, boxes: BOXES.map(({ i, rect }) => ({ i, rect })), screenshot: null, screenshots: !secret,
      elements: fr.at(-1)?.elements ?? [], decision: fr.at(-1)?.decision ?? null, history: hist, note: null, outcome, error: null, checks: [],
      frames: fr.map(f => ({ i: f.i, step: f.step, url: f.url, title: f.title, label: f.decision.label, p: f.decision.p, help: null, by: f.by, shot: Boolean(f.screenshot), vision: false, box: false })), asks: [], files: {},
      ask: ASK, helper: { model: 'sonnet' },
      vision: { mode: secret ? 'off' : 'gated', model: 'jev-1.13.0', box: false, models: VISION_MODELS, modes: ['off', 'gated', 'always'], blocked: secret ? 'Vision is off: this run types a secret fixture, so no screenshot leaves the browser.' : null, stats: { steps, seen: secret ? 0 : Math.min(steps, 1), boxes: 0 } },
      box: null, live: { mode: status === 'live' && !secret && kind === 'task' ? 'screencast' : 'snapshots', reason: null },
      settings: { sources: { vision: { value: 'gated', scope: 'project', overridden: [{ scope: 'user', value: 'off' }] }, visionModel: { value: 'jev-1.13.0', scope: 'default', overridden: [] }, box: { value: false, scope: 'default', overridden: [] }, helper: { value: 'sonnet', scope: 'user', overridden: [] } }, canSave: true, changed: [], save: null },
      ...extra,
    }
    sessions.set(sid, { summary, state, frames: fr })
    return sid
  }
  const chromium = { kind: 'chromium', label: 'Chromium 1.64' }
  add({ name: 'task · find-flights', flow: 'find-flights', kind: 'task', target: chromium, startedAt: now - 41_000, steps: 4, subline: 'task · 4 steps · 0:41' })
  add({ name: 'test · checkout', flow: 'checkout', kind: 'test', target: chromium, startedAt: now - 6 * MIN, status: 'paused', steps: 2, subline: 'test · paused at step 2', extra: { status: 'paused', mode: 'pause' } })
  add({ name: 'gate · login', flow: 'login', kind: 'gate', target: chromium, startedAt: now - 20 * MIN, status: 'ended', outcome: 'fail', red: true, steps: 3, subline: 'gate · replay · red', extra: { error: 'check failed: text "Welcome back" not found on the page', files: { trace: '/tmp/x.trace.zip', decisions: '/tmp/x.decisions.json' }, checks: [{ ok: true, check: { url: '/account' } }, { ok: false, check: { text: 'Welcome back' }, actual: 'Sign in failed' }] } })
  add({ name: 'task · sign-in-secret', flow: 'sign-in-secret', kind: 'task', target: { kind: 'chrome-cdp', label: 'Chrome (CDP)' }, startedAt: now - 50 * MIN, status: 'ended', outcome: 'pass', secret: true, steps: 3, subline: 'task · 3 steps · 0:41 · secret', frames: true, extra: { checks: [{ ok: true, check: { url: '/account' } }] } })
  add({ name: 'task · notes-app', flow: 'notes-app', kind: 'task', target: { kind: 'electron', label: 'Electron 33' }, startedAt: now - DAY - 3 * MIN, status: 'ended', outcome: 'drift', steps: 4, subline: 'task · 4 steps · 0:41', extra: { files: { decisions: '/tmp/y.decisions.json' } } })
  // A session rebuilt from history: no goal, no end time in its state, no page-change data, no decision.
  add({ name: 'task · cheapest-flight', flow: 'cheapest-flight', kind: 'task', target: chromium, startedAt: now - 4 * 3_600_000, status: 'ended', outcome: 'blocked', steps: 3, duration: 46_000, subline: 'task · 3 steps · 0:46', extra: { goal: null, endedAt: null, decision: null, elements: [], error: 'blocked: no flights found', history: Array.from({ length: 3 }, (_, k) => ({ step: k + 1, action: 'click [1]', p: null, latencyMs: null, model: null, by: 'jev', frame: null })) } })
  add({ name: 'flow · signup', flow: 'signup', kind: 'flow', target: chromium, startedAt: now - 3 * DAY, status: 'ended', outcome: 'flaky', steps: 2, subline: 'flow · replay · flaky' })
  return sessions
}

const SPECS = [
  { key: 'vision', group: 'Jev vision', kind: 'enum', options: ['off', 'gated', 'always'], scopes: ['user', 'project', 'local'], help: 'When Jev sees the screenshot.', def: 'off' },
  { key: 'box', group: 'Jev vision', kind: 'bool', scopes: ['user', 'project', 'local'], help: 'Box rescue when Jev is stuck.', def: false },
  { key: 'helper', group: 'Helper', kind: 'enum', options: ['sonnet', 'opus', 'haiku'], scopes: ['user'], personal: true, help: 'The model that answers Jev help requests.', def: 'sonnet' },
  { key: 'inspector', group: 'Dashboard', kind: 'enum', options: ['off', 'on', 'pause'], scopes: ['user', 'project', 'local'], help: 'Whether runs open the dashboard.', def: 'on' },
  { key: 'dashboardWindow', group: 'Dashboard', kind: 'enum', options: ['tab', 'app'], scopes: ['user'], personal: true, help: 'Where the dashboard opens. Applies on the next window open.', def: 'tab' },
  { key: 'cdpUrl', group: 'Browser', kind: 'string', scopes: ['user', 'project', 'local'], help: 'Attach to a running Chrome at this URL.', def: '' },
  { key: 'flowDirs', group: 'Flows', kind: 'list', scopes: ['project', 'local'], help: 'Extra folders with flow files.', def: [] },
]
const CONFIG_FILES = { user: '~/.claude/q-pilot.json', project: '.q-pilot/settings.json', local: '.q-pilot/settings.local.json' }

export async function startFixture({ port = 0, token = randomBytes(24).toString('base64url'), config = true } = {}) {
  const layers = { user: { helper: 'opus' }, project: { vision: 'gated' }, local: {} }
  const env = { cdpUrl: 'http://127.0.0.1:9222' }
  const rows = () => SPECS.map(({ def, ...r }) => {
    const found = ['local', 'project', 'user'].filter(sc => Object.hasOwn(layers[sc], r.key))
    const [top, ...lower] = found
    const source = Object.hasOwn(env, r.key) ? 'env' : top ?? 'default'
    return { personal: false, ...r, value: source === 'env' ? env[r.key] : top ? layers[top][r.key] : def, source, overridden: lower.map(scope => ({ scope, value: layers[scope][r.key] })) }
  })
  const answer = extra => ({ ok: true, settings: rows(), files: CONFIG_FILES, ...extra })
  const configSet = q => {
    const spec = SPECS.find(x => x.key === q.key)
    if (!spec) return { error: `unknown setting ${q.key}` }
    if (!spec.scopes.includes(q.scope)) return { error: `${q.key} can only be saved in ${spec.scopes.join(', ')}`, settings: rows(), files: CONFIG_FILES }
    if (q.op === 'unset') {
      delete layers[q.scope][q.key]
      return answer({ message: `removed ${q.key} from ${q.scope} (${CONFIG_FILES[q.scope]})` })
    }
    const options = spec.kind === 'bool' ? ['on', 'off'] : spec.options
    if (options && !options.includes(q.value)) return { error: `${q.key} must be one of ${options.join(', ')}`, settings: rows(), files: CONFIG_FILES }
    layers[q.scope][q.key] = spec.kind === 'bool' ? q.value === 'on' : spec.kind === 'list' ? q.value.split(',').map(x => x.trim()).filter(Boolean) : q.value
    return answer({ message: `saved ${q.key}=${q.value} to ${q.scope} (${CONFIG_FILES[q.scope]})` })
  }
  const sessions = build(Date.now(), () => randomBytes(2).toString('hex'))
  const live = sessions.keys().next().value
  const inputs = []
  const clients = new Set()
  let actual = port
  const list = () => [...sessions.values()].map(x => x.summary).sort((a, b) => b.startedAt - a.startedAt)
  const envelope = () => ({ sessions: list(), project: 'q-harness', focus: null })
  const write = (res, name, data) => res.write(`event: ${name}\ndata: ${JSON.stringify(data)}\n\n`)
  const pushState = id => {
    const x = sessions.get(id)
    for (const c of clients) if (c.s === id) write(c.res, 'state', x.state)
  }
  const pushList = () => {
    for (const c of clients) write(c.res, 'sessions', envelope())
  }
  const touch = x => {
    const { state, summary } = x
    summary.status = state.status === 'ended' ? 'ended' : state.status === 'paused' || state.status === 'held' ? 'paused' : state.status === 'helping' ? 'helping' : 'live'
    summary.outcome = state.outcome
    pushState(state.id)
    pushList()
  }
  let tick = 0
  const timer = setInterval(() => {
    tick++
    const x = sessions.get(live)
    if (!x || x.state.status === 'ended') return
    const jpeg = page('Flights', tick + 4)
    for (const c of clients) if (c.s === live) write(c.res, 'live', { s: live, w: VIEW.w, h: VIEW.h, jpeg })
  }, 700)
  timer.unref()

  const server = createServer((req, res) => {
    const send = (status, body, type = 'application/json') => {
      res.writeHead(status, { 'content-type': `${type}; charset=utf-8`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
      res.end(body)
    }
    const origin = `http://127.0.0.1:${actual}`
    if (req.headers.host !== `127.0.0.1:${actual}`) return send(403, 'Forbidden', 'text/plain')
    const url = new URL(req.url, origin)
    if (req.method === 'GET' && STATIC[url.pathname]) {
      const [file, type] = STATIC[url.pathname]
      return send(200, readFileSync(new URL(`./${file}`, import.meta.url), 'utf8').replace('__TOKEN__', token), type)
    }
    const sid = url.searchParams.get('s')
    if (req.method === 'GET' && url.pathname.startsWith('/api/')) {
      if (url.searchParams.get('t') !== token) return send(403, '{"error":"bad token"}')
      if (url.pathname === '/api/sessions') return send(200, JSON.stringify(list()))
      if (url.pathname === '/api/config') return config ? send(200, JSON.stringify(answer())) : send(503, JSON.stringify({ error: 'Settings can be changed only when the dashboard was started by Claude Code (/q-pilot dashboard).' }))
      if (url.pathname === '/api/events') {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' })
        const c = { res, s: sid }
        clients.add(c)
        write(res, 'sessions', envelope())
        if (sessions.has(sid)) write(res, 'state', sessions.get(sid).state)
        req.on('close', () => clients.delete(c))
        return
      }
      const x = sessions.get(sid)
      if (!x) return send(404, '{"error":"no such session"}')
      if (url.pathname === '/api/frame') {
        const f = x.frames.find(y => y.i === Number(url.searchParams.get('i')))
        return f ? send(200, JSON.stringify(f)) : send(404, '{"error":"no such frame"}')
      }
      if (url.pathname === '/api/file') {
        const file = x.state.files[url.searchParams.get('kind')]
        return file ? send(200, '{}') : send(404, '{"error":"no such file"}')
      }
      return send(404, 'Not found', 'text/plain')
    }
    if (req.method === 'POST' && url.pathname.startsWith('/api/')) {
      if (req.headers['x-pilot-token'] !== token || (req.headers.origin !== undefined && req.headers.origin !== origin)) return send(403, '{"error":"local dashboard requests only"}')
      let body = ''
      req.on('data', c => {
        body += c
        if (body.length > 4096) req.destroy()
      })
      req.on('end', () => {
        let q
        try { q = JSON.parse(body) } catch {}
        if (url.pathname === '/api/config') {
          if (!config) return send(503, JSON.stringify({ error: 'Settings can be changed only when the dashboard was started by Claude Code (/q-pilot dashboard).' }))
          if (!q || !['set', 'unset'].includes(q.op) || !SAVE_SCOPES.includes(q.scope) || typeof q.key !== 'string') return send(400, '{"error":"bad config request"}')
          const a = configSet(q)
          return send(a.error ? 400 : 200, JSON.stringify(a))
        }
        const x = sessions.get(q?.s)
        if (!x) return send(404, '{"error":"no such session"}')
        const { state, summary } = x
        const ended = state.status === 'ended'
        const driven = summary.kind === 'task' || summary.kind === 'test'
        if (url.pathname === '/api/control') {
          if (!ACTIONS.has(q.action)) return send(400, '{"error":"unknown action"}')
          if (q.action === 'trace') {
            state.note = 'Opening the Playwright trace viewer in its own window.'
            return touch(x), send(200, '{"ok":true}')
          }
          if (ended || !driven) return send(409, JSON.stringify({ error: ended ? 'the run has ended' : 'this session cannot be controlled' }))
          if (q.action === 'pause') Object.assign(state, { mode: 'pause', status: 'paused' })
          else if (q.action === 'run') Object.assign(state, { mode: 'run', status: 'observing' })
          else if (q.action === 'choose') state.status = 'held'
          else if (q.action === 'execute') state.status = 'paused'
          else if (q.action === 'control') {
            if (summary.secret) return send(409, '{"error":"no control for a run that types a secret"}')
            Object.assign(state, { mode: 'pause', status: 'control' })
          } else Object.assign(state, { status: 'ended', outcome: 'blocked', error: 'stopped from the dashboard', endedAt: Date.now() }), (summary.endedAt = state.endedAt)
          touch(x)
          return send(200, JSON.stringify({ ok: true, mode: state.mode, status: state.status }))
        }
        if (url.pathname === '/api/input') {
          if (ended || !driven || summary.secret || !HOLDING.has(state.status)) return send(409, '{"error":"input is not available now"}')
          inputs.push({ s: q.s, ev: q.ev })
          const ev = q.ev ?? {}
          const action = ev.type === 'text' ? `typed ${String(ev.text ?? '').length} chars` : ev.type === 'key' ? `press ${ev.key}` : `${ev.type} at (${Math.round(ev.x * 100)}%, ${Math.round(ev.y * 100)}%)`
          state.history.push({ step: state.step, action, p: null, latencyMs: null, model: null, by: 'person', vision: false, frame: null, pageChanged: true })
          pushState(q.s)
          return send(200, '{"ok":true}')
        }
        if (url.pathname === '/api/settings') {
          if (state.vision.blocked && (q.mode ?? 'off') !== 'off') return send(409, JSON.stringify({ error: state.vision.blocked }))
          for (const k of ['mode', 'model', 'box']) if (q[k] !== undefined) state.vision[k] = q[k]
          state.settings.changed = ['vision', 'visionModel', 'box'].filter(k => state.settings.sources[k].value !== state.vision[{ vision: 'mode', visionModel: 'model', box: 'box' }[k]])
          pushState(q.s)
          return send(200, '{"ok":true}')
        }
        if (url.pathname === '/api/settings/save') {
          if (!SAVE_SCOPES.includes(q.scope) || !q.keys || typeof q.keys !== 'object') return send(400, '{"error":"bad save request"}')
          const row = { status: 'pending', scope: q.scope, keys: q.keys, message: null }
          state.settings.save = row
          pushState(q.s)
          setTimeout(() => {
            Object.assign(row, { status: 'saved', message: `to ${q.scope} settings` })
            pushState(q.s)
          }, 300)
          return send(200, JSON.stringify({ ok: true, pending: true }))
        }
        if (url.pathname === '/api/ask') {
          if (ended && summary.secret) return send(409, '{"error":"Ask is off after a run that typed a secret"}')
          if (typeof q.question !== 'string' || !q.question.trim()) return send(400, '{"error":"a question is required"}')
          const row = { id: state.asks.length + 1, question: q.question.slice(0, 1000), model: q.model, step: state.step, pending: true, at: Date.now() }
          state.asks.unshift(row)
          pushState(q.s)
          setTimeout(() => {
            Object.assign(row, { pending: false, answer: 'The **From** field is filled; `click [4]` runs the search.', ms: 900 })
            pushState(q.s)
          }, 300)
          return send(200, JSON.stringify(row))
        }
        send(404, '{"error":"unknown endpoint"}')
      })
      return
    }
    send(404, 'Not found', 'text/plain')
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', () => {
      actual = server.address().port
      resolve()
    })
  })
  return {
    url: `http://127.0.0.1:${actual}/`,
    port: actual,
    token,
    inputs,
    ids: { live, ...Object.fromEntries([...sessions.values()].map(x => [x.summary.flowId, x.summary.id])) },
    async close() {
      clearInterval(timer)
      for (const c of clients) c.res.end()
      const closed = new Promise(r => server.close(() => r()))
      server.closeAllConnections?.()
      await closed
    },
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const f = await startFixture({ port: Number(process.argv[2]) || 8768 })
  console.log(`q-pilot dashboard fixture: ${f.url}#s=${encodeURIComponent(f.ids.live)}`)
}
