// The q-pilot Dashboard page: a session sidebar, the selected session's mirror, timeline and details, and a grid of
// live sessions. It renders what the server streams (/api/events) and sends the controls (/api/control). Everything
// shown is redacted by the runner; page text is rendered as text, never as HTML. The selected session is
// location.hash `#s=<id>`; the legacy single-run server serves the same API as the one session `local`.
const $ = id => document.getElementById(id)
const token = document.querySelector('meta[name="pilot-token"]').content
const tok = encodeURIComponent(token)

let sessions = []
let selected = null
let view = 'session'
let project = null
let state = null
let connected = false
let hover = null
let events = null
let lastFocus = null
let stopped = false
/** A recorded frame on screen instead of the live page (clicked in the timeline, or ← →); null: live. */
let review = null
/** The newest screencast frame of the selected session: { b64, w, h }. */
let liveFrame = null
/** Frame screenshots fetched from /api/frame, by frame number (a dashboard state carries no pixels). */
const frameShots = new Map()
const pending = new Set()

const EYE = '<svg class="eye" viewBox="0 0 16 16" aria-hidden="true"><path class="stroke" d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle class="stroke" cx="8" cy="8" r="1.8" /></svg>'
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const pct = v => (typeof v === 'number' ? `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%` : '—')
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0))
const bar = p => `<span class="track"><span style="width:${(clamp01(p) * 100).toFixed(1)}%"></span></span>`
const dur = ms => {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}
/** data: URL for a base64 image; the page's frames are JPEG, the dev fixture also sends SVG and PNG. */
const imgUrl = b64 => `data:${b64.startsWith('PHN2') ? 'image/svg+xml' : b64.startsWith('iVBOR') ? 'image/png' : 'image/jpeg'};base64,${b64}`
const api = path => `${path}${path.includes('?') ? '&' : '?'}t=${tok}${selected ? `&s=${encodeURIComponent(selected)}` : ''}`
const fail = msg => {
  $('toast').textContent = msg
  $('toast').hidden = false
}
async function post(path, body) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify({ s: selected, ...body }) })
  if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  return r
}

// What the run is doing right now, below the toolbar.
const PHASE = {
  starting: 'Opening the page',
  observing: 'Reading the page',
  paused: 'Held before asking Jev · Next step asks for the next action',
  decided: 'Running the chosen action',
  held: 'Held before running the choice · Execute runs it',
  acted: 'Waiting for the page to settle',
  helping: 'Jev is stuck · waiting for Claude to answer the help request',
  control: 'You have control · click, scroll and type in the mirror; Resume gives the run back',
}
// Outcome → pill label, tone and banner text.
const OUTCOMES = {
  pass: ['Passed', 'ok', 'Jev reported DONE and every check is green'],
  done: ['Done · unverified', 'warn', 'Jev reported DONE; not verified (no checks)'],
  drift: ['Drift', 'warn', 'The run passed, but the page drifted from the recorded flow'],
  flaky: ['Flaky', 'warn', 'The run passed only after a retry'],
  'needs-verify': ['Needs verify', 'warn', 'The run finished but its result is not verified'],
  fail: ['Failed', 'bad', 'The run did not succeed'],
  blocked: ['Blocked', 'bad', 'The run could not finish the task'],
}
const outcomeOf = o => OUTCOMES[o] ?? [o ? `Failed (${o})` : 'Failed', 'bad', 'The run did not succeed']
const TONE = { idle: 'muted', run: 'accent', paused: 'warn', held: 'held', control: 'interactive', ok: 'ok', warn: 'warn', bad: 'bad' }

