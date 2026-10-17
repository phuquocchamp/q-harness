// The pilot loop: Jev picks each action until DONE, BLOCKED or the budget runs out. In task mode a `helper` (see
// help.mjs) hands the run to Claude where Jev is stuck: a loop, BLOCKED, a bot wall, low confidence, or a DONE no
// check backs. Claude answers with a few concrete actions and either keeps the turn, gives it back, or ends the run.
import { observe, elementIndex, pathOf } from './snapshot.mjs'
import { perform, toStep, describe, onLogin, canPressEnter, trackNetwork } from './act.mjs'
import { askBox, chooseAction, JevError } from './jev.mjs'
import { redact } from './redact.mjs'
import { traced } from './driver.mjs'

const MAX_IDLE = 3 // CLICK, TYPE_TEXT, SELECT, PRESS_ENTER that changed nothing
const MAX_IDLE_PASSIVE = 10 // WAIT and scroll have their own allowance: waiting for a slow page is legitimate
const PASSIVE = new Set(['wait', 'scroll'])
/** Typing the same fixture into the same field this often is a loop (e.g. a multi-select box that keeps adding). */
const MAX_SAME_FILL = 2
/** A fixture typed this often anywhere is not offered again: the run is going round in circles. */
const MAX_KEY_FILLS = 4
/** The same click this many times in a row (a dropdown toggled open and shut) is a loop: it is not offered until something else runs. */
const MAX_SAME_CLICK = 3
/** A sequence of 2..MAX_CYCLE actions run twice in a row (fill → search → back, fill → search → back) is a loop. */
const MAX_CYCLE = 5
/** This many decisions in a row below LOW_P: Jev is guessing; with a helper, Claude is asked. */
const LOW_P = 0.25
const MAX_LOW = 3
/** A DONE or BLOCKED decided on a page that changed before it was accepted is asked again, at most this often in a row. */
const MAX_STALE_END = 2
/** Steps added once when Claude hands a run back after the budget is spent. */
const BUDGET_EXTRA = 15
/** Green checks are looked at again after this long before they end a run (a page still settling). */
const CHECKS_AGAIN_MS = 300
/**
 * A DONE whose checks are red, with no helper to fix it, is refused once: DONE is not offered for NO_DONE_STEPS
 * steps so Jev finishes the form (arXiv: the sort chosen, "Go" never clicked). It would grade `fail` anyway.
 */
const MAX_FALSE_DONE = 1
const NO_DONE_STEPS = 3
/** Box rescue: at most this many per run, and only above these (Box confidence, Noul "visible at all"). */
const MAX_RESCUE = 3
const BOX_MIN = 0.5
const PRESENT_MIN = 0.6
/** Jev image limits (docs.typesafe.ai/images): each side 256..1568 px, not resized by the server. */
const IMG_MIN = 256
const IMG_MAX = 1568
/** Vision settings, shared with the inspector (it may change them during the run): read at every step. */
export const visionDefaults = () => ({ mode: 'off', model: 'jev-1.13.0', box: false })
/** The viewport as JPEG in CSS px, cut to Jev's size limits; null when it cannot be sent. */
async function shotOf(page) {
  const v = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })).catch(() => null))
  if (!v) return null
  const width = Math.min(v.width, IMG_MAX), height = Math.min(v.height, IMG_MAX)
  if (width < IMG_MIN || height < IMG_MIN) return null
  const buf = await page.screenshot({ type: 'jpeg', quality: 70, scale: 'css', clip: { x: 0, y: 0, width, height }, timeout: 3000 }).catch(() => null)
  return buf ? { data_base64: buf.toString('base64'), format: 'jpg', width, height } : null
}
const clickKey = a => `${a.role}|${a.name}`
const fillKey = (a, fixture) => `${a.role}|${a.name}|${fixture}`
const fieldKey = a => `${a.role}|${a.name}`
/**
 * A page with nothing to act on is mid-animation (a dialog sliding in over a backdrop) or still loading (a booking
 * engine's app after a search): look again before asking Jev, which can only answer WAIT or BLOCKED there.
 */
