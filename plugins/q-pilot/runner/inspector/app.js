// The inspector page: renders the state the runner streams (/api/events) and sends the control buttons
// (/api/control). Everything shown is redacted by the runner; page text is rendered as text, never as HTML.
const $ = id => document.getElementById(id)
const token = document.querySelector('meta[name="pilot-token"]').content
let state = null
let connected = false
let hover = null
/** A recorded frame on screen instead of the live page (clicked in the trail, or ← →); null: live. */
let review = null
const tok = encodeURIComponent(token)

const EYE = '<svg class="eye" viewBox="0 0 16 16" aria-hidden="true"><path class="stroke" d="M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8Z" /><circle class="stroke" cx="8" cy="8" r="1.8" /></svg>'
const esc = v => String(v ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c])
const pct = v => (typeof v === 'number' ? `${(v * 100).toFixed(v > 0 && v < 0.01 ? 1 : 0)}%` : '—')
const clamp01 = v => Math.max(0, Math.min(1, Number(v) || 0))
const bar = p => `<span class="track"><span style="width:${(clamp01(p) * 100).toFixed(1)}%"></span></span>`
const dur = ms => {
  const s = Math.max(0, ms) / 1000
  return `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`
}

// What the run is doing right now, below the state pill.
const PHASE = {
  starting: 'Opening the page',
  observing: 'Reading the page',
  paused: 'Held before asking Jev · N chooses the next action',
  decided: 'Running the chosen action',
  held: 'Held before running the choice · E executes it',
  acted: 'Waiting for the page to settle',
  helping: 'Jev is stuck · waiting for Claude to answer the help request',
}
// Outcome → pill label, tone and banner text.
const OUTCOMES = {
  pass: ['Passed', 'ok', 'Jev reported DONE and every check is green'],
  done: ['Done · unverified', 'warn', 'Jev reported DONE — not verified (no checks)'],
  drift: ['Drift', 'warn', 'The run passed, but the page drifted from the recorded flow'],
  blocked: ['Blocked', 'bad', 'The run could not finish the task'],
}
const outcomeOf = o => OUTCOMES[o] ?? [o ? `Failed (${o})` : 'Failed', 'bad', 'The run did not succeed']