// ---- Session list and selection ----
const KIND_ICON = {
  chromium: '<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.5" class="stroke" /><circle cx="9" cy="9" r="2.6" class="stroke" /><path class="stroke" d="M9 6.4h5.6M6.7 10.3 3.9 5.5M7 12.4l2.7 4.3" /></svg>',
  'chrome-cdp': '<svg viewBox="0 0 18 18" aria-hidden="true"><circle cx="9" cy="9" r="6.5" class="stroke" /><path class="stroke" d="M6.6 6.8 4.6 9l2 2.2M11.4 6.8l2 2.2-2 2.2M9.9 6.2 8.1 11.8" /></svg>',
  electron: '<svg viewBox="0 0 18 18" aria-hidden="true"><ellipse class="stroke" cx="9" cy="9" rx="6.8" ry="2.7" /><ellipse class="stroke" cx="9" cy="9" rx="6.8" ry="2.7" transform="rotate(60 9 9)" /><ellipse class="stroke" cx="9" cy="9" rx="6.8" ry="2.7" transform="rotate(120 9 9)" /><circle cx="9" cy="9" r="1.2" /></svg>',
}
const BAD_OUTCOME = o => !['pass', 'done', 'drift', 'flaky', 'needs-verify'].includes(o)
function dotOf(x) {
  if (x.status === 'live') return x.id === selected && state?.live?.mode === 'screencast' && !x.secret ? 'live' : 'run'
  if (x.status === 'paused' || x.status === 'helping') return 'held'
  if (x.status === 'incomplete') return 'idle'
  if (x.red || (x.outcome && BAD_OUTCOME(x.outcome))) return 'bad'
  if (x.outcome === 'pass') return 'ok'
  return x.outcome ? 'warn' : 'idle'
}
const dayStart = t => new Date(t).setHours(0, 0, 0, 0)
/** Today's sessions sit under the fixed SESSIONS caption; older ones get their own. */
function dayCaption(t) {
  const d = Math.round((dayStart(Date.now()) - dayStart(t)) / 86_400_000)
  return d <= 0 ? '' : d === 1 ? 'Yesterday' : 'Earlier'
}
const timeOf = t => new Date(t).toLocaleString([], { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' })

function chip(x) {
  const t = x.target ?? { kind: 'chromium', label: '' }
  const cur = x.id === selected
  return `<a class="chip-session${cur ? ' current' : ''}" href="#s=${encodeURIComponent(x.id)}" data-id="${esc(x.id)}" ${cur ? 'aria-current="true"' : ''} title="${esc(`${x.name} · ${t.label}`)}"><span class="kind-icon ${esc(t.kind)}">${KIND_ICON[t.kind] ?? KIND_ICON.chromium}</span><span class="chip-text"><span class="chip-name">${esc(x.name)}</span><span class="chip-sub">${esc(x.subline ?? '')}</span></span><span class="dot ${dotOf(x)}" title="${esc(x.status === 'ended' ? x.outcome ?? 'ended' : x.status)}"></span></a>`
}
// The runs of one Claude Code prompt share a `group` (--prompt-group) and sit under one entry, newest first.
// A session without one (older runs, gate runs) is its own entry.
const URGENCY = ['live', 'run', 'held', 'bad', 'warn', 'ok', 'idle']
/** Groups the user opened or closed by hand; otherwise a group is open while it holds the selected session. */
const groupOpen = new Map()
function entries() {
  const out = []
  const byKey = new Map()
  for (const x of sessions) {
    const key = x.group ?? `s:${x.id}`
    let e = byKey.get(key)
    if (!e) {
      e = { key, items: [] }
      byKey.set(key, e)
      out.push(e)
    }
    e.items.push(x)
  }
  return out
}
function groupChip(e) {
  const [top] = e.items
  const t = top.target ?? { kind: 'chromium', label: '' }
  const dot = e.items.map(dotOf).sort((a, b) => URGENCY.indexOf(a) - URGENCY.indexOf(b))[0]
  const holds = e.items.some(x => x.id === selected)
  const open = groupOpen.has(e.key) ? groupOpen.get(e.key) : holds
  const live = e.items.filter(x => x.status !== 'ended' && x.status !== 'incomplete').length
  const sub = `${e.items.length} runs${live ? ` · ${live} live` : ''} · ${timeOf(top.startedAt)}`
  return `<details class="sess-group${holds ? ' holds' : ''}" data-key="${esc(e.key)}"${open ? ' open' : ''}><summary class="chip-session group-head" title="${esc(`${e.items.length} runs from one prompt`)}"><span class="kind-icon ${esc(t.kind)}">${KIND_ICON[t.kind] ?? KIND_ICON.chromium}</span><span class="chip-text"><span class="chip-name">${esc(top.name)}</span><span class="chip-sub">${esc(sub)}</span></span><span class="count">${e.items.length}</span><span class="dot ${dot}"></span></summary><div class="group-items">${e.items.map(chip).join('')}</div></details>`
}
function renderSidebar() {
  $('sessions-empty').hidden = sessions.length > 0
  let last = null
  $('sessions').innerHTML = entries()
    .map(e => {
      const cap = dayCaption(e.items[0].startedAt)
      const head = cap === last || !cap ? '' : `<div class="cap">${esc(cap)}</div>`
      last = cap
      return head + (e.items.length > 1 ? groupChip(e) : chip(e.items[0]))
    })
    .join('')
  $('sessions-table').innerHTML = sessions
    .map(x => `<tr data-id="${esc(x.id)}"><td><span class="dot ${dotOf(x)}"></span> ${esc(x.name)}</td><td>${esc(x.kind)}</td><td>${esc(x.target?.label ?? '')}</td><td>${esc(x.status === 'ended' ? x.outcome ?? 'ended' : x.status)}</td><td>${esc(timeOf(x.startedAt))}</td><td class="mono">${esc(x.subline ?? '')}</td></tr>`)
    .join('')
  $('project').hidden = !project
  $('project').textContent = project ? `— ${project}` : ''
}
// Only a click counts as the user's choice: a `toggle` also fires when a re-render sets `open`.
$('sessions').addEventListener('click', e => {
  const head = e.target.closest('summary.group-head')
  if (!head) return
  e.preventDefault()
  const d = head.parentElement
  groupOpen.set(d.dataset.key, !d.open)
  renderSidebar()
})
const hashOf = (s, v) => `#${[s ? `s=${encodeURIComponent(s)}` : '', v && v !== 'session' ? `v=${v}` : ''].filter(Boolean).join('&')}`
function go(s, v = view) {
  const h = hashOf(s, v)
  if (location.hash !== h) location.hash = h
  else applyHash()
}
function applyHash() {
  const p = new URLSearchParams(location.hash.slice(1))
  const v = ['grid', 'history', 'settings'].includes(p.get('v')) ? p.get('v') : 'session'
  const s = p.get('s')
  const viewChanged = v !== view
  view = v
  if (viewChanged && v === 'settings') loadConfig()
  if (s && s !== selected) select(s)
  else if (viewChanged) renderViews()
  document.body.classList.remove('nav-open')
  $('nav-toggle').setAttribute('aria-expanded', 'false')
}
function select(id) {
  selected = id
  // Selecting a session opens its group again, even one closed by hand.
  const g = sessions.find(x => x.id === id)?.group
  if (g) groupOpen.delete(g)
  state = null
  review = null
  liveFrame = null
  frameShots.clear()
  $('toast').hidden = true
  connect()
  renderSidebar()
  render()
}
function pickDefault() {
  const x = sessions.find(s => s.status !== 'ended' && s.status !== 'incomplete') ?? sessions[0]
  if (x) history.replaceState(null, '', hashOf(x.id, view))
  if (x) select(x.id)
}
/** `sessions` is {sessions, project, focus} from the dashboard; a bare list is accepted too. */
function onSessions(payload) {
  const list = Array.isArray(payload) ? payload : payload?.sessions ?? []
  sessions = [...list].sort((a, b) => b.startedAt - a.startedAt)
  if (!Array.isArray(payload) && payload?.project) project = payload.project
  const focus = (Array.isArray(payload) ? null : payload?.focus) ?? list.find(x => x.focus)?.id ?? null
  if (focus && focus !== lastFocus && focus !== selected) go(focus, 'session')
  lastFocus = focus
  if (!selected) pickDefault()
  renderSidebar()
  renderViews()
  if (state) renderHeader()
}
/** A server that sends no list: show its one run as the session `local`. */
function synthesize() {
  if (sessions.length || !state) return
  sessions = [{ id: state.id ?? 'local', kind: state.kind ?? 'task', name: state.name ?? 'task', subline: '', target: { kind: 'chromium', label: 'Chromium' }, status: state.status === 'ended' ? 'ended' : 'live', outcome: state.outcome ?? null, red: false, secret: state.screenshots === false, startedAt: state.startedAt, endedAt: state.endedAt ?? null, source: 'live', controls: true }]
  renderSidebar()
}

// ---- Stream ----
function onState(next) {
  if (selected && next.id && next.id !== selected) return
  if (!selected) selected = next.id ?? 'local'
  // Only a run seen ending gets the time it ended; a session opened already ended keeps what the server knows.
  if (next.status === 'ended' && state && state.status !== 'ended') next.endedAt ??= Date.now()
  else if (state?.endedAt) next.endedAt = state.endedAt
  state = next
  setConnection(true)
  synthesize()
  render()
}
function connect() {
  events?.close()
  if (stopped) return
  const es = new EventSource(`/api/events?t=${tok}${selected ? `&s=${encodeURIComponent(selected)}` : ''}`)
  events = es
  es.addEventListener('sessions', m => onSessions(JSON.parse(m.data)))
  es.addEventListener('state', m => onState(JSON.parse(m.data)))
  es.addEventListener('live', m => {
    const l = JSON.parse(m.data)
    if (l.s !== selected || !l.jpeg) return
    liveFrame = { b64: l.jpeg, w: l.w, h: l.h }
    if (!review && state) renderViewport(hotOf(state.decision))
  })
  es.addEventListener('bye', () => {
    stopped = true
    es.close()
    setConnection(false)
    $('bye').hidden = false
    $('conn').hidden = true
  })
  // The legacy single-run server sends its state as unnamed frames.
  es.onmessage = m => onState(JSON.parse(m.data))
  es.onopen = () => setConnection(true)
  es.onerror = () => {
    if (es !== events || stopped) return
    if (state?.status === 'ended' && !sessions.some(x => x.status !== 'ended')) es.close()
    setConnection(false)
    if (state) render()
  }
}
function setConnection(ok) {
  connected = ok
  const ended = state?.status === 'ended'
  $('conn-state').className = `conn ${ok ? 'live' : ended || stopped ? '' : 'lost'}`
  $('conn-text').textContent = ok ? 'Connected' : stopped ? 'Dashboard stopped' : 'Disconnected'
  $('conn').hidden = ok || stopped || !selected
}

// ---- Controls ----
async function control(action) {
  try {
    await post('/api/control', { action })
    $('toast').hidden = true
  } catch (e) {
    fail(`Control "${action}" failed: ${e.message}`)
  }
}
$('pause').addEventListener('click', () => control(state?.mode === 'pause' ? 'run' : 'pause'))
for (const id of ['choose', 'execute', 'stop']) $(id).addEventListener('click', () => control(id))
$('takeover').addEventListener('click', () => control(state?.status === 'control' ? 'run' : 'control'))
$('trace-open').addEventListener('click', () => control('trace'))

/** What the selected session allows: gate and flow runs are replays, so only the trace opens. */
function caps() {
  const kind = state?.kind ?? sessions.find(x => x.id === selected)?.kind ?? 'task'
  const secret = state ? state.screenshots === false || Boolean(state.secret) : false
  const ended = state?.status === 'ended'
  const live = connected && Boolean(state) && !ended
  const driven = kind === 'task' || kind === 'test'
  return { kind, secret, ended, live, driven, holding: driven && live && ['paused', 'held', 'control'].includes(state.status) }
}
function controls() {
  const c = caps()
  const paused = state?.mode === 'pause'
  $('toolbar').hidden = !c.driven || c.ended
  $('pause').disabled = !c.live
  $('pause-label').textContent = paused ? 'Resume' : 'Pause'
  $('pause').title = paused ? 'Run automatically again (Space)' : 'Pause before the next step (Space)'
  $('choose').disabled = !(c.live && state.status === 'paused')
  $('execute').disabled = !(c.live && state.status === 'held')
  const taking = state?.status === 'control'
  $('takeover').disabled = !(c.live && !c.secret && state.status !== 'starting')
  $('takeover').classList.toggle('active', taking)
  $('takeover-label').textContent = taking ? 'Release control' : 'Take control'
  $('takeover').title = c.secret ? 'Off: this run types a secret, so the page is not mirrored' : taking ? 'Give the run back' : 'Hold the run and click, scroll and type in the page yourself'
  $('stop').disabled = !c.live
}

// ---- Review: any recorded step, during the run and after it ----
async function loadFrame(i) {
  if (frameShots.has(i) || pending.has(i)) return
  pending.add(i)
  try {
    const r = await fetch(api(`/api/frame?i=${i}`))
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    const f = await r.json()
    frameShots.set(i, f)
    if (frameShots.size > 24) frameShots.delete(frameShots.keys().next().value)
  } catch {
    frameShots.set(i, null)
  } finally {
    pending.delete(i)
  }
  if (!review && state) renderViewport(hotOf(state.decision))
}
async function openFrame(i) {
  try {
    const r = await fetch(api(`/api/frame?i=${i}`))
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    review = await r.json()
  } catch (e) {
    return fail(`Could not load step: ${e.message}`)
  }
  render()
}
function moveFrame(delta) {
  const frames = state?.frames ?? []
  if (!frames.length) return
  const at = review ? frames.findIndex(f => f.i === review.i) : frames.length
  const next = frames[Math.max(0, Math.min(frames.length - 1, at + delta))]
  if (next) openFrame(next.i)
}
function goLive() {
  review = null
  render()
}
$('prev').addEventListener('click', () => moveFrame(-1))
$('next').addEventListener('click', () => moveFrame(1))
$('live').addEventListener('click', goLive)
$('history').addEventListener('click', e => {
  const i = Number(e.target.closest('tr')?.dataset.frame)
  if (i) openFrame(i)
})
$('filmstrip').addEventListener('click', e => {
  const i = Number(e.target.closest('button')?.dataset.frame)
  if (i) openFrame(i)
})

// ---- Take control: the mirror forwards input as fractions 0..1 of the frame; typed text is never shown ----
const controlOn = () => state?.status === 'control' && caps().live
let inputWarned = false
async function sendInput(ev) {
  try {
    await post('/api/input', { ev })
  } catch (e) {
    if (!inputWarned) fail(`Input was refused: ${e.message}`)
    inputWarned = true
  }
}
const fraction = e => {
  const r = $('shot').getBoundingClientRect()
  return { x: clamp01((e.clientX - r.left) / r.width), y: clamp01((e.clientY - r.top) / r.height) }
}
let clickTimer = null
let textBuf = ''
let textTimer = null
let wheel = { dx: 0, dy: 0, x: 0, y: 0, timer: null }
const flushText = () => {
  clearTimeout(textTimer)
  if (!textBuf) return
  const text = textBuf.slice(0, 200)
  textBuf = ''
  sendInput({ type: 'text', text })
}
const frame = $('frame')
frame.addEventListener('click', e => {
  if (!controlOn()) return
  frame.focus()
  const at = fraction(e)
  clearTimeout(clickTimer)
  clickTimer = setTimeout(() => sendInput({ type: 'click', ...at, button: 'left' }), 220)
})
frame.addEventListener('dblclick', e => {
  if (!controlOn()) return
  clearTimeout(clickTimer)
  sendInput({ type: 'dblclick', ...fraction(e), button: 'left' })
})
frame.addEventListener('contextmenu', e => {
  if (!controlOn()) return
  e.preventDefault()
  sendInput({ type: 'click', ...fraction(e), button: 'right' })
})
frame.addEventListener('wheel', e => {
  if (!controlOn()) return
  e.preventDefault()
  Object.assign(wheel, fraction(e))
  wheel.dx += e.deltaX
  wheel.dy += e.deltaY
  wheel.timer ??= setTimeout(() => {
    const { dx, dy, x, y } = wheel
    wheel = { dx: 0, dy: 0, x: 0, y: 0, timer: null }
    sendInput({ type: 'wheel', x, y, dx: Math.round(dx), dy: Math.round(dy) })
  }, 80)
}, { passive: false })
frame.addEventListener('keydown', e => {
  if (!controlOn() || e.isComposing) return
  if (['Shift', 'Control', 'Alt', 'Meta'].includes(e.key)) return
  e.preventDefault()
  if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
    textBuf += e.key
    clearTimeout(textTimer)
    textTimer = setTimeout(flushText, 120)
    if (textBuf.length >= 200) flushText()
    return
  }
  flushText()
  const key = [e.ctrlKey && 'Control', e.altKey && 'Alt', e.metaKey && 'Meta', e.shiftKey && e.key.length > 1 && 'Shift', e.key === ' ' ? 'Space' : e.key].filter(Boolean).join('+')
  if (/^[\w+\- ]{1,32}$/.test(key)) sendInput({ type: 'key', key })
})
frame.addEventListener('paste', e => {
  if (!controlOn()) return
  e.preventDefault()
  const text = (e.clipboardData?.getData('text') ?? '').slice(0, 200)
  if (text) sendInput({ type: 'text', text })
})

// ---- Jev vision: when Jev sees the screenshot (changed live; applies from the next decision) ----
const VISION_TEXT = {
  off: 'Jev decides from the element list and page text only (~0.3 s a step).',
  gated: 'Jev asks again with the screenshot when it is unsure (p < 0.6, two close targets, or DONE/BLOCKED): about +0.4 s on those steps.',
  always: 'The screenshot goes with every decision: steadier on visual pages, about +0.3–0.5 s every step.',
}
async function setVision(patch) {
  try {
    await post('/api/settings', patch)
  } catch (e) {
    fail(`Vision setting failed: ${e.message}`)
  }
}
$('vision-mode').addEventListener('click', e => {
  const mode = e.target.closest('button')?.dataset.mode
  if (mode) setVision({ mode })
})
$('vision-model').addEventListener('change', () => setVision({ model: $('vision-model').value }))
$('vision-box-toggle').addEventListener('change', () => setVision({ box: $('vision-box-toggle').checked }))
// ---- Where each setting came from, and Save as default (the mod writes the file; the runner never does) ----
const SRC_LABEL = { cli: 'cli', env: 'env', local: 'local', project: 'project', user: 'user', default: 'default' }
const srcChip = (label, key) => {
  const s = state.settings
  const src = s?.sources[key]
  if (!src) return ''
  const changed = s.changed?.includes(key)
  const over = src.overridden?.length ? ` · overrides ${src.overridden.map(o => `${o.scope}=${o.value}`).join(', ')}` : ''
  return `<span class="src">${esc(label)} <span class="chip src-chip ${changed ? 'changed' : esc(src.scope)}" title="${esc(changed ? `Changed here for this run; the setting is ${src.value} (${src.scope})` : `From the ${src.scope} scope${over}`)}">${changed ? 'changed for this run' : esc(SRC_LABEL[src.scope] ?? src.scope)}</span></span>`
}
async function saveDefault() {
  const v = state.vision
  $('save-default').disabled = true
  try {
    await post('/api/settings/save', { scope: $('save-scope').value, keys: { vision: v.mode, visionModel: v.model, box: v.box } })
  } catch (e) {
    fail(`Save failed: ${e.message}`)
    $('save-default').disabled = false
  }
}
$('save-default').addEventListener('click', saveDefault)
function renderSettings() {
  const s = state.settings
  const src = $('vision-src')
  src.hidden = !s
  $('vision-save').hidden = !s?.canSave
  if (!s) return
  src.innerHTML = [srcChip('Mode', 'vision'), srcChip('Model', 'visionModel'), srcChip('Box', 'box')].join('')
  const save = s.save
  $('save-default').disabled = save?.status === 'pending' || Boolean(state.vision?.blocked)
  $('save-note').textContent = !save ? '' : save.status === 'pending' ? `Saving to ${save.scope}…` : save.status === 'saved' ? `Saved: ${save.message ?? `to ${save.scope}`}` : `Not saved: ${save.message}`
  $('save-note').classList.toggle('bad', save?.status === 'error')
}
function renderVision() {
  const v = state.vision
  $('vision-box').hidden = !v
  if (!v) return
  const ended = state.status === 'ended'
  const secret = caps().secret
  const blocked = v.blocked ?? (secret ? 'Screenshots are off for runs that type a secret, so vision is locked.' : null)
  const off = Boolean(blocked) || ended
  for (const b of $('vision-mode').children) {
    b.setAttribute('aria-checked', String(b.dataset.mode === v.mode))
    b.disabled = off
  }
  const sel = $('vision-model')
  if (!sel.options.length) sel.innerHTML = v.models.map(m => `<option value="${esc(m.id)}">${esc(m.label)} · ${esc(m.note)}</option>`).join('')
  if (document.activeElement !== sel) sel.value = v.model
  sel.disabled = off
  const box = $('vision-box-toggle')
  box.checked = v.box
  box.disabled = off
  $('vision-stats').textContent = v.stats?.steps ? `saw ${v.stats.seen} of ${v.stats.steps} steps${v.stats.boxes ? ` · ${v.stats.boxes} box` : ''}` : ''
  const note = $('vision-note')
  note.textContent = blocked ?? (ended ? 'The run has ended.' : `${VISION_TEXT[v.mode]}${v.box ? ' Box rescue: when Jev is stuck, Jev 1.14 locates the control on the screenshot and the run clicks it, before asking Claude.' : ''} Screenshots are sent to TypeSafe.`)
  note.classList.toggle('bad', Boolean(blocked))
  renderSettings()
}

// ---- Title and tab icon follow the run ----
// The tab (and app-window) icon is the q-pilot icon with a badge in the run's tone. Until /icon.svg has loaded,
// the plain icon from the <link> shows.
let iconSvg = null
let lastIcon = ''
let lastTab = null
fetch('/icon.svg')
  .then(r => (r.ok ? r.text() : null))
  .then(text => {
    iconSvg = text?.replace(/<!--[\s\S]*?-->\s*/, '') ?? null
    lastIcon = ''
    if (lastTab) renderTab(...lastTab)
  })
  .catch(() => {})
function renderTab(label, tone) {
  lastTab = [label, tone]
  document.title = `${state?.name ? `${state.name} · ` : ''}${label} · q-pilot Dashboard`
  if (!iconSvg) return
  const color = getComputedStyle(document.documentElement).getPropertyValue(`--q-${TONE[tone] ?? TONE.idle}`).trim()
  if (color === lastIcon) return
  lastIcon = color
  // Top-right corner of the tile, clear of the ring and the pointer.
  const svg = iconSvg.replace('</svg>', `<circle cx="404" cy="108" r="54" fill="${color}" stroke="#0E0F12" stroke-width="16"/></svg>`)
  $('favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  lastIcon = ''
  if (lastTab) renderTab(...lastTab)
})
$('overlays').addEventListener('change', () => ($('boxes').hidden = !$('overlays').checked))

// Keyboard: Space pause/resume, N next step, E execute, Esc stop. Only fires a control whose button is enabled.
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement || t instanceof HTMLSelectElement) return
  if (controlOn() && frame.contains(t)) return
  let id = null
  if (e.key === ' ') {
    if (t instanceof HTMLButtonElement || t instanceof HTMLAnchorElement || t?.tagName === 'SUMMARY') return // let Space activate the focused control
    id = 'pause'
  } else if (e.key === 'n' || e.key === 'N') id = 'choose'
  else if (e.key === 'e' || e.key === 'E') id = 'execute'
  else if (e.key === 'Escape') id = 'stop'
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    return moveFrame(e.key === 'ArrowLeft' ? -1 : 1)
  } else if ((e.key === 'l' || e.key === 'L') && review) return goLive()
  if (!id || $(id).disabled || $('toolbar').hidden) return
  e.preventDefault()
  $(id).click()
})

