// A runner's side of the q-pilot Dashboard: registers one session per flow with dash-server.mjs and gives the pilot loop
// the same inspector it has always had (session.mjs), with a remote transport behind it. The dashboard is optional by
// rule: pushes are fire-and-forget with short timeouts, and after 3 failures in a row or a dropped command stream the
// client detaches: it pushes nothing more, lets go of any hold, and the run goes on as if no inspector existed.
// While someone watches, a CDP screencast (screencast.mjs) feeds the live view and take control (never for a run that
// types a secret); without one the dashboard gets a screenshot per observation as before.
import { readFileSync } from 'node:fs'
import { createSession } from './session.mjs'

const REGISTER_MS = 1500
const CALL_MS = 1500
const FRAME_MS = 3000
const DEBOUNCE_MS = 50
const END_DELAY_MS = 20
const LIVE_FALLBACK_MS = 2000
const MAX_FAILS = 3
const HOLDING = ['paused', 'held', 'control']

/** The running dashboard's descriptor from `env.Q_PILOT_DASH_FILE` (for `root` when given), or null. */
export function readDash(env = process.env, root = null) {
  const file = env.Q_PILOT_DASH_FILE
  if (!file) return null
  try {
    const d = JSON.parse(readFileSync(file, 'utf8'))
    if (d?.v !== 1 || typeof d.url !== 'string' || typeof d.runnerToken !== 'string' || !Number.isInteger(d.port)) return null
    if (root && d.root !== root) return null
    if (new URL(d.url).hostname !== '127.0.0.1') return null
    return d
  } catch {
    return null
  }
}

const MAX_ELEMENTS = 200
/** The element list can be long on a big page; the dashboard needs the first screens of it. */
const capElements = x => (x && Array.isArray(x.elements) && x.elements.length > MAX_ELEMENTS ? { ...x, elements: x.elements.slice(0, MAX_ELEMENTS) } : x)
const capFrame = f => ({ ...capElements(f), decision: capElements(f.decision) })

const loadScreencast = () => import('./screencast.mjs').catch(() => null)

/**
 * Registers the session and returns its facade (the methods of createInspector's return), or null when the dashboard does
 * not accept it within 1500 ms. `meta`: SessionMeta (id, runId, flowId, kind, name, target, runDir, goal, open, mode,
 * settings, helper, vision, secret). `opts`: { vision, openTrace, screencast, debounceMs, fallbackMs } (`screencast` replaces the
 * module, for tests).
 */