async function control(action) {
  try {
    const r = await fetch('/api/control', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify({ action }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
    $('toast').hidden = true
  } catch (e) {
    $('toast').textContent = `Control "${action}" failed: ${e.message}`
    $('toast').hidden = false
  }
}
for (const id of ['choose', 'execute', 'run', 'pause', 'stop', 'close']) $(id).addEventListener('click', () => control(id))
$('trace-open').addEventListener('click', () => control('trace'))

// ---- Review: any recorded step, during the run and after it ----
async function openFrame(i) {
  try {
    const r = await fetch(`/api/frame?i=${i}&t=${tok}`)
    if (!r.ok) throw new Error(`HTTP ${r.status}`)
    review = await r.json()
  } catch (e) {
    $('toast').textContent = `Could not load step: ${e.message}`
    $('toast').hidden = false
    return
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

// ---- Ask Claude ----
const QKEY = 'q-pilot.ask.model'
function askSetup() {
  const a = state.ask
  $('ask-box').hidden = !a
  if (!a) return
  const sel = $('ask-model')
  if (!sel.options.length) {
    let saved = null
    try { saved = localStorage.getItem(QKEY) } catch {}
    sel.innerHTML = a.models.map(m => `<option value="${esc(m.alias)}">${esc(m.label)} · ${esc(m.note)}</option>`).join('')
    sel.value = a.models.some(m => m.alias === saved) ? saved : a.default
  }
  const helper = state.helper?.model
  const id = a.models.find(m => m.alias === sel.value)?.id ?? sel.value
  $('ask-meta').innerHTML = `Answers here: <b>${esc(id)}</b>${a.via === 'cli' ? ' via the claude CLI (reads the screenshot)' : ' via your Claude Code session (page text, no screenshot)'}<br>Jev's help requests: <b>${helper ? esc(helper) : 'the Claude Code session'}</b>`
}
$('ask-model').addEventListener('change', () => {
  try { localStorage.setItem(QKEY, $('ask-model').value) } catch {}
  askSetup()
})
async function ask(question) {
  if (!question.trim()) return
  $('ask-send').disabled = true
  try {
    const frame = review?.i ?? state.frames?.at(-1)?.i ?? null
    const r = await fetch('/api/ask', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify({ question, model: $('ask-model').value, frame }) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
    $('ask-q').value = ''
  } catch (e) {
    $('toast').textContent = `Ask failed: ${e.message}`
    $('toast').hidden = false
  } finally {
    $('ask-send').disabled = false
  }
}
$('ask-form').addEventListener('submit', e => {
  e.preventDefault()
  ask($('ask-q').value)
})
$('ask-q').addEventListener('keydown', e => {
  if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
    e.preventDefault()
    ask($('ask-q').value)
  }
})
$('ask-quick').addEventListener('click', e => {
  const q = e.target.closest('button')?.dataset.q
  if (q) ask(q)
})
/** The few markdown marks models use in a short answer: **bold**, `code`, "- " bullets. Escaped first. */
const md = t => esc(t).replace(/\*\*(.+?)\*\*/g, '<b>$1</b>').replace(/`([^`]+)`/g, '<code>$1</code>').replace(/^- /gm, '• ')
function renderAsks() {
  const asks = state.asks ?? []
  $('answers').innerHTML = asks
    .map(a => `<li><div class="q">${esc(a.question)}</div><div class="meta"><span class="badge">${esc(a.model ?? '')}</span>${a.step ? `<span>step ${esc(a.step)}</span>` : ''}${a.ms != null ? `<span>${(a.ms / 1000).toFixed(1)} s</span>` : ''}</div>${a.pending ? '<div class="pending">Asking…</div>' : a.error ? `<div class="err">${esc(a.error)}</div>` : `<div class="a">${md(a.answer)}</div>`}</li>`)
    .join('')
}

// ---- Jev vision: when Jev sees the screenshot (changed live; applies from the next decision) ----
const VISION_TEXT = {
  off: 'Jev decides from the element list and page text only (~0.3 s a step).',
  gated: 'Jev asks again with the screenshot when it is unsure (p < 0.6, two close targets, or DONE/BLOCKED): about +0.4 s on those steps.',
  always: 'The screenshot goes with every decision: steadier on visual pages, about +0.3–0.5 s every step.',
}
async function setVision(patch) {
  try {
    const r = await fetch('/api/settings', { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify(patch) })
    if (!r.ok) throw new Error((await r.json().catch(() => ({}))).error || `HTTP ${r.status}`)
  } catch (e) {
    $('toast').textContent = `Vision setting failed: ${e.message}`
    $('toast').hidden = false
  }
}
$('vision-mode').addEventListener('click', e => {
  const mode = e.target.closest('button')?.dataset.mode
  if (mode) setVision({ mode })
})
$('vision-model').addEventListener('change', () => setVision({ model: $('vision-model').value }))
$('vision-box-toggle').addEventListener('change', () => setVision({ box: $('vision-box-toggle').checked }))
function renderVision() {
  const v = state.vision
  $('vision-box').hidden = !v
  if (!v) return
  const ended = state.status === 'ended'
  const off = Boolean(v.blocked) || ended
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
  $('vision-stats').textContent = v.stats.steps ? `saw ${v.stats.seen} of ${v.stats.steps} steps${v.stats.boxes ? ` · ${v.stats.boxes} box` : ''}` : ''
  const note = $('vision-note')
  note.textContent = v.blocked ?? (ended ? 'The run has ended.' : `${VISION_TEXT[v.mode]}${v.box ? ' Box rescue: when Jev is stuck, Jev 1.14 locates the control on the screenshot and the run clicks it, before asking Claude.' : ''} Screenshots are sent to TypeSafe.`)
  note.classList.toggle('bad', Boolean(v.blocked))
}

// ---- Title and tab icon follow the run ----
const TONE = { idle: 'muted', run: 'accent', paused: 'warn', held: 'held', ok: 'ok', warn: 'warn', bad: 'bad' }
let lastIcon = ''
let lastTab = null
function renderTab(label, tone) {
  lastTab = [label, tone]
  document.title = `${state?.name ? `${state.name} · ` : ''}${label} · q-pilot`
  const color = getComputedStyle(document.documentElement).getPropertyValue(`--q-${TONE[tone] ?? TONE.idle}`).trim()
  if (color === lastIcon) return
  lastIcon = color
  const svg = `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 16 16'><rect x='1' y='1' width='14' height='14' rx='3.5' fill='${color}'/><path d='M5.2 3.8 11.6 8.3 8.6 9.1 7.3 12Z' fill='white'/><circle cx='4.4' cy='11.6' r='.9' fill='white' opacity='.75'/></svg>`
  $('favicon').href = `data:image/svg+xml,${encodeURIComponent(svg)}`
}
matchMedia('(prefers-color-scheme: dark)').addEventListener('change', () => {
  lastIcon = ''
  if (lastTab) renderTab(...lastTab)
})
$('overlays').addEventListener('change', () => ($('boxes').hidden = !$('overlays').checked))

// Keyboard: Space run/pause, N choose, E execute, Esc stop. Only fires a control whose button is enabled.
document.addEventListener('keydown', e => {
  if (e.metaKey || e.ctrlKey || e.altKey || e.repeat) return
  const t = e.target
  if (t instanceof HTMLInputElement || t instanceof HTMLTextAreaElement) return
  let id = null
  if (e.key === ' ') {
    if (t instanceof HTMLButtonElement || t?.tagName === 'SUMMARY') return // let Space activate the focused control
    id = state?.mode === 'pause' ? 'run' : 'pause'
  } else if (e.key === 'n' || e.key === 'N') id = 'choose'
  else if (e.key === 'e' || e.key === 'E') id = 'execute'
  else if (e.key === 'Escape') id = 'stop'
  else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight') {
    e.preventDefault()
    return moveFrame(e.key === 'ArrowLeft' ? -1 : 1)
  } else if ((e.key === 'l' || e.key === 'L') && review) return goLive()
  if (!id || $(id).disabled) return
  e.preventDefault()
  control(id)
})

// Hovering an element row highlights its overlay box.
$('elements').addEventListener('mouseover', e => setHover(e.target.closest('tr')?.dataset.i ?? null))
$('elements').addEventListener('mouseleave', () => setHover(null))
function setHover(i) {
  if (i === hover) return
  hover = i
  for (const b of $('boxes').children) b.classList.toggle('hover', b.dataset.i === hover)
}

function controls() {
  const live = connected && state && state.status !== 'ended'
  const paused = state?.mode === 'pause'
  $('choose').disabled = !(live && state.status === 'paused')
  $('execute').disabled = !(live && state.status === 'held')
  $('run').disabled = !(live && paused)
  $('pause').disabled = !(live && !paused)
  $('stop').disabled = !live
  const ended = state?.status === 'ended'
  $('close-seg').hidden = !(ended && state.lingering)
  $('close').disabled = !connected
}

function clock() {
  if (!state) return
  const ended = state.status === 'ended'
  const now = ended ? state.endedAt ?? Date.now() : Date.now()
  $('elapsed').textContent = dur(now - state.startedAt)
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
    return [`Run ended · ${label}`, tone]
  }
  if (s.status === 'paused') return ['Paused', 'paused']
  if (s.status === 'held') return ['Choice ready', 'held']
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
  $('phase').textContent = s.status === 'ended' ? '' : PHASE[s.status] ?? ''
  $('name').textContent = s.name || 'Unnamed task'
  $('mode').textContent = s.status === 'ended' ? '' : s.mode === 'pause' ? 'Mode: step by step' : 'Mode: automatic'
  $('goal').textContent = s.goal ?? 'Waiting for the run to start.'
  $('note').textContent = s.note ?? ''
  $('note').hidden = !s.note
}