// Hovering an element row highlights its overlay box.
$('elements').addEventListener('mouseover', e => setHover(e.target.closest('tr')?.dataset.i ?? null))
$('elements').addEventListener('mouseleave', () => setHover(null))
function setHover(i) {
  if (i === hover) return
  hover = i
  for (const b of $('boxes').children) b.classList.toggle('hover', b.dataset.i === hover)
}

function clock() {
  if (!state) return
  const ended = state.status === 'ended'
  const end = ended ? state.endedAt ?? sessions.find(x => x.id === selected)?.endedAt ?? (state.durationMs != null ? state.startedAt + state.durationMs : null) : Date.now()
  const now = end ?? Date.now()
  $('elapsed').textContent = end == null ? '—' : dur(end - state.startedAt)
  const box = $('budget-box')
  box.hidden = !state.deadline
  if (!state.deadline) return
  const total = state.deadline - state.startedAt
  const left = Math.max(0, state.deadline - now)
  $('budget').textContent = ended ? 'ended' : `${dur(left)} left`
  $('budget-bar').style.width = `${ended || total <= 0 ? 0 : clamp01(left / total) * 100}%`
  box.classList.toggle('low', !ended && total > 0 && left / total < 0.15)
}
setInterval(clock, 250)

function pill() {
  const s = state
  if (!s) return ['Connecting…', 'idle']
  if (s.status === 'ended') {
    const [label, tone] = outcomeOf(s.outcome)
    return [`Ended · ${label}`, tone]
  }
  if (s.status === 'control') return ['You have control', 'control']
  if (s.status === 'paused') return ['Paused · waiting for you', 'paused']
  if (s.status === 'held') return ['Choice ready · waiting for you', 'held']
  if (s.status === 'starting') return ['Starting', 'idle']
  if (s.status === 'helping') return ['Asking Claude', 'held']
  return s.mode === 'pause' ? ['Pausing at next step', 'paused'] : ['Running', 'run']
}