const EMPTY_WAIT_MS = 10000
/** A click that changed nothing is tried once more after this pause: widgets often ignore clicks until their script is ready. */
const RETRY_CLICK_MS = 500
const actionable = snap => snap.actions.some(a => a.node !== undefined)
async function observeSettled(page, deadline = () => Infinity) {
  let snap = await observe(page)
  for (const end = Math.min(Date.now() + EMPTY_WAIT_MS, deadline()); !actionable(snap) && !snap.wall && Date.now() < end; ) {
    await page.waitForTimeout(250)
    snap = await observe(page)
  }
  return snap
}

/** One Jev decision; an invalid or failed answer is asked once more before it ends the run. */
async function decide(jev, args) {
  try {
    return await chooseAction(jev, args)
  } catch (e) {
    if (!(e instanceof JevError)) throw e
    console.error(`[q-pilot] ${e.message}; asking Jev once more`)
    return await chooseAction(jev, args)
  }
}
// Node ids are only stable within one document, which is as long as a banned action matters.
const keyOf = a => (a.node === undefined ? null : `${a.node}:${a.kind}:${a.option ?? ''}`)
const fingerprint = snap => (snap.marker ? JSON.stringify(snap.marker) : null)

/** The repeated tail of `sigs` (length 2..MAX_CYCLE, seen twice in a row), or null. */
export function findCycle(sigs) {
  for (let n = 2; n <= MAX_CYCLE && n * 2 <= sigs.length; n++) {
    const a = sigs.slice(-n), b = sigs.slice(-2 * n, -n)
    if (a.every((s, i) => s === b[i]) && new Set(a).size > 1) return a
  }
  return null
}

/** Jev may press Escape when a list or popup is open, or when an overlay hides most of the page. */
const escapable = snap => snap.actions.some(a => a.expanded === 'true' || a.role === 'option') || (snap.occluded > 0 && snap.actions.filter(a => a.node !== undefined).length < 5)

/**
 * Returns { end: 'done' | 'blocked' | 'env', error, steps, diverged: [], decisions, page, by }. `guard` keeps the run on
 * the base origin. `inspector` (optional, see inspect.mjs) shows each observation and decision, and may hold the loop
 * before Jev is asked and before a decision runs. After a hold the page is observed again, so a stale decision is
 * never executed. `helper` (optional, task mode): asks Claude where Jev is stuck. `deadline` may be a number or a
 * function (it moves while Claude is asked). `by` is 'claude' when Claude ended the run with DONE.
 */