const checkText = c => (c && typeof c === 'object' ? Object.entries(c).map(([k, v]) => `${k}=${JSON.stringify(v)}`).join(' ') : JSON.stringify(c))

function renderResult() {
  const s = state
  if (s.status !== 'ended') return ($('result').hidden = true)
  const [, tone, text] = outcomeOf(s.outcome)
  const checks = s.checks ?? []
  const green = checks.filter(c => c.ok).length
  $('result').className = `result ${tone}`
  $('result-icon').textContent = tone === 'ok' ? '✓' : tone === 'warn' ? '!' : '✗'
  $('result-title').textContent = s.outcome === 'pass' && checks.length ? `${text} (${green}/${checks.length})` : text
  $('result-sub').textContent = `Outcome ${s.outcome ?? 'unknown'} · ${s.history.length} action${s.history.length === 1 ? '' : 's'}${checks.length ? ` · ${green} of ${checks.length} checks green` : ' · no checks'}`
  $('result-error').textContent = s.error ?? ''
  $('result-error').hidden = !s.error
  $('checks').innerHTML = checks
    .map(c => `<li class="${c.ok ? 'ok' : 'no'}"><span class="m">${c.ok ? '✓' : '✗'}</span><span>${esc(checkText(c.check))}</span><span class="actual">${c.ok ? '' : `found ${esc(JSON.stringify(c.actual))}`}</span></li>`)
    .join('')
  $('checks').hidden = !checks.length
  const files = s.files ?? {}
  $('trace-open').hidden = !files.trace
  $('trace-dl').hidden = !files.trace
  $('trace-dl').href = `/api/file?kind=trace&t=${tok}`
  $('decisions-dl').hidden = !files.decisions
  $('decisions-dl').href = `/api/file?kind=decisions&t=${tok}`
  $('linger-note').textContent = s.lingering ? 'The inspector stays open: review the steps, ask Claude, then close it.' : ''
  $('result-actions').hidden = !(files.trace || files.decisions || s.lingering)
  $('result').hidden = false
}