function renderHeader() {
  const s = state
  const [label, tone] = pill()
  renderTab(label, tone)
  $('status').textContent = label
  $('pill').className = `pill ${tone}`
  // The phase line keeps its height when empty (style.css), so it is never hidden.
  $('phase').textContent = s.status === 'ended' ? '' : PHASE[s.status] ?? ''
  $('name').textContent = s.name || 'Unnamed task'
  $('mode').textContent = s.status === 'ended' ? '' : s.mode === 'pause' ? 'Mode: step by step' : 'Mode: automatic'
  $('goal').textContent = $('goal').title = s.goal ?? (s.status === 'ended' ? 'Goal not recorded for this run' : 'Waiting for the run to start.')
  $('note').textContent = s.note ?? ''
  $('note').hidden = !s.note
}

const checkText = c => (c && typeof c === 'object' ? Object.entries(c).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : JSON.stringify(c))

function renderResult() {
  const s = state
  const checks = s.checks ?? []
  const green = checks.filter(c => c.ok).length
  $('checks-count').textContent = checks.length ? `${green} of ${checks.length} green` : ''
  $('checks').innerHTML = checks
    .map(c => `<li class="${c.ok ? 'ok' : 'no'}"><span class="m">${c.ok ? '✓' : '✗'}</span><span>${esc(checkText(c.check))}</span><span class="actual">${c.ok ? '' : `found ${esc(JSON.stringify(c.actual))}`}</span></li>`)
    .join('')
  $('checks').hidden = !checks.length
  $('checks-empty').hidden = checks.length > 0
  $('checks-empty').textContent = s.status === 'ended' ? 'This run has no checks.' : 'Checks are evaluated when the run ends.'
  const files = s.files ?? {}
  $('trace-open').hidden = !files.trace
  $('trace-dl').hidden = !files.trace
  $('trace-dl').href = api('/api/file?kind=trace')
  $('decisions-dl').hidden = !files.decisions
  $('decisions-dl').href = api('/api/file?kind=decisions')
  $('links-box').hidden = !(files.trace || files.decisions)
  if (s.status !== 'ended') return ($('result').hidden = true)
  const [, tone, text] = outcomeOf(s.outcome)
  $('result').className = `result ${tone}`
  $('result-icon').textContent = tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '✗'
  $('result-title').textContent = s.outcome === 'pass' && checks.length ? `${text} (${green}/${checks.length})` : text
  const n = (s.history ?? []).length
  $('result-sub').textContent = `Outcome ${s.outcome ?? 'unknown'} · ${n} action${n === 1 ? '' : 's'}${checks.length ? ` · ${green} of ${checks.length} checks green` : ' · no checks'}`
  $('result-error').textContent = s.error ?? ''
  $('result-error').hidden = !s.error
  $('result').hidden = false
}

