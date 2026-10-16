// Replay a trace with no model; when a step does not match, Jev re-picks that one step (heal).
import { observe, collapse } from './snapshot.mjs'
import { perform, toStep, describe, onLogin, canPressEnter, focusedNode } from './act.mjs'
import { chooseAction, JevError } from './jev.mjs'
import { shot } from './shot.mjs'
import { traced } from './driver.mjs'
import { redact, redactValue } from './redact.mjs'

export const MAX_HEALS = 2
/** A heal below this probability is not trusted: the flow ends blocked and names Jev's pick for the reviewer. */
export const MIN_HEAL_P = 0.5

/**
 * Finds the observed action for a trace step: same op kind, role and name; several candidates are narrowed by scope.
 * Look-alikes that scope cannot tell apart are a miss, never a guess.
 */
export function match(actions, step) {
  const seen = new Set()
  const candidates = actions.filter(a => {
    const ok = a.kind === step.op && a.role === step.role && a.name === collapse(step.name) && (step.op !== 'select' || a.option === step.option) && !seen.has(a.node)
    if (ok) seen.add(a.node)
    return ok
  })
  if (candidates.length === 1) return { action: candidates[0], candidates: 1 }
  const scoped = candidates.filter(a => (a.scope ?? '') === (step.scope ?? ''))
  if (candidates.length > 1 && scoped.length === 1) return { action: scoped[0], candidates: candidates.length }
  return { action: null, candidates: candidates.length }
}

/** A recorded `press` is only valid right after a fill of the same field: the focused element must match that step's role and name. */
export function pressMatches(prev, snap, focused) {
  if (prev?.op !== 'fill' || focused == null) return false
  const field = snap.actions.find(a => a.kind === 'fill' && a.node === focused)
  return Boolean(field) && field.role === prev.role && field.name === collapse(prev.name)
}

const blocked = (error, steps, diverged) => ({ end: 'blocked', error, steps, diverged })

/**
 * Replays `trace.steps` on `page`. Returns { end: 'done' | 'blocked' | 'env', error, steps, diverged }.
 * `steps` are the steps as run (healed ones replaced) with `by`; `diverged` lists old -> new for healed steps.
 * `inspector` (optional) is told what was observed and done; replay never holds at a gate. `phase` tags those rows.
 */
export async function replay(page, { flow, trace, fixtures, secrets = [], jev, loginPath, deadline, shotFile, guard, tracer = null, inspector = null, phase = null, maxHeals = MAX_HEALS, minHealP = MIN_HEAL_P }) {
  const steps = [], diverged = [], history = []
  let healed = 0
  for (const [i, step] of trace.steps.entries()) {
    const n = i + 1
    if (Date.now() > deadline) return blocked('time budget exceeded', steps, diverged)
    if (steps.length >= flow.budget.steps) return blocked('step budget exceeded', steps, diverged)
    if (step.fixture && !(step.fixture in fixtures)) return blocked(`step ${n}: unknown fixture "${step.fixture}"`, steps, diverged)
    try {
      let snap, hit
      if (step.op === 'scroll' || step.op === 'wait') {
        snap = { url: page.url() }
        hit = { action: { kind: step.op, delta: step.delta } }
      } else if (step.op === 'press') {
        snap = await observe(page)
        const ok = pressMatches(trace.steps[i - 1], { actions: matchView(snap, secrets) }, await focusedNode(page))
        hit = { action: ok ? { kind: 'press', key: step.key } : null, candidates: 0 }
      } else {
        // An empty result may just be a page that is still rendering: look again briefly before calling it a miss.
        for (let tries = 0; tries < 3; tries++) {
          snap = await observe(page)
          hit = match(matchView(snap, secrets), step)
          if (hit.action) hit.action = hit.action.orig
          if (hit.action || hit.candidates > 0) break
          await page.waitForTimeout(200)
        }
      }
      if (snap.actions) await tell(() => inspector?.observed(page, snap, n))
      let action = hit.action, fixtureKey = step.fixture, by = 'replay', p
      if (!action) {
        const missed = { op: step.op, role: step.role, name: step.name }
        if (!jev.available) return blocked(`step ${n} missed (${describe(step)}): jev unavailable`, steps, diverged)
        if (healed >= maxHeals) return blocked(`more than ${maxHeals} steps missed (step ${n}: ${describe(step)})`, steps, diverged)
        let d
        try {
          d = await chooseAction(jev, { goal: flow.goal, snap, history, fixtureKeys: Object.keys(fixtures), fixtures, secrets, stepToReplace: missed, canPress: step.op === 'fill' && (await canPressEnter(page)) })
        } catch (e) {
          if (e instanceof JevError) return blocked(`step ${n} missed (${describe(step)}): ${e.message}`, steps, diverged)
          throw e
        }
        if (d.end) return blocked(`step ${n} missed (${describe(step)}): jev chose ${d.end}`, steps, diverged)
        ;({ action, p } = d)
        fixtureKey = d.fixture
        if (p < minHealP) return blocked(`step ${n} missed (${describe(step)}): jev's pick ${redact(describe(toStep(snap, action, fixtureKey)), secrets)} has p ${p.toFixed(2)} < ${minHealP}`, steps, diverged)
        by = 'jev'
        healed++
        if (healed === 1 && shotFile) {
          await shot(page, snap, shotFile, redact(`replay miss: ${describe(step)} not on page -> Jev re-picks ${describe(toStep(snap, action, fixtureKey))}`, secrets), action.node).catch(() => {})
        }
        diverged.push({ step: n, was: missed, now: pick(toStep(snap, action, fixtureKey)), p: +p.toFixed(3) })
      }
      const ran = toStep(snap, action, fixtureKey)
      // The group title names role and name only: never a typed value.
      await traced(tracer, `Step ${n} · ${redact(describe(ran), secrets)} · ${by === 'jev' ? `healed p ${p.toFixed(2)}` : 'replay'}`, () => perform(page, action, fixtures[fixtureKey]))
      steps.push({ ...ran, by, ...(by === 'jev' && { p: +p.toFixed(3) }) })
      history.push({ action: redact(describe(ran), secrets), kind: action.kind, fixture: ran.fixture })
      await tell(() => inspector?.acted({ step: n, action: history.at(-1).action, fixture: ran.fixture, p: p ?? null, by, ...(phase && { phase }) }))
      const off = guard?.check(page)
      if (off) return blocked(off, steps, diverged)
      if (onLogin(page, loginPath, flow.start)) return { end: 'env', error: `redirected to ${loginPath}`, steps, diverged }
    } catch (e) {
      return blocked(`step ${n} failed (${describe(step)}): ${redact(e.message.split('\n')[0], secrets)}`, steps, diverged)
    }
  }
  return { end: 'done', error: null, steps, diverged }
}

/** The snapshot actions as stored in traces (secrets redacted from name, scope and option), keeping `orig` to act on. */
const matchView = (snap, secrets) =>
  snap.actions.map(a => (a.node === undefined ? a : { ...a, name: redactValue(a.name, secrets), scope: redactValue(a.scope ?? '', secrets), ...(a.option !== undefined && { option: redactValue(a.option, secrets) }), orig: a }))

/** The inspector is a view: whatever it does, the replay goes on. */
const tell = async fn => {
  try { await fn() } catch {}
}

const pick = ({ op, role, name }) => ({ op, role, name })