function renderViewport(hot) {
  // A recorded frame carries the same fields as the live state (url, title, view, boxes, screenshot).
  const s = review ? { ...state, ...review } : state
  $('url').textContent = s.url || 'about:blank'
  $('title').textContent = s.title || ''
  $('viewsize').textContent = s.view ? `${s.view.w} × ${s.view.h}` : ''
  const shown = Boolean(s.screenshot) && s.screenshots
  $('frame').hidden = !shown
  $('empty').hidden = shown
  if (shown) {
    $('shot').src = `data:image/jpeg;base64,${s.screenshot}`
    if (s.view) $('frame').style.setProperty('--ar', String(s.view.w / s.view.h))
  } else {
    const [title, text, bad] = !connected && state
      ? ['Lost the runner connection', 'The last known state is shown. Reload once the runner is back.', true]
      : !s.screenshots
        ? ['Screenshots are off for this run', 'It types a secret fixture, so no pixels leave the browser. Elements and decisions are still shown.', false]
        : s.status === 'ended'
          ? ['No screenshot', 'The run ended before a page was captured.', false]
          : ['Waiting for the first observation', 'The page appears here once the runner has opened and read it.', false]
    $('empty-title').textContent = title
    $('empty-text').textContent = text
    $('empty').classList.toggle('bad', bad)
  }
  // Boxes are in CSS px of the page viewport; percentages map them onto the scaled screenshot.
  // A box at the top edge keeps its number inside, where the frame does not clip it.
  $('boxes').innerHTML = shown && s.view
    ? s.boxes.map(b => `<div class="box${b.i === hot ? ' hot' : ''}${b.i === hover ? ' hover' : ''}${b.rect.y < 14 ? ' in' : ''}" data-i="${esc(b.i)}" style="left:${(100 * b.rect.x) / s.view.w}%;top:${(100 * b.rect.y) / s.view.h}%;width:${(100 * b.rect.w) / s.view.w}%;height:${(100 * b.rect.h) / s.view.h}%"><span>${esc(b.i)}</span></div>`).join('')
    : ''
  // Jev's Box (rescue): fractions of the screenshot it was given (CSS px w × h), drawn over the frame.
  const jb = s.box
  if (shown && s.view && jb) {
    const sx = (jb.w ?? s.view.w) / s.view.w, sy = (jb.h ?? s.view.h) / s.view.h
    $('boxes').insertAdjacentHTML('beforeend', `<div class="box jev${jb.ok ? '' : ' miss'}" title="Box · ${esc(jb.model)} · confidence ${pct(jb.confidence)} · visible ${pct(jb.present)}" style="left:${jb.left * sx * 100}%;top:${jb.top * sy * 100}%;width:${(jb.right - jb.left) * sx * 100}%;height:${(jb.bottom - jb.top) * sy * 100}%"><span>${jb.ok ? 'Box click' : 'Box (not clicked)'}</span></div>`)
  }
  $('boxes').hidden = !$('overlays').checked
}