const hotOf = d => (d?.target ? String(d.target).split(':')[0] : null)

/** The pixels to show: a reviewed frame, else the screencast, else the newest observation. */
function pixelsFor(s) {
  if (review) return review.screenshot ?? null
  if (state.live?.mode === 'screencast' && liveFrame && state.status !== 'ended') return liveFrame.b64
  if (s.screenshot) return s.screenshot
  const last = state.frames?.at(-1)
  if (last?.shot) {
    const f = frameShots.get(last.i)
    if (f === undefined) loadFrame(last.i)
    return f?.screenshot ?? null
  }
  return null
}

function renderViewport(hot) {
  // A recorded frame carries the same fields as the live state (url, title, view, boxes, screenshot).
  const s = review ? { ...state, ...review } : state
  const secret = caps().secret
  const taking = controlOn() && !review
  const px = secret ? null : pixelsFor(s)
  const screencast = !review && state.live?.mode === 'screencast' && Boolean(liveFrame) && state.status !== 'ended'
  const view = screencast && liveFrame.w ? { w: liveFrame.w, h: liveFrame.h } : s.view
  $('url').textContent = s.url || 'about:blank'
  $('title').textContent = s.title || ''
  $('viewsize').textContent = view ? `${view.w} × ${view.h}` : ''
  $('live-tag').className = `live-tag${screencast ? ' on' : ''}`
  $('live-tag').textContent = review ? `Step ${review.step}` : screencast ? 'Live · screencast' : state.status === 'ended' ? 'Ended' : secret ? 'Mirror off' : 'Snapshots'
  $('mirror-note').textContent = review ? 'recorded frame' : taking ? 'you are driving the page · text you type is not shown here' : 'mirror only · the real window runs separately'
  const shown = Boolean(px)
  frame.hidden = !shown
  $('empty').hidden = shown
  frame.classList.toggle('taking', taking)
  $('control-badge').hidden = !taking
  frame.tabIndex = taking ? 0 : -1
  if (taking && !frame.contains(document.activeElement)) frame.focus({ preventScroll: true })
  if (shown) {
    if (frame.dataset.px !== px) {
      $('shot').src = imgUrl(px)
      frame.dataset.px = px
    }
    if (view) frame.style.setProperty('--ar', String(view.w / view.h))
  } else {
    delete frame.dataset.px
    const [title, text, bad] = !connected && state
      ? ['Lost the dashboard connection', 'The last known state is shown. Reload once it is back.', true]
      : secret
        ? ['Screenshots are off for runs that type a secret', 'No pixels leave the browser. Elements and decisions are still shown.', false]
        : state.status === 'ended'
          ? ['No screenshot', 'This session has no stored frame for the step on screen.', false]
          : ['Waiting for the first observation', 'The page appears here once the runner has opened and read it.', false]
    $('empty-title').textContent = title
    $('empty-text').textContent = text
    $('empty').classList.toggle('bad', bad)
  }
  // Boxes are in CSS px of the page viewport; percentages map them onto the scaled screenshot.
  // A box at the top edge keeps its number inside, where the frame does not clip it. Live pixels move on: no stale boxes.
  const bv = s.view
  const boxed = shown && bv && !screencast && !taking
  $('boxes').innerHTML = boxed
    ? (s.boxes ?? []).map(b => `<div class="box${b.i === hot ? ' hot' : ''}${b.i === hover ? ' hover' : ''}${b.rect.y < 14 ? ' in' : ''}" data-i="${esc(b.i)}" style="left:${(100 * b.rect.x) / bv.w}%;top:${(100 * b.rect.y) / bv.h}%;width:${(100 * b.rect.w) / bv.w}%;height:${(100 * b.rect.h) / bv.h}%"><span>${esc(b.i)}</span></div>`).join('')
    : ''
  // Jev's Box (rescue): fractions of the screenshot it was given (CSS px w × h), drawn over the frame.
  const jb = s.box
  if (boxed && jb) {
    const sx = (jb.w ?? bv.w) / bv.w, sy = (jb.h ?? bv.h) / bv.h
    $('boxes').insertAdjacentHTML('beforeend', `<div class="box jev${jb.ok ? '' : ' miss'}" title="Box · ${esc(jb.model)} · confidence ${pct(jb.confidence)} · visible ${pct(jb.present)}" style="left:${jb.left * sx * 100}%;top:${jb.top * sy * 100}%;width:${(jb.right - jb.left) * sx * 100}%;height:${(jb.bottom - jb.top) * sy * 100}%"><span>${jb.ok ? 'Box click' : 'Box (not clicked)'}</span></div>`)
  }
  $('boxes').hidden = !$('overlays').checked
}

// The operation bars have room for this many rows (.bars in style.css); the rest fold into the last one.
const OPS_ROWS = 6

function opsRows(d, s) {
  const ops = Object.entries(d?.operations ?? {}).sort((a, b) => b[1] - a[1])
  if (!ops.length) return `<p class="muted">${s.status === 'ended' ? 'The run ended; no decision is pending.' : 'Operation probabilities appear after Jev answers.'}</p>`
  const row = (op, p, cls = op === d.operation ? ' best' : '') => `<div class="barrow${cls}"><span class="name" title="${esc(op)}">${esc(op)}</span>${bar(p)}<span class="num">${pct(p)}</span></div>`
  if (ops.length <= OPS_ROWS) return ops.map(([op, p]) => row(op, p)).join('')
  const rest = ops.slice(OPS_ROWS - 1)
  const restP = rest.reduce((a, [, p]) => a + p, 0)
  return `${ops.slice(0, OPS_ROWS - 1).map(([op, p]) => row(op, p)).join('')}<div class="barrow rest" title="${esc(rest.map(([op, p]) => `${op} ${pct(p)}`).join(' · '))}"><span class="name">+${rest.length} more</span>${bar(restP)}<span class="num">${pct(restP)}</span></div>`
}