export async function connectSession(desc, meta, { vision = null, openTrace = null, screencast, debounceMs = DEBOUNCE_MS, fallbackMs = LIVE_FALLBACK_MS } = {}) {
  const id = meta.id ?? `${meta.runId}:${meta.flowId}`
  const base = new URL('/rpc/sessions', desc.url)
  const auth = { 'x-q-runner': desc.runnerToken }
  const route = (...parts) => `${base.href}/${encodeURIComponent(id)}${parts.length ? `/${parts.join('/')}` : ''}`
  let reg
  try {
    reg = await fetch(base, {
      method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, signal: AbortSignal.timeout(REGISTER_MS),
      body: JSON.stringify({ id, runId: meta.runId, flowId: meta.flowId, kind: meta.kind, group: meta.group ?? null, name: meta.name, target: meta.target, runDir: meta.runDir, secret: Boolean(meta.secret), goal: meta.goal ?? null, startedAt: meta.startedAt ?? Date.now(), mode: meta.mode, open: Boolean(meta.open) }),
    })
  } catch {
    return null
  }
  if (reg.status !== 201) return null

  let detached = false, closed = false, viewers = 0, fails = 0
  let stateDirty = false, timer = null, flushing = null, endTimer = null, endPayload = null, endSent = false
  const pendingFrames = new Map()
  const abort = new AbortController()

  const detach = () => {
    if (detached) return
    detached = true
    clearTimeout(timer)
    abort.abort()
    stopLive()
    session.detach()
  }
  const call = async (path, init, ms = CALL_MS) => {
    if (detached) return false
    try {
      const r = await fetch(route(...path), { ...init, headers: { ...auth, ...init.headers }, signal: AbortSignal.timeout(ms) })
      // A refusal (4xx) says the request was bad, not that the dashboard is gone.
      if (r.status >= 500) throw new Error(`HTTP ${r.status}`)
      fails = 0
      return r.ok
    } catch {
      if (++fails >= MAX_FAILS) detach()
      return false
    }
  }
  const json = (path, body, ms) => call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }, ms)

  const flush = () => {
    clearTimeout(timer)
    timer = null
    flushing = (flushing ?? Promise.resolve()).then(async () => {
      for (const [i, f] of [...pendingFrames]) {
        pendingFrames.delete(i)
        await json(['frames'], capFrame(f), FRAME_MS)
      }
      if (stateDirty) {
        stateDirty = false
        await json(['state'], { ...capFrame(session.state), screenshot: null })
      }
    }).catch(() => {})
    return flushing
  }
  const schedule = () => {
    if (detached || timer) return
    timer = setTimeout(flush, debounceMs)
    timer.unref?.()
  }
  const sendEnd = async () => {
    if (endSent || !endPayload || detached) return
    endSent = true
    clearTimeout(endTimer)
    await flush()
    await json(['end'], { ...endPayload, files: session.state.files })
  }

  // ---- screencast ------------------------------------------------------------------------------------------------
  let sc, currentPage = null, liveRun = null, latest = null, liveActive = false, syncing = Promise.resolve(), fallbackTimer = null
  let livePending = null, liveBusy = false
  const getSc = async () => (sc === undefined ? (sc = screencast !== undefined ? screencast : await loadScreencast()) : sc)
  const secret = () => session.secret

  const sendLive = () => {
    if (liveBusy || detached || !livePending) return
    const { buf, meta: m } = livePending
    livePending = null
    liveBusy = true
    const w = m?.deviceWidth ?? currentPage?.viewportSize?.()?.width ?? 0, h = m?.deviceHeight ?? currentPage?.viewportSize?.()?.height ?? 0
    call(['live'], { method: 'POST', headers: { 'content-type': 'image/jpeg', 'x-q-w': String(Math.round(w)), 'x-q-h': String(Math.round(h)), 'x-q-ts': String(Date.now()) }, body: buf }, FRAME_MS)
      .finally(() => {
        liveBusy = false
        sendLive()
      })
  }
  const onFrame = (buf, m) => {
    latest = { buf, meta: m }
    clearTimeout(fallbackTimer)
    if (!liveActive) {
      liveActive = true
      session.setLive({ mode: 'screencast', reason: null })
    }
    livePending = { buf, meta: m }
    sendLive()
  }
  const stopLive = () => {
    clearTimeout(fallbackTimer)
    const run = liveRun
    liveRun = null
    liveActive = false
    latest = null
    livePending = null
    return run ? run.stop().catch(() => {}) : Promise.resolve()
  }
  const startLive = async page => {
    const mod = await getSc()
    if (!mod?.startLive) return session.setLive({ mode: 'snapshots', reason: 'The live view is not available in this runner.' })
    try {
      liveRun = await mod.startLive(page, onFrame)
    } catch (e) {
      liveRun = null
      return session.setLive({ mode: 'snapshots', reason: `Live view is off (${String(e.message ?? e).slice(0, 120)}): showing a snapshot per step.` })
    }
    // No frame within 2 s (a hidden window, a browser that does not stream): snapshots per step until frames arrive.
    fallbackTimer = setTimeout(() => {
      if (liveActive || !liveRun) return
      session.setLive({ mode: 'snapshots', reason: 'The browser sent no live frames: showing a snapshot per step.' })
    }, fallbackMs)
    fallbackTimer.unref?.()
  }
  /** Runs one at a time: the screencast follows viewers and the page the run is on. */
  const syncLive = () => {
    syncing = syncing.then(async () => {
      const want = viewers > 0 && !secret() && !detached && !closed && !session.ended && currentPage
      if (liveRun && (!want || liveRun.page !== currentPage)) {
        await stopLive()
        if (!want && !detached && !secret()) session.setLive({ mode: 'off', reason: 'No one is watching.' })
      }
      if (want && !liveRun) await startLive(currentPage)
    }).catch(() => {})
    return syncing
  }

  // ---- commands --------------------------------------------------------------------------------------------------
  const reply = (cid, r) => json(['reply'], { cid, ...r }, CALL_MS)
  const handle = async cmd => {
    if (cmd.type === 'viewers') {
      viewers = Number(cmd.n) || 0
      return syncLive()
    }
    const done = r => reply(cmd.cid, r)
    try {
      if (cmd.type === 'control') return done({ ok: session.control(cmd.action) !== false })
      if (cmd.type === 'settings') {
        const v = secret() ? { mode: 'off', box: false } : { mode: cmd.mode, model: cmd.model, box: cmd.box }
        return done({ ok: session.applyVision(v) })
      }
      if (cmd.type === 'redact') return done({ ok: true, value: (Array.isArray(cmd.texts) ? cmd.texts : []).map(t => session.redact(String(t))) })
      if (cmd.type === 'input') {
        if (secret() || !HOLDING.includes(session.state.status) || !currentPage) return done({ ok: false, error: 'take control is not available now' })
        const mod = await getSc()
        if (!mod?.sendInput) return done({ ok: false, error: 'take control is not available in this runner' })
        const text = await mod.sendInput(currentPage, cmd.ev, latest?.meta ?? null)
        if (text) session.person(text)
        return done({ ok: true })
      }
      return done({ ok: false, error: 'unknown command' })
    } catch (e) {
      return done({ ok: false, error: String(e.message ?? e).slice(0, 200) })
    }
  }
  const listen = async () => {
    try {
      const res = await fetch(route('commands'), { headers: auth, signal: abort.signal })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const dec = new TextDecoder()
      let buf = ''
      for await (const chunk of res.body) {
        buf += dec.decode(chunk, { stream: true })
        for (let k; (k = buf.indexOf('\n\n')) >= 0; ) {
          const block = buf.slice(0, k)
          buf = buf.slice(k + 2)
          const line = block.split('\n').find(l => l.startsWith('data: '))
          if (!line) continue
          try { handle(JSON.parse(line.slice(6))).catch(() => {}) } catch {}
        }
      }
    } catch {}
    // The dashboard is gone (or we closed): nobody is left to release a hold.
    // The server closes this stream when it takes the end: late pushes (files after the end) still go out.
    if (!closed && !endSent) detach()
  }

  const session = createSession({
    meta: { ...meta, id }, mode: meta.mode ?? 'run', sessionModel: meta.helper?.model ?? null, openTrace, vision,
    settings: meta.settings?.sources ? { sources: meta.settings.sources, canSave: true } : null,
    transport: {
      push: () => {
        stateDirty = true
        schedule()
      },
      frame: f => {
        pendingFrames.set(f.i, f)
        schedule()
      },
      viewers: () => viewers,
      page: page => {
        if (page === currentPage) return
        currentPage = page
        latest = null
        if (liveRun) syncLive()
      },
      async screenshot(page) {
        if (liveActive && latest) return latest.buf.toString('base64')
        if (viewers <= 0) return null
        const buf = await page.screenshot({ type: 'jpeg', quality: 55, timeout: 3000 }).catch(() => null)
        return buf ? buf.toString('base64') : null
      },
      end: payload => {
        endPayload = payload
        stopLive()
        endTimer = setTimeout(sendEnd, END_DELAY_MS)
        endTimer.unref?.()
      },
    },
  })
  listen()

  return {
    url: `${desc.url}#s=${id}`,
    id,
    get clients() { return viewers },
    get detached() { return detached },
    state: session.state,
    control: session.control,
    waitForClient: () => Promise.resolve(true),
    start(a) {
      session.start(a)
      if (secret()) session.setLive({ mode: 'off', reason: 'This run types a secret fixture: no live view.' })
      else if (currentPage) syncLive()
    },
    async observed(page, snap, step) {
      await session.observed(page, snap, step)
      if (!liveRun && viewers > 0) syncLive()
    },
    decided: session.decided,
    acted: session.acted,
    changed: session.changed,
    boxed: session.boxed,
    helping: session.helping,
    extend: session.extend,
    stale: session.stale,
    gate: session.gate,
    end: session.end,
    files: session.files,
    frame: session.frame,
    lingering: () => Promise.resolve('closed'),
    /** Sends what is still pending (the end of the session included) and lets go. Never closes the dashboard. */
    async close() {
      if (closed) return
      await sendEnd()
      await flush()
      closed = true
      abort.abort()
      await stopLive()
      await syncing
    },
  }
}
