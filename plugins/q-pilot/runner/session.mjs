// One run's inspector session, runner side: the state the dashboard shows, the frames, and the gate that holds the
// loop. It does no I/O of its own except `<runDir>/<flow>.session.json` at the end: everything that leaves the
// process goes through a `transport` (the legacy single-run server in inspect.mjs, or the dashboard client).
// It only gets redacted data: the elements as sent to Jev, history lines, and screenshots, which are left out when
// the run types a secret fixture. Time spent paused counts against the run's budget: the caller's timeouts do not move.
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { elementIndex } from './snapshot.mjs'
import { redact, redactDeep } from './redact.mjs'

export const ACTIONS = ['pause', 'run', 'choose', 'execute', 'stop', 'trace', 'control']
export const VISION_MODES = ['off', 'gated', 'always']
export const VISION_MODELS = [
  { id: 'jev-1.13.0', label: 'Jev 1.13', note: 'stable (jev-latest)' },
  { id: 'jev-1.14.0', label: 'Jev 1.14', note: 'preview' },
]
export const SAVE_SCOPES = ['user', 'project', 'local']
/** What "Save as default" may store: the vision settings only (never a personal key). */
export const SAVE_KEYS = { vision: v => VISION_MODES.includes(v), visionModel: v => VISION_MODELS.some(m => m.id === v), box: v => typeof v === 'boolean' }
/** The settings of the run's inspector that have a source chip. */
const VISION_KEYS = { vision: 'mode', visionModel: 'model', box: 'box' }
const MAX_HISTORY = 200
const MAX_FRAMES = 120

export const frameMeta = f => ({ i: f.i, step: f.step, url: f.url, title: f.title, label: f.decision?.label ?? null, p: f.decision?.p ?? null, help: f.help ?? null, by: f.by ?? null, shot: Boolean(f.screenshot), vision: Boolean(f.decision?.vision?.used), box: Boolean(f.box) })