function renderDecision(d, hot) {
  const s = review ? { ...state, ...review, status: 'review' } : state
  const v = d?.vision
  const chip = $('vision-chip')
  chip.hidden = !v?.used
  if (v?.used) chip.innerHTML = `${EYE} ${esc(`${v.model ?? 'image'}${v.before?.operation != null ? ` · p ${pct(v.before.operation)} → ${pct(d.operations?.[d.operation])}` : v.mode === 'always' ? ' · every step' : ''}`)}`
  chip.title = v?.used ? 'This decision saw the screenshot' : ''
  const choice = $('choice')
  choice.textContent = d ? d.label : s.status === 'paused' ? 'Paused before asking Jev' : s.status === 'ended' ? 'Run ended' : 'Waiting for a decision'
  choice.classList.toggle('placeholder', !d)
  choice.title = choice.textContent
  $('latency').textContent = d?.latencyMs != null ? `${d.latencyMs} ms` : '— ms'
  $('confidence').textContent = d ? pct(d.p) : '—'
  $('confidence').classList.toggle('empty', !d)
  $('step').textContent = s.step || '—'
  $('ops').innerHTML = opsRows(d, s)

  const probOf = e => d?.targets?.[e.index] ?? Math.max(-1, ...(e.options ?? []).map(o => d?.targets?.[o.index] ?? -1))
  const els = [...(s.elements ?? [])]
  if (d?.targets) els.sort((a, b) => probOf(b) - probOf(a))
  $('count').textContent = els.length ? els.length : s.boxes?.length ? `${s.boxes.length} on the page` : ''
  $('elements').innerHTML = els
    .map(e => {
      const p = probOf(e)
      const meta = [e.role, (e.operations ?? []).join(' / '), e.value ? `= ${e.value}` : ''].filter(Boolean).join(' · ')
      return `<tr class="${e.index === hot ? 'best' : ''}" data-i="${esc(e.index)}"><td><span class="idx">${esc(e.index)}</span></td><td><span class="el-label">${esc(e.label) || '<span class="muted">(no label)</span>'}</span><span class="el-meta">${esc(meta)}</span></td><td>${p >= 0 ? `<div class="pcell${e.index === hot ? ' best' : ''}">${bar(p)}<span class="num">${pct(p)}</span></div>` : ''}</td></tr>`
    })
    .join('')
  $('elements-empty').hidden = els.length > 0
}

/** Who chose a trail row (Jev, Jev vision, Box rescue, Claude, replay, the person) and the model id behind it. */
function modelCell(r) {
  const who = r.by === 'claude' ? '<span class="effect">Claude</span>'
    : r.by === 'box' ? '<span class="effect end">Box</span>'
      : r.by === 'person' ? '<span class="effect you">You</span>'
        : r.by === 'replay' ? '<span class="who">Replay</span>'
          : `<span class="who">${r.vision ? 'Jev vision' : 'Jev'}</span>`
  const id = r.model ?? (r.by === 'claude' ? 'session' : null)
  return `${who}${id ? `<span class="mdl-id">${esc(id)}</span>` : ''}`
}

function renderTrail() {
  const h = state.history ?? []
  const rows = h.filter(r => !r.end)
  const n = rows.length
  $('steps').textContent = `${n} action${n === 1 ? '' : 's'}`
  const wrap = $('history-wrap')
  const atEnd = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 24
  $('history').innerHTML = h
    .map((r, k) => {
      const eff = r.end ? ['end', r.action === 'DONE' ? 'Jev says done' : 'Jev gives up'] : r.pageChanged == null ? (state.status === 'ended' ? ['wait', 'unknown'] : ['wait', 'settling…']) : r.pageChanged ? ['yes', 'page changed'] : ['no', 'no change']
      return `<tr class="${k === h.length - 1 ? 'latest' : ''}${review && r.frame === review.i ? ' viewing' : ''}" data-frame="${esc(r.frame ?? '')}"><td class="n">${String(r.step).padStart(2, '0')}</td><td class="act">${r.vision || (state.frames ?? []).some(f => f.i === r.frame && f.vision) ? `${EYE} ` : ''}${esc(r.action)}</td><td class="mdl">${modelCell(r)}</td><td class="fx">${r.fixture ? esc(r.fixture) : ''}</td><td><div class="pcell">${bar(r.p)}<span class="num">${pct(r.p)}</span></div></td><td class="num">${r.latencyMs != null ? `${esc(r.latencyMs)} ms` : '—'}</td><td><span class="effect ${eff[0]}">${eff[1]}</span></td></tr>`
    })
    .join('')
  $('history-empty').hidden = h.length > 0
  // Keep the newest row in view unless the user has scrolled back.
  if (atEnd) wrap.scrollTop = wrap.scrollHeight
  const frames = state.frames ?? []
  $('filmstrip').hidden = frames.length < 2
  $('filmstrip').innerHTML = frames.map(f => `<button type="button" data-frame="${esc(f.i)}" class="${review?.i === f.i ? 'on' : ''}${f.help ? ' help' : ''}" title="${esc(`Step ${f.step}${f.label ? ` · ${f.label}` : ''}`)}">${esc(f.step)}</button>`).join('')

  const by = k => rows.filter(r => (r.by ?? 'jev') === k).length
  const changed = rows.filter(r => r.pageChanged).length
  const lat = rows.filter(r => r.latencyMs != null)
  const stat = (k, v) => `<div class="stat"><span class="k">${k}</span><span class="v">${v}</span></div>`
  $('trail-stats').innerHTML = [
    stat('Actions', n),
    stat('By Jev', rows.filter(r => !r.by || r.by === 'jev' || r.by === 'replay').length),
    stat('Vision', rows.filter(r => r.vision).length),
    stat('Box', by('box')),
    stat('Claude', by('claude')),
    stat('You', by('person')),
    stat('Changed', n ? `${changed} of ${n}` : '—'),
    stat('Latency', lat.length ? `${Math.round(lat.reduce((a, r) => a + r.latencyMs, 0) / lat.length)} ms` : '—'),
  ].join('')
}

function renderReview() {
  $('review').hidden = !review
  if (!review) return
  const at = (state.frames ?? []).findIndex(f => f.i === review.i)
  $('review-what').textContent = `step ${review.step}${review.help ? ` · help request (${review.help})` : ''}${review.by === 'claude' ? ' · Claude acted' : ''}`
  $('prev').disabled = at <= 0
  $('next').disabled = at < 0 || at >= state.frames.length - 1
}