export async function pilot(page, { flow, fixtures, secrets = [], jev, loginPath, deadline, guard, inspector = null, helper = null, checkDone = null, checksMet = null, vision = visionDefaults(), tracer = null }) {
  const steps = [], history = []
  const until = typeof deadline === 'function' ? deadline : () => deadline
  // Every Jev decision as Jev saw it (redacted elements, both probability heads): written next to the run for debugging.
  const decisions = []
  // A click that opens a new tab (a booking engine's results) moves the run into that tab: `page` is the live page.
  const opened = []
  const onPage = p => opened.push(p)
  const context = page.context()
  context.on('page', onPage)
  const takeTab = async () => {
    for (const p of opened.splice(0)) {
      // Only a tab this page opened; never another tab of an attached Chrome.
      if ((await p.opener().catch(() => null)) !== page) continue
      await p.waitForLoadState('domcontentloaded', { timeout: 15000 }).catch(() => {})
      trackNetwork(p)
      p.setDefaultTimeout(5000)
      console.error(`[q-pilot] the click opened a new tab; following it: ${redact(p.url(), secrets)}`)
      page = p
      return true
    }
    return false
  }
  // `hard`: a stop by a person or Claude. Any other blocked end after a refused DONE (falseDones) stays the DONE it
  // was, so the red checks grade `fail`: holding DONE back must never turn an app bug into `blocked`.
  const out = (end, error, by = 'jev', hard = false) => {
    context.off('page', onPage)
    if (end === 'blocked' && falseDones && !hard) return { end: 'done', error: null, heldDone: error, steps, diverged: [], decisions, page, by }
    return { end, error, steps, diverged: [], decisions, page, by }
  }
  const keys = Object.keys(fixtures)
  // An action that changed nothing is removed from the candidates until the page changes.
  let last = null, banned = new Set(), idle = 0, idlePassive = 0, filled = null, suggested = false
  let fills = new Map(), keyFills = new Map(), sigs = [], low = 0, staleEnds = 0
  let lastClick = null, sameClicks = 0
  let falseDones = 0, noDoneUntil = 0
  /** After Claude hands the run back: Jev starts with a clean slate of loop counters. */
  const reset = () => {
    banned = new Set()
    idle = idlePassive = low = staleEnds = sameClicks = 0
    lastClick = last = filled = null
    suggested = false
    fills = new Map()
    keyFills = new Map()
    sigs = []
  }
  /** Latency and model of a Jev decision: the vision model when it saw the screenshot, else the text model. */
  const jevMeta = detail => ({ latencyMs: detail?.latencyMs ?? null, model: (detail?.vision?.used ? detail.vision.model : detail?.jevModel) ?? null, vision: Boolean(detail?.vision?.used) })
  /** Trace group title: step number, role and name of the target, p and source; never a typed value. */
  const titleOf = (snap, action, fixture, p, by) => `Step ${steps.length + 1} · ${redact(describe(toStep(snap, action, fixture)), secrets)} · p ${p.toFixed(2)} · ${by}`
  /** `extra`: latencyMs, and the model that chose the action (with vision: true when Jev saw the screenshot). */
  const record = (snap, action, fixture, p, by, { latencyMs = null, model = null, vision = false } = {}) => {
    const ran = toStep(snap, action, fixture)
    steps.push({ ...ran, by, p: +p.toFixed(3) })
    const text = action.kind === 'fill' ? fixtures[fixture] ?? action.text : undefined
    // Like jev-ultrafast, the history says what was typed (never a secret), so Jev can match it to a suggestion.
    history.push({
      action: redact(describe(ran), secrets), kind: action.kind, fixture: ran.fixture,
      ...(text !== undefined && { text: secrets.includes(text) ? '[secret]' : text }),
      ...(by !== 'jev' && { by }), page_changed: null,
    })
    inspector?.acted({ step: steps.length, action: history.at(-1).action, fixture: ran.fixture, p, latencyMs, by, model, vision })
    return ran
  }

  /**
   * Hands the run to Claude. Returns null (no helper, or its requests are used up: the caller ends as before),
   * { resume: true } (Jev goes on), or { end } (the run is over).
   */
  const escalate = async (reason, info, snap) => {
    if (!helper?.left()) return null
    for (let ask = { reason, info }; ; ) {
      // A frame of the page Claude is asked about, so the inspector's trail shows it.
      if (inspector) await inspector.observed(page, snap, steps.length + 1)
      inspector?.helping?.(ask.reason)
      const answer = await helper.ask({ ...ask, snap, history, steps: steps.length, page })
      inspector?.helping?.(null)
      if (!answer) return { end: out('blocked', `no answer from Claude to help request (${ask.reason})`) }
      // Every index refers to the observation Claude was shown: resolved on it, then run in order. The nodes stay
      // valid while the document does; one a navigation removed fails with "element is gone" and stops the list.
      const index = elementIndex(snap.actions)
      const results = []
      for (const act of answer.actions) {
        const r = await claudeAct(snap, index, act)
        results.push(r)
        if (!r.ok) break
        if (await takeTab()) filled = null
      }
      const off = guard?.check(page)
      if (off) return { end: out('blocked', off) }
      if (answer.then === 'done') return { end: out('done', null, 'claude') }
      if (answer.then === 'stop') return { end: out('blocked', `stopped by Claude${answer.note ? `: ${answer.note}` : ''}`, 'jev', true) }
      if (answer.then === 'resume') {
        reset()
        return { resume: true }
      }
      if (!helper.left()) return { end: out('blocked', 'Claude used every help request without handing the run back') }
      snap = await observeSettled(page, until)
      ask = { reason: 'observe', info: { results, ...(answer.note && { note: answer.note }) } }
    }
  }
  // A screenshot may show a secret fixture: no image leaves the browser in a run that types one.
  const seeing = () => !secrets.length
  let rescues = 0
  /**
   * Box rescue (Jev 1.14): before a stuck run goes to Claude, Jev locates on the screenshot the control that advances
   * the goal, and the run clicks its centre. True when it clicked; the caller then lets Jev go on.
   */
  const rescue = async (reason, snap) => {
    if (!vision.box || !seeing() || rescues >= MAX_RESCUE) return false
    const shot = await shotOf(page)
    if (!shot) return false
    let r
    try {
      r = await askBox(jev, { goal: flow.goal, history, shot: { data_base64: shot.data_base64, format: shot.format }, secrets })
    } catch (e) {
      if (!(e instanceof JevError)) throw e
      console.error(`[q-pilot] box rescue failed: ${e.message}`)
      return false
    }
    rescues++
    const ok = r.present >= PRESENT_MIN && r.confidence >= BOX_MIN
    const x = ((r.box.left + r.box.right) / 2) * shot.width, y = ((r.box.top + r.box.bottom) / 2) * shot.height
    decisions.push({ step: steps.length + 1, url: redact(snap.url ?? page.url(), secrets), chose: ok ? `click at (${Math.round(x)}, ${Math.round(y)})` : 'no box rescue', box: r, reason })
    inspector?.boxed?.({ ...r, x, y, w: shot.width, h: shot.height, ok, reason })
    if (!ok) return false
    const action = { kind: 'click_at', x, y }
    try {
      await traced(tracer, titleOf(snap, action, undefined, r.confidence * r.present, 'box'), () => perform(page, action))
    } catch (e) {
      console.error(`[q-pilot] box click failed: ${redact(e.message.split('\n')[0], secrets)}`)
      return false
    }
    record(snap, action, undefined, r.confidence * r.present, 'box', { latencyMs: r.ms, model: r.model })
    if (await takeTab()) filled = null
    // The page moved on another way: Jev starts again with fresh loop counters.
    banned = new Set()
    idle = idlePassive = low = 0
    sigs = []
    last = null
    return true
  }
  /** Stuck: a Box rescue first (when on), then Claude (when a helper is attached). */
  const stuckAt = async (reason, info, snap) => ((await rescue(reason, snap)) ? { resume: true } : escalate(reason, info, snap))

  /** One action Claude chose on `snap`, by the element index it was shown. */
  const claudeAct = async (snap, index, act) => {
    let action
    if (act.op === 'press') action = { kind: 'press', key: act.key }
    else if (act.op === 'scroll') action = { kind: 'scroll', delta: act.delta ?? 560 }
    else if (act.op === 'wait') action = { kind: 'wait' }
    else {
      action = snap.actions.find(a => a.node !== undefined && index.get(a.node) === String(act.index) && a.kind === act.op && (act.op !== 'select' || a.option === act.option))
      if (!action) return { ok: false, op: act.op, index: act.index, error: `no ${act.op} on element ${act.index} in the last observation` }
      if (act.op === 'fill') action = { ...action, text: act.fixture ? undefined : act.text }
    }
    const value = act.op === 'fill' ? (act.fixture ? fixtures[act.fixture] : act.text) : undefined
    if (act.op === 'fill' && value === undefined) return { ok: false, op: act.op, index: act.index, error: `unknown fixture "${act.fixture}"` }
    try {
      await traced(tracer, titleOf(snap, action, act.fixture, 1, 'claude'), () => perform(page, action, value))
    } catch (e) {
      return { ok: false, op: act.op, index: act.index, error: redact(e.message.split('\n')[0], secrets) }
    }
    record(snap, action, act.fixture, 1, 'claude')
    return { ok: true, op: act.op, index: act.index }
  }

  /**
   * `checksMet` (task mode, strong checks only): after a step, the run ends as done when the checks are green on two
   * looks CHECKS_AGAIN_MS apart, without waiting for Jev's DONE (Jev looped on a finished Date grid). Asked once per step.
   */
  let checkedAt = 0
  const goalMet = async () => {
    if (!checksMet || steps.length === checkedAt) return false
    checkedAt = steps.length
    if (!(await checksMet(page))) return false
    await page.waitForTimeout(CHECKS_AGAIN_MS)
    return checksMet(page)
  }

  if (!jev.available) return out('blocked', 'jev unavailable')
  let budget = flow.budget.steps, extended = false
  for (;;) {
    while (steps.length < budget) {
      if (Date.now() > until()) return out('blocked', 'time budget exceeded')
      try {
        if (await goalMet()) {
          await traced(tracer, `Step ${steps.length + 1} · checks green · done`, () => {})
          return out('done', null, 'checks')
        }
        let snap = await observeSettled(page, until)
        let fp = fingerprint(snap)
        if (last && fp !== null) {
          inspector?.changed(fp !== last.fp)
          // Like jev-ultrafast's recent_actions: Jev learns which of its actions did nothing.
          if (history.length) history.at(-1).page_changed = fp !== last.fp
          if (fp !== last.fp) {
            idle = idlePassive = 0
            banned = new Set()
          } else if (PASSIVE.has(last.kind)) {
            if (++idlePassive >= MAX_IDLE_PASSIVE) {
              const h = await stuckAt('stuck', { why: `${MAX_IDLE_PASSIVE} waits or scrolls without a page change` }, snap)
              if (h?.end) return h.end
              if (!h) return out('blocked', `no progress: ${MAX_IDLE_PASSIVE} waits or scrolls without a page change`)
              continue
            }
          } else {
            if (last.key) banned.add(last.key)
            if (++idle >= MAX_IDLE) {
              const h = await stuckAt('stuck', { why: `${MAX_IDLE} actions without a page change` }, snap)
              if (h?.end) return h.end
              if (!h) return out('blocked', `no progress: ${MAX_IDLE} actions without a page change`)
              continue
            }
          }
        }
        // Checked once per action: a re-observation after a hold must not count the same action as idle again.
        last = null
        // A CAPTCHA or challenge page: nothing Jev can click gets past it. A person solves it (Claude asks them).
        if (snap.wall) {
          const h = await escalate('human_needed', { wall: snap.wall, why: `a ${snap.wall} bot check covers the page; ask the person to solve it in the run's browser window, then observe` }, snap)
          if (h?.end) return h.end
          if (!h) return out('blocked', `bot wall (${snap.wall}): the site asks for a CAPTCHA or challenge that a person must solve`)
          continue
        }
        snap.actions = snap.actions.filter(a => !banned.has(keyOf(a)))
        if (inspector) {
          await inspector.observed(page, snap, steps.length + 1)
          const g = await inspector.gate('predict')
          if (g.stop) return out('blocked', g.stop, 'jev', true)
          if (g.waited) {
            snap = await observe(page)
            fp = fingerprint(snap)
            snap.actions = snap.actions.filter(a => !banned.has(keyOf(a)))
            await inspector.observed(page, snap, steps.length + 1)
          }
        }
        // PRESS_ENTER only right after a fill whose element still has focus, and no suggestion list came up for it.
        const canPress = filled !== null && !suggested && (await canPressEnter(page, filled))
        // A fixture typed MAX_KEY_FILLS times anywhere is not offered again; a field that took every offered fixture
        // MAX_SAME_FILL times is not offered for typing.
        const offerKeys = keys.filter(k => (keyFills.get(k) ?? 0) < MAX_KEY_FILLS)
        snap.actions = snap.actions.filter(a => a.kind !== 'fill' || offerKeys.some(k => (fills.get(fillKey(a, k)) ?? 0) < MAX_SAME_FILL))
        if (sameClicks >= MAX_SAME_CLICK) snap.actions = snap.actions.filter(a => a.kind !== 'click' || clickKey(a) !== lastClick)
        // Vision as set now (the inspector may switch it during the run); never with a secret fixture.
        // A held-back DONE is offered again as soon as the checks are green.
        if (noDoneUntil > steps.length && checkDone && !(await checkDone(page)).length) noDoneUntil = 0
        const eyes = vision.mode !== 'off' && seeing() ? { mode: vision.mode, model: vision.model, shot: async () => {
          const s = await shotOf(page)
          return s && { data_base64: s.data_base64, format: s.format }
        } } : null
        const d = await decide(jev, { goal: flow.goal, snap, history, fixtureKeys: keys, offerKeys, fixtures, secrets, canPress, canEscape: escapable(snap), canEnd: steps.length >= noDoneUntil, vision: eyes })
        const ran = d.end ? null : toStep(snap, d.action, d.fixture)
        decisions.push({ step: steps.length + 1, url: redact(snap.url, secrets), chose: d.end ?? redact(describe(ran), secrets), p: d.p, ...d.detail })
        if (inspector) {
          inspector.decided(d.detail, d.end ?? redact(describe(ran), secrets), d.p)
          const g = await inspector.gate('execute')
          if (g.stop) return out('blocked', g.stop, 'jev', true)
          // Held: run the decision only on the page it was made for.
          if (g.waited && fp !== null && fingerprint(await observe(page)) !== fp) {
            inspector.stale()
            continue
          }
        }
        if (d.end) {
          // Like jev-ultrafast: DONE or BLOCKED stands only on the page it was decided for. A page that changed
          // since (results arriving, a picker opening) is decided again.
          if (fp !== null && staleEnds < MAX_STALE_END && fingerprint(await observe(page)) !== fp) {
            staleEnds++
            decisions.at(-1).stale = true
            continue
          }
          staleEnds = 0
          await traced(tracer, `Step ${steps.length + 1} · ${d.end} · p ${d.p.toFixed(2)} · jev`, () => {})
          // The decision that ends (or would end) the run gets its own row in the inspector's trail.
          inspector?.acted({ step: steps.length + 1, action: d.end, p: d.p, by: 'jev', end: true, ...jevMeta(d.detail) })
          if (d.end === 'DONE') {
            // With checks, a DONE whose checks are red goes to Claude first (the search ran with a wrong date):
            // still fixable while the browser is open, a dead `fail` once the run ends.
            if (helper?.left() && checkDone) {
              const red = await checkDone(page)
              if (red.length) {
                const h = await escalate('checks_red', { why: `Jev chose DONE but ${red.length} check(s) are red`, red }, snap)
                if (h?.end) return h.end
                if (h) continue
              }
            }
            // Jev's DONE proves nothing on its own: without checks, Claude looks at the page before it stands.
            if (helper?.confirmDone) {
              const h = await escalate('confirm_done', { why: 'Jev chose DONE; confirm on the page that every requirement is met (then: done), or act and hand back' }, snap)
              if (h?.end) return h.end
              if (h) continue
            }
            if (checkDone && falseDones < MAX_FALSE_DONE) {
              const red = await checkDone(page)
              if (red.length) {
                falseDones++
                noDoneUntil = steps.length + NO_DONE_STEPS
                decisions.at(-1).refused = `DONE with ${red.length} red check(s): not offered for ${NO_DONE_STEPS} steps`
                console.error(`[q-pilot] DONE with ${red.length} red check(s); Jev goes on for ${NO_DONE_STEPS} more steps`)
                continue
              }
            }
            return out('done', null)
          }
          const h = await stuckAt('jev_blocked', { why: `Jev chose BLOCKED (p ${d.p.toFixed(2)})` }, snap)
          if (h?.end) return h.end
          if (h) continue
          return out('blocked', `jev chose ${d.end}`)
        }
        staleEnds = 0
        // The same fixture into the same field again: a loop, not progress. Dropped like an action that did nothing.
        if (d.action.kind === 'fill' && (fills.get(fillKey(d.action, d.fixture)) ?? 0) >= MAX_SAME_FILL) {
          banned.add(keyOf(d.action))
          decisions.at(-1).refused = `"${d.fixture}" already typed into this field ${MAX_SAME_FILL} times`
          if (++idle >= MAX_IDLE) {
            const h = await stuckAt('stuck', { why: `Jev keeps typing "${d.fixture}" into ${describe(ran)}` }, snap)
            if (h?.end) return h.end
            if (!h) return out('blocked', `no progress: Jev keeps typing "${d.fixture}" into the same field`)
          }
          continue
        }
        low = d.p < LOW_P ? low + 1 : 0
        if (low >= MAX_LOW && (helper?.left() || (vision.box && seeing() && rescues < MAX_RESCUE))) {
          low = 0
          const h = await stuckAt('low_confidence', { why: `${MAX_LOW} decisions in a row below p ${LOW_P}`, next: redact(describe(ran), secrets), p: +d.p.toFixed(3) }, snap)
          if (h?.end) return h.end
          continue
        }
        let r
        try {
          r = await traced(tracer, titleOf(snap, d.action, d.fixture, d.p, 'jev'), () => perform(page, d.action, fixtures[d.fixture]))
          if (await takeTab()) filled = null
          else if (d.action.kind === 'click' && fp !== null && fingerprint(await observe(page)) === fp) {
            await page.waitForTimeout(RETRY_CLICK_MS)
            // A new tab can open a moment after the click: follow it instead of clicking again.
            if (await takeTab()) filled = null
            else if (fingerprint(await observe(page)) === fp) {
              console.error(`[q-pilot] ${redact(describe(ran), secrets)} changed nothing; clicking once more`)
              await perform(page, d.action, fixtures[d.fixture])
            }
          }
        } catch (e) {
          // A covered or detached control: drop it from the candidates and let Jev pick again, like jev-ultrafast
          // rejecting a covered target. Counts as an idle action, so repeated failures still end the run.
          const key = keyOf(d.action)
          if (!key || ++idle >= MAX_IDLE) throw e
          banned.add(key)
          last = null
          console.error(`[q-pilot] ${redact(describe(ran), secrets)} failed, re-picking: ${redact(e.message.split('\n')[0], secrets)}`)
          continue
        }
        last = { fp, key: keyOf(d.action), kind: d.action.kind }
        filled = d.action.kind === 'fill' ? d.action.node : null
        suggested = Boolean(r?.suggested)
        if (d.action.kind === 'click') {
          sameClicks = clickKey(d.action) === lastClick ? sameClicks + 1 : 1
          lastClick = clickKey(d.action)
        } else if (!PASSIVE.has(d.action.kind)) lastClick = null, sameClicks = 0
        if (d.action.kind === 'fill') {
          fills.set(fillKey(d.action, d.fixture), (fills.get(fillKey(d.action, d.fixture)) ?? 0) + 1)
          keyFills.set(d.fixture, (keyFills.get(d.fixture) ?? 0) + 1)
        }
        record(snap, d.action, d.fixture, d.p, 'jev', jevMeta(d.detail))
        if (!PASSIVE.has(d.action.kind)) {
          // The path (not the query) and the action: a cycle through the same pages with the same actions is a loop
          // even when every step changes the page (Traveloka: fill → search → back, 20 times).
          sigs.push(`${pathOf(snap.url).split('?')[0]}|${describe(ran)}|${d.fixture ?? ''}`)
          const cycle = findCycle(sigs)
          if (cycle) {
            const why = `the same ${cycle.length} actions ran twice in a row: ${cycle.map(s => s.split('|')[1]).join(' → ')}`
            const h = await stuckAt('loop', { why: redact(why, secrets) }, await observe(page))
            if (h?.end) return h.end
            if (!h) return out('blocked', `loop: ${redact(why, secrets)}`)
            continue
          }
        }
        const off = guard?.check(page)
        if (off) return out('blocked', off)
        if (onLogin(page, loginPath, flow.start)) return out('env', `redirected to ${loginPath}`)
      } catch (e) {
        return out('blocked', e instanceof JevError ? e.message : `step ${steps.length + 1} failed: ${redact(e.message.split('\n')[0], secrets)}`)
      }
    }
    // The step budget is spent: Claude may finish what Jev started, or hand back once for BUDGET_EXTRA more steps.
    const h = await escalate('budget', { why: `the step budget (${budget}) is spent${extended ? '; no more steps can be added' : `; handing back adds ${BUDGET_EXTRA} steps once`}` }, await observe(page).catch(() => ({ actions: [] })))
    if (h?.end) return h.end
    if (h?.resume && !extended) {
      budget = steps.length + BUDGET_EXTRA
      extended = true
      continue
    }
    return out('blocked', 'step budget exceeded')
  }
}