const clock = ms => `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
const BAD = new Set(['app-bug', 'blocked', 'error', 'drift', 'env'])

/** A prompt group id (`--prompt-group`): the runs of one Claude Code prompt share it. */
export const GROUP_ID = /^[\w-]{1,64}$/

/** The sidebar chip of a session: `meta` (SessionMeta fields) and its current `state`. */
export function summaryOf(meta, state, extra = {}) {
  const ended = state.status === 'ended'
  const status = ended ? 'ended' : state.status === 'helping' ? 'helping' : ['paused', 'held', 'control'].includes(state.status) ? 'paused' : 'live'
  const endedAt = extra.endedAt ?? null
  const steps = state.history?.length ?? 0
  const elapsed = (endedAt ?? Date.now()) - (state.startedAt ?? meta.startedAt ?? Date.now())
  const outcome = ended ? state.outcome ?? null : null
  return {
    id: meta.id, runId: meta.runId, flowId: meta.flowId, kind: meta.kind, group: meta.group ?? null, name: state.name ?? meta.name,
    subline: `${meta.kind} · ${steps} steps · ${clock(Math.max(0, elapsed))}${outcome ? ` · ${outcome}` : ''}`,
    target: meta.target ?? { kind: 'chromium', label: 'Chromium' },
    status, outcome, red: Boolean(outcome && BAD.has(outcome)),
    secret: Boolean(meta.secret || state.secret),
    startedAt: state.startedAt ?? meta.startedAt, endedAt,
    source: extra.source ?? 'live',
    controls: (meta.kind === 'task' || meta.kind === 'test') && !ended,
  }
}

/**
 * `meta`: { id, runId, flowId, kind, name, target, runDir, secret }. `ask`: the state's ask block (legacy server);
 * `settings`: { sources, canSave }. `transport`: { push(state), frame(f), viewers(), screenshot?(page), page?(page),
 * end?(payload) }; all optional.
 */
export function createSession({ meta = {}, mode = 'run', sessionModel = null, openTrace = null, vision = null, settings = null, ask = null, transport = {} } = {}) {
  const t = { push() {}, frame() {}, viewers: () => 0, ...transport }
  const state = {
    id: meta.id ?? 'local', kind: meta.kind ?? 'task', secret: Boolean(meta.secret), live: null,
    status: 'starting', mode, name: null, goal: null, deadline: null, startedAt: Date.now(), pausedMs: 0, step: 0,
    url: '', title: '', view: null, boxes: [], screenshot: null, screenshots: true,
    elements: [], decision: null, history: [], note: null, outcome: null, error: null, checks: [],
    // Frames without their screenshots (fetched one at a time from /api/frame), the asks, and the run's files.
    frames: [], asks: [], files: {},
    ask,
    helper: sessionModel ? { model: sessionModel } : null,
    // Jev vision as the run uses it now; the dashboard can change it. `blocked`: why it is forced off.
    vision: vision ? { ...vision, models: VISION_MODELS, modes: VISION_MODES, blocked: null, stats: { steps: 0, seen: 0, boxes: 0 } } : null,
    box: null,
    // Where each setting came from, which of the vision ones this page changed for the run, and the last Save.
    settings: settings?.sources ? { sources: settings.sources, canSave: Boolean(settings.canSave), changed: [], save: null } : null,
  }
  const frames = []
  let secrets = [], waiter = null, stopped = false, ended = false

  const push = () => t.push(state)
  const isSecret = () => secrets.length > 0 || state.secret
  const syncChanged = () => {
    if (!state.settings || !state.vision) return
    state.settings.changed = Object.entries(VISION_KEYS).filter(([k, f]) => k in state.settings.sources && state.settings.sources[k].value !== state.vision[f]).map(([k]) => k)
  }
  const release = r => {
    if (!waiter) return
    const w = waiter
    waiter = null
    w.resolve(r)
  }
  /** The frame on screen changed (decision, box, help): its meta list and the transport's copy. */
  const touch = f => {
    state.frames = frames.map(frameMeta)
    t.frame(f)
  }
  const control = action => {
    if (action === 'trace') {
      if (!state.files.trace || !openTrace) return false
      openTrace(state.files.trace)
      state.note = 'Opening the Playwright trace viewer in its own window.'
    } else if (action === 'stop') {
      stopped = true
      release({ stop: 'stopped from the dashboard' })
    } else if (action === 'pause') state.mode = 'pause'
    else if (action === 'control') {
      state.mode = 'pause'
      state.taking = true
      if (waiter) state.status = 'control'
    } else if (action === 'run') {
      state.mode = 'run'
      state.taking = false
      release({})
    } else if (action === 'choose' && waiter?.kind === 'predict') (state.taking = false, release({}))
    else if (action === 'execute' && waiter?.kind === 'execute') (state.taking = false, release({}))
    else return false
    push()
    return true
  }

  /** `<runDir>/<flow>.session.json`: what the dashboard needs to show this run again later. No pixels. */
  const writeSessionFile = () => {
    if (!meta.runDir || !meta.flowId) return null
    const file = join(meta.runDir, `${meta.flowId}.session.json`)
    const body = redactDeep({
      v: 1, id: state.id, kind: state.kind, group: meta.group ?? null, name: state.name ?? meta.name, goal: state.goal, target: meta.target ?? null, secret: state.secret,
      startedAt: state.startedAt, endedAt: Date.now(), outcome: state.outcome, error: state.error, checks: state.checks,
      history: state.history, frames: frames.map(frameMeta),
      vision: state.vision ? { mode: state.vision.mode, model: state.vision.model, box: state.vision.box, stats: state.vision.stats } : null,
      settings: state.settings ? { sources: state.settings.sources } : null,
    }, secrets)
    try {
      mkdirSync(meta.runDir, { recursive: true })
      writeFileSync(file, JSON.stringify(body))
      return file
    } catch {
      return null
    }
  }

  return {
    state,
    control,
    push,
    get secret() { return isSecret() },
    get ended() { return ended },
    get stopped() { return stopped },
    writeSessionFile,
    /** Text for anyone outside the run, with this run's secrets taken out. */
    redact: text => redact(text, secrets),
    /** The dashboard asked for `v` ({mode, model, box}); the run reads the shared vision object at every step. */
    applyVision(v) {
      if (!vision || !state.vision) return false
      if (state.vision.blocked && ((v.mode ?? 'off') !== 'off' || v.box)) return false
      if (v.mode !== undefined) vision.mode = v.mode
      if (v.model !== undefined) vision.model = v.model
      if (v.box !== undefined) vision.box = Boolean(v.box)
      Object.assign(state.vision, { mode: vision.mode, model: vision.model, box: vision.box })
      syncChanged()
      push()
      return true
    },
    setLive(live) {
      state.live = live
      push()
    },
    start({ name, goal, deadline, secrets: s = [] }) {
      secrets = s
      // A screenshot could show a secret fixture: vision is off for such a run, whatever the dashboard asks.
      if (vision && secrets.length) {
        Object.assign(vision, { mode: 'off', box: false })
        Object.assign(state.vision, { mode: 'off', box: false, blocked: 'Vision is off: this run types a secret fixture, so no screenshot leaves the browser.' })
      }
      Object.assign(state, { name, goal: redact(goal ?? '', secrets), deadline: Number.isFinite(deadline) ? deadline : null, status: 'observing', screenshots: !secrets.length, secret: state.secret || secrets.length > 0 })
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
      t.page?.(page)
      if (isSecret()) state.screenshot = null
      else if (t.screenshot) state.screenshot = await t.screenshot(page)
      else if (t.viewers()) {
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 3000 }).catch(() => null)
        state.screenshot = buf ? buf.toString('base64') : null
      } else state.screenshot = null
      const f = { i: frames.length ? frames.at(-1).i + 1 : 1, step, url: state.url, title: state.title, view: state.view, boxes, screenshot: state.screenshot, elements: [], decision: null }
      frames.push(f)
      if (frames.length > MAX_FRAMES) frames.shift()
      touch(f)
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
        touch(f)
      }
      push()
    },
    acted(row) {
      const f = frames.at(-1)
      if (f && row.by === 'claude') {
        f.by = 'claude'
        touch(f)
      }
      // Claude's actions come from the session's helper: its model is the inspector's, not the loop's.
      state.history.push({ ...row, model: row.model ?? (row.by === 'claude' ? sessionModel : null), frame: f?.i ?? null, pageChanged: null })
      if (state.history.length > MAX_HISTORY) state.history.shift()
      state.status = 'acted'
      push()
    },
    /** A step the person took by hand while the run was held. The status stays as it is. */
    person(action) {
      state.history.push({ step: state.step, action, by: 'person', model: null, frame: frames.at(-1)?.i ?? null, pageChanged: null })
      if (state.history.length > MAX_HISTORY) state.history.shift()
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
        touch(f)
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
        touch(f)
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
     * Holds the loop while the session is in pause mode: 'predict' before asking Jev, 'execute' before running a
     * decision. Returns {} (go on), { waited: true } (held, then released), or { stop } with the reason to end.
     */
    async gate(kind) {
      if (stopped) return { stop: 'stopped from the dashboard' }
      if (state.mode === 'run') return {}
      const t0 = Date.now()
      state.status = state.taking ? 'control' : kind === 'predict' ? 'paused' : 'held'
      push()
      let timer
      const r = await new Promise(resolve => {
        waiter = { kind, resolve }
        if (state.deadline) timer = setTimeout(() => release({ stop: 'time budget exceeded while paused' }), Math.max(0, state.deadline - Date.now()))
      })
      clearTimeout(timer)
      state.pausedMs += Date.now() - t0
      return r.detached ? {} : { waited: true, ...r }
    },
    /** Lets go of the loop for good (the dashboard is gone): nobody is left to release a hold. */
    detach() {
      state.mode = 'run'
      state.taking = false
      release({ detached: true })
    },
    end({ outcome, error = null, checks = [] }) {
      if (ended) return
      ended = true
      release({ stop: 'the run ended' })
      Object.assign(state, { status: 'ended', outcome, error: error && redact(String(error), secrets), checks: redactDeep(checks, secrets) })
      writeSessionFile()
      push()
      t.end?.({ outcome, error: state.error, checks: state.checks })
    },
    /** The run's files the dashboard offers after the end: { trace, decisions, screenshot } (paths). */
    files(f) {
      state.files = Object.fromEntries(Object.entries(f).filter(([, v]) => typeof v === 'string' && v))
      push()
    },
    /** The frame's screenshot, for a model that can read one (null without). */
    frame: i => frames.find(x => x.i === i) ?? null,
    frameList: () => frames,
  }
}