function renderDecision(d, hot) {
  const s = review ? { ...state, ...review, status: 'review' } : state
  const v = d?.vision
  const chip = $('vision-chip')
  chip.hidden = !v?.used
  if (v?.used) chip.innerHTML = `${EYE} ${esc(`${v.model ?? 'image'}${v.before?.operation != null ? ` · p ${pct(v.before.operation)} → ${pct(d.operations?.[d.operation])}` : v.mode === 'always' ? ' · every step' : ''}`)}`
  chip.title = v?.used ? 'This decision saw the screenshot' : ''
  const choice = $('choice')
  choice.textContent = d ? d.label : s.status === 'paused' ? 'Paused before asking Jev' : s.status === 'ended' ? 'No pending decision' : 'Waiting for a decision'
  choice.classList.toggle('placeholder', !d)
  $('latency').textContent = d?.latencyMs != null ? `${d.latencyMs} ms` : '— ms'
  $('confidence').textContent = d ? pct(d.p) : '—'
  $('step').textContent = s.step || '—'
  const ops = Object.entries(d?.operations ?? {}).sort((a, b) => b[1] - a[1])
  $('ops').innerHTML = ops.length
    ? ops.map(([op, p]) => `<div class="barrow${op === d.operation ? ' best' : ''}"><span class="name" title="${esc(op)}">${esc(op)}</span>${bar(p)}<span class="num">${pct(p)}</span></div>`).join('')
    : '<p class="muted">Operation probabilities appear after Jev answers.</p>'

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

function renderTrail() {
  const h = state.history
  const n = h.filter(r => !r.end).length
  $('steps').textContent = `${n} action${n === 1 ? '' : 's'}`
  const wrap = $('history-wrap')
  const atEnd = wrap.scrollHeight - wrap.scrollTop - wrap.clientHeight < 24
  $('history').innerHTML = h
    .map((r, k) => {
      const eff = r.end ? ['end', r.action === 'DONE' ? 'Jev says done' : 'Jev gives up'] : r.pageChanged === null ? ['wait', 'settling…'] : r.pageChanged ? ['yes', 'page changed'] : ['no', 'no change']
      return `<tr class="${k === h.length - 1 ? 'latest' : ''}${review && r.frame === review.i ? ' viewing' : ''}" data-frame="${esc(r.frame ?? '')}"><td class="n">${String(r.step).padStart(2, '0')}</td><td class="act">${r.by === 'claude' ? '<span class="effect">Claude</span> ' : r.by === 'box' ? '<span class="effect end">Box</span> ' : ''}${(state.frames ?? []).some(f => f.i === r.frame && f.vision) ? `${EYE} ` : ''}${esc(r.action)}</td><td class="fx">${r.fixture ? esc(r.fixture) : ''}</td><td><div class="pcell">${bar(r.p)}<span class="num">${pct(r.p)}</span></div></td><td class="num">${r.latencyMs != null ? `${esc(r.latencyMs)} ms` : '—'}</td><td><span class="effect ${eff[0]}">${eff[1]}</span></td></tr>`
    })
    .join('')
  $('history-empty').hidden = h.length > 0
  // Keep the newest row in view unless the user has scrolled back.
  if (atEnd) wrap.scrollTop = wrap.scrollHeight
}

function renderReview() {
  $('review').hidden = !review
  if (!review) return
  const at = (state.frames ?? []).findIndex(f => f.i === review.i)
  $('review-what').textContent = `step ${review.step}${review.help ? ` · help request (${review.help})` : ''}${review.by === 'claude' ? ' · Claude acted' : ''}`
  $('prev').disabled = at <= 0
  $('next').disabled = at < 0 || at >= state.frames.length - 1
}

function render() {
  const d = review ? review.decision : state.decision
  const hot = d?.target ? String(d.target).split(':')[0] : null
  renderHeader()
  renderResult()
  renderViewport(hot)
  renderDecision(d, hot)
  renderTrail()
  renderReview()
  renderVision()
  askSetup()
  renderAsks()
  controls()
  clock()
}

function setConnection(ok) {
  connected = ok
  const ended = state?.status === 'ended'
  $('conn-state').className = `conn ${ok ? 'live' : ended ? '' : 'lost'}`
  $('conn-text').textContent = ok ? (ended && state.lingering ? 'Run ended · inspector open for review' : 'Connected to the runner') : ended ? 'Inspector closed' : 'Disconnected'
  $('conn').hidden = ok || ended || !state
}

const events = new EventSource(`/api/events?t=${encodeURIComponent(token)}`)
events.onmessage = m => {
  const next = JSON.parse(m.data)
  if (next.status === 'ended' && state?.status !== 'ended') next.endedAt = Date.now()
  else if (state?.endedAt) next.endedAt = state.endedAt
  state = next
  setConnection(true)
  render()
}
events.onerror = () => {
  if (state?.status === 'ended') events.close()
  setConnection(false)
  if (!state) {
    $('status').textContent = 'Lost the runner connection'
    $('pill').className = 'pill bad'
    return
  }
  render()
  if (state.status !== 'ended') {
    $('status').textContent = 'Lost the runner connection'
    $('pill').className = 'pill bad'
  }
}