// ---- Grid: a live thumbnail per running session, each on its own stream ----
const tiles = new Map()
function renderGrid() {
  const live = view === 'grid' ? sessions.filter(x => x.status === 'live' || x.status === 'paused' || x.status === 'helping') : []
  $('tiles-empty').hidden = view !== 'grid' || live.length > 0
  for (const [id, t] of tiles) {
    if (live.some(x => x.id === id)) continue
    t.es.close()
    t.el.remove()
    tiles.delete(id)
  }
  for (const x of live) {
    let t = tiles.get(x.id)
    if (!t) {
      const el = document.createElement('a')
      el.className = 'tile'
      el.href = `#s=${encodeURIComponent(x.id)}`
      el.innerHTML = '<div class="thumb"><img alt="" draggable="false" hidden /><span class="thumb-empty"></span></div><div class="tile-foot"><span class="kind-icon"></span><span class="chip-text"><span class="chip-name"></span><span class="chip-sub"></span></span><span class="dot"></span></div>'
      $('tiles').append(el)
      const es = new EventSource(`/api/events?t=${tok}&s=${encodeURIComponent(x.id)}`)
      t = { el, es, i: null }
      const img = el.querySelector('img')
      es.addEventListener('live', m => {
        const l = JSON.parse(m.data)
        if (l.s !== x.id || !l.jpeg) return
        img.src = imgUrl(l.jpeg)
        img.dataset.live = '1'
        img.hidden = false
      })
      es.addEventListener('state', async m => {
        const st = JSON.parse(m.data)
        const last = st.frames?.at(-1)
        el.querySelector('.thumb-empty').textContent = st.screenshots === false || st.secret ? 'Screenshots are off' : last ? '' : 'Waiting for the first observation'
        if (!last?.shot || st.live?.mode === 'screencast' || t.i === last.i) return
        t.i = last.i
        const r = await fetch(`/api/frame?t=${tok}&s=${encodeURIComponent(x.id)}&i=${last.i}`).catch(() => null)
        const f = r?.ok ? await r.json().catch(() => null) : null
        if (f?.screenshot && !img.dataset.live) {
          img.src = imgUrl(f.screenshot)
          img.hidden = false
        }
      })
      tiles.set(x.id, t)
    }
    t.el.querySelector('.kind-icon').className = `kind-icon ${x.target?.kind ?? ''}`
    t.el.querySelector('.kind-icon').innerHTML = KIND_ICON[x.target?.kind] ?? KIND_ICON.chromium
    t.el.querySelector('.chip-name').textContent = x.name
    t.el.querySelector('.chip-sub').textContent = x.subline ?? ''
    t.el.querySelector('.dot').className = `dot ${dotOf(x)}`
  }
}

function renderViews() {
  $('session-view').hidden = view !== 'session'
  $('grid-view').hidden = view !== 'grid'
  $('history-view').hidden = view !== 'history'
  $('settings-view').hidden = view !== 'settings'
  // The details panel belongs to one session; other views get its width
  $('shell').classList.toggle('no-panel', view !== 'session')
  $('goto-vision').disabled = !selected
  for (const b of $('views').children) b.classList.toggle('on', b.dataset.view === view)
  renderGrid()
}
$('views').addEventListener('click', e => {
  const v = e.target.closest('button')?.dataset.view
  if (!v) return
  go(selected, view === v ? 'session' : v)
})
$('nav-toggle').addEventListener('click', () => {
  const open = document.body.classList.toggle('nav-open')
  $('nav-toggle').setAttribute('aria-expanded', String(open))
})
$('sessions').addEventListener('click', () => document.body.classList.remove('nav-open'))
$('sessions-table').addEventListener('click', e => {
  const id = e.target.closest('tr')?.dataset.id
  if (id) go(id, 'session')
})
window.addEventListener('hashchange', applyHash)

// ---- Settings page: the theme, and q-pilot's settings through /api/config (the mod writes them) ----
const THEME_KEY = 'q-pilot-theme'
const themeNow = () => {
  try {
    const t = localStorage.getItem(THEME_KEY)
    return t === 'light' || t === 'dark' ? t : 'system'
  } catch {
    return 'system'
  }
}
function renderTheme() {
  const t = themeNow()
  for (const b of $('theme').children) b.setAttribute('aria-checked', String(b.dataset.themeOpt === t))
}
function setTheme(t) {
  if (t === 'light' || t === 'dark') document.documentElement.dataset.theme = t
  else delete document.documentElement.dataset.theme
  try {
    if (t === 'system') localStorage.removeItem(THEME_KEY)
    else localStorage.setItem(THEME_KEY, t)
  } catch {}
  lastIcon = ''
  if (lastTab) renderTab(...lastTab)
  renderTheme()
}
$('theme').addEventListener('click', e => {
  const t = e.target.closest('button')?.dataset.themeOpt
  if (t) setTheme(t)
})
$('goto-vision').addEventListener('click', () => {
  go(selected, 'session')
  document.body.classList.add('panel-open')
  ;($('vision-box').hidden ? $('panel') : $('vision-box')).scrollIntoView({ block: 'start' })
})

const GROUPS = ['Jev vision', 'Helper', 'Dashboard', 'Runs', 'Browser', 'Flows']
const RANK = { default: 0, user: 1, project: 2, local: 3, env: 4, cli: 5 }
// What a viewer sees: a short name (the key stays as secondary text), a one-line help and readable choices.
const LABELS = { helper: 'Helper model', vision: 'Screenshots', visionModel: 'Vision model', box: 'Box rescue', inspector: 'Dashboard for runs', dashboard: 'Playwright Dashboard', dashboardWindow: 'Dashboard window', mode: 'Stop gate', cdpUrl: 'Your own Chrome', node: 'Node command', trust: 'Trust drift', followUp: 'Follow-up', maxStopSeconds: 'Stop gate budget (s)', maxTestSeconds: 'Test budget (s)', maxTaskSeconds: 'Task budget (s)', flowDirs: 'Flow folders' }
const HELPS = { helper: 'Answers when Jev is stuck. "session" asks your chat.', vision: 'When Jev looks at the screenshot.', visionModel: 'The Jev model that sees screenshots.', box: 'Jev 1.14 finds the control when stuck.', inspector: 'Open this Dashboard for each run.', dashboard: 'Also show runs in the Playwright Dashboard.', dashboardWindow: 'Own app window or a browser tab.', mode: 'Which saved flows run when a turn ends.', cdpUrl: 'Run in your Chrome, e.g. http://127.0.0.1:9222. Empty: launch Chromium.', node: 'Command that runs the runner (Node 18+).', trust: 'Accept drift that the turn diff explains.', followUp: 'What happens on a red gate.', maxStopSeconds: 'Time limit of the stop gate.', maxTestSeconds: 'Time limit of pilot_test.', maxTaskSeconds: 'Time limit of pilot_run (paused time counts).', flowDirs: 'Extra folders with flow files.' }
const CHOICES = { vision: { off: 'Off', gated: 'When unsure', always: 'Every step' }, inspector: { on: 'On', pause: 'Pause', off: 'Off' }, dashboardWindow: { app: 'App window', tab: 'Browser tab' }, mode: { off: 'Off', affected: 'Affected', all: 'All' }, followUp: { auto: 'Auto', suggest: 'Suggest', off: 'Off' }, trust: { shadow: 'Shadow', on: 'On' } }
const ADVANCED = new Set(['visionModel', 'box', 'dashboard', 'dashboardWindow', 'cdpUrl', 'node', 'trust', 'followUp', 'maxStopSeconds', 'maxTestSeconds', 'maxTaskSeconds'])
const SCOPE_HINT = { project: 'Shared with the team', local: 'Only you, this project', user: 'Only you, every project' }
const SCOPE_KEY = 'q-pilot-cfg-scope'
let config = null
let drafts = {}
let scope = (() => {
  try {
    const v = localStorage.getItem(SCOPE_KEY)
    return v in SCOPE_HINT ? v : 'project'
  } catch {
    return 'project'
  }
})()
const show = (v, on) => on ? (v.hidden = false) : (v.hidden = true)
const cfgText = v => (Array.isArray(v) ? v.join(', ') : v === undefined || v === null ? '' : String(v))
const isOn = v => v === true || v === 'on' || v === 'true'
const rowText = row => (row.kind === 'bool' ? (isOn(row.value) ? 'on' : 'off') : cfgText(row.value))
const rowScope = row => (row.scopes.includes(scope) ? scope : row.scopes[0] ?? 'user')
const isAdvanced = row => ADVANCED.has(row.key) || row.advanced === true
const isDirty = row => row.key in drafts && drafts[row.key] !== rowText(row)
const dirtyRows = () => (config?.settings ?? []).filter(isDirty)
const heldIn = (row, sc) => row.source === sc || row.overridden?.some(o => o.scope === sc)
function scopeNote(row) {
  const sc = rowScope(row)
  if (RANK[row.source] > (RANK[sc] ?? 0) && row.source !== 'default') return `Overridden by ${row.source}: saving to ${sc} has no effect until that is removed.`
  return ''
}
function cfgControl(row) {
  const cur = key => (key in drafts ? drafts[key] : rowText(row))
  const label = LABELS[row.key] ?? row.key
  if (row.kind === 'enum' || row.kind === 'bool') {
    const opts = row.kind === 'bool' ? ['on', 'off'] : row.options ?? []
    const now = cur(row.key)
    const names = CHOICES[row.key] ?? {}
    if (opts.length > 4) return `<select class="cfg-input" aria-label="${esc(label)}">${opts.map(o => `<option value="${esc(o)}"${o === now ? ' selected' : ''}>${esc(names[o] ?? o)}</option>`).join('')}</select>`
    return `<div class="segmented cfg-seg" style="--n:${opts.length}" role="radiogroup" aria-label="${esc(label)}">${opts.map(o => `<button type="button" role="radio" data-val="${esc(o)}" aria-checked="${o === now}">${esc(names[o] ?? (row.kind === 'bool' ? (o === 'on' ? 'On' : 'Off') : o))}</button>`).join('')}</div>`
  }
  return `<input class="cfg-input" type="text" maxlength="500" value="${esc(cur(row.key))}" aria-label="${esc(label)}"${row.kind === 'number' ? ' inputmode="numeric"' : ''}${row.kind === 'list' ? ' placeholder="comma separated"' : ''} />`
}
function cfgRow(row) {
  const over = row.overridden?.length ? ` · overrides ${row.overridden.map(o => `${o.scope}=${cfgText(o.value)}`).join(', ')}` : ''
  const src = [row.source !== 'default' ? `from ${row.source}` : '', row.personal ? 'user only' : ''].filter(Boolean).join(' · ')
  const note = scopeNote(row)
  return `<div class="cfg-row${isDirty(row) ? ' dirty' : ''}" data-key="${esc(row.key)}"><div class="cfg-text"><div class="cfg-name"><span class="cfg-label">${esc(LABELS[row.key] ?? row.key)}</span><code class="cfg-key">${esc(row.key)}</code>${src ? `<span class="cfg-src" title="${esc(`From the ${row.source} scope${over}`)}">${esc(src)}</span>` : ''}</div><p class="cfg-help" title="${esc(row.help)}">${esc(HELPS[row.key] ?? row.help)}</p><p class="cfg-note">${esc(note)}</p></div><div class="cfg-ctl">${cfgControl(row)}<button type="button" class="cfg-reset" data-act="unset" title="Remove the value from ${esc(rowScope(row))}"${heldIn(row, rowScope(row)) ? '' : ' hidden'}>Reset</button></div></div>`
}
function cfgGroups(rows) {
  const groups = [...GROUPS, ...new Set(rows.map(r => r.group).filter(g => !GROUPS.includes(g)))]
  return groups
    .map(g => ({ g, rs: rows.filter(r => r.group === g) }))
    .filter(x => x.rs.length)
    .map(x => `<section class="cfg-group"><h2 class="cfg-title">${esc(x.g)}</h2>${x.rs.map(cfgRow).join('')}</section>`)
    .join('')
}
function renderBar() {
  const n = dirtyRows().length
  show($('savebar'), n > 0)
  $('dirty-count').textContent = `${n} unsaved change${n === 1 ? '' : 's'}`
}
function renderScope() {
  for (const b of $('cfg-scope').children) b.setAttribute('aria-checked', String(b.dataset.scope === scope))
  const f = config?.files?.[scope]
  $('cfg-scope-hint').textContent = `${SCOPE_HINT[scope]}${f ? ` · ${f}` : ''}. Personal settings always go to user.`
}
function renderConfig() {
  const rows = config?.settings ?? []
  for (const r of rows) if (r.key in drafts && drafts[r.key] === rowText(r)) delete drafts[r.key]
  $('config-rows').innerHTML = cfgGroups(rows.filter(r => !isAdvanced(r)))
  const adv = rows.filter(isAdvanced)
  show($('config-adv'), adv.length > 0)
  $('config-adv-sum').textContent = `Advanced (${adv.length})`
  $('config-adv-rows').innerHTML = cfgGroups(adv)
  renderScope()
  renderBar()
}
function configMessage(text, bad = false) {
  show($('config-msg'), Boolean(text) && !bad)
  $('config-msg').textContent = bad ? '' : text ?? ''
  show($('config-error'), Boolean(text) && bad)
  $('config-error').textContent = bad ? text : ''
}
async function configCall(path, init) {
  try {
    const r = await fetch(path, init)
    const a = await r.json().catch(() => ({}))
    if (a.settings) config = { settings: a.settings, files: a.files ?? config?.files }
    const ok = r.ok && !a.error
    if (!ok) configMessage(a.error ?? `HTTP ${r.status}`, true)
    else configMessage(a.message ?? '')
    renderConfig()
    return ok
  } catch (e) {
    configMessage(`Could not reach the dashboard: ${e.message}`, true)
    return false
  }
}
const loadConfig = () => configCall(`/api/config?t=${tok}`)
const writeConfig = body => configCall('/api/config', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify(body) })
async function saveDrafts() {
  const todo = dirtyRows()
  $('cfg-save').disabled = true
  let n = 0
  for (const row of todo) {
    if (!(await writeConfig({ op: 'set', key: row.key, scope: rowScope(row), value: drafts[row.key] }))) break
    delete drafts[row.key]
    n++
  }
  if (n > 1) configMessage(`Saved ${n} settings.`)
  $('cfg-save').disabled = false
  renderConfig()
}
function setDraft(el, value) {
  const row = config?.settings.find(r => r.key === el.dataset.key)
  if (!row) return
  if (value === rowText(row)) delete drafts[row.key]
  else drafts[row.key] = value
  el.classList.toggle('dirty', isDirty(row))
  for (const b of el.querySelectorAll('[data-val]')) b.setAttribute('aria-checked', String(b.dataset.val === value))
  renderBar()
}
$('settings-view').addEventListener('click', e => {
  const el = e.target.closest('.cfg-row[data-key]')
  if (!el) return
  const val = e.target.closest('[data-val]')?.dataset.val
  if (val !== undefined) return setDraft(el, val)
  if (e.target.closest('[data-act="unset"]')) {
    const row = config?.settings.find(r => r.key === el.dataset.key)
    delete drafts[el.dataset.key]
    if (row) writeConfig({ op: 'unset', key: row.key, scope: rowScope(row) })
  }
})
$('settings-view').addEventListener('input', e => {
  const el = e.target.closest('.cfg-row[data-key]')
  if (el && e.target.classList.contains('cfg-input')) setDraft(el, e.target.value)
})
$('cfg-scope').addEventListener('click', e => {
  const sc = e.target.closest('button')?.dataset.scope
  if (!sc) return
  scope = sc
  try { localStorage.setItem(SCOPE_KEY, sc) } catch {}
  renderConfig()
})
$('cfg-save').addEventListener('click', saveDrafts)
$('cfg-discard').addEventListener('click', () => {
  drafts = {}
  renderConfig()
})

function render() {
  renderViews()
  if (!state) {
    $('name').textContent = sessions.find(x => x.id === selected)?.name ?? 'No session selected'
    return
  }
  const d = review ? review.decision : state.decision
  const hot = hotOf(d)
  renderHeader()
  renderResult()
  renderViewport(hot)
  renderDecision(d, hot)
  renderTrail()
  renderReview()
  renderVision()
  controls()
  clock()
}

renderTheme()
applyHash()
if (!events) connect()
