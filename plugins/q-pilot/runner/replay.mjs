// Replay a trace with no model; when a step does not match, Jev re-picks that one step (heal).
import { observe, collapse } from './snapshot.mjs'
import { perform, toStep, describe, onLogin } from './act.mjs'
import { chooseAction, JevError } from './jev.mjs'
import { shot } from './shot.mjs'
import { redact } from './redact.mjs'

export const MAX_HEALS = 2

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

const blocked = (error, steps, diverged) => ({ end: 'blocked', error, steps, diverged })

/**
 * Replays `trace.steps` on `page`. Returns { end: 'done' | 'blocked' | 'env', error, steps, diverged }.
 * `steps` are the steps as run (healed ones replaced) with `by`; `diverged` lists old -> new for healed steps.
 */
export async function replay(page, { flow, trace, fixtures, jev, loginPath, deadline, shotFile, maxHeals = MAX_HEALS }) {
  const secrets = Object.values(fixtures)
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
      } else {
        // An empty result may just be a page that is still rendering: look again briefly before calling it a miss.
        for (let tries = 0; tries < 3; tries++) {
          snap = await observe(page)
          hit = match(snap.actions, step)
          if (hit.action || hit.candidates > 0) break
          await page.waitForTimeout(200)
        }
      }
      let action = hit.action, fixtureKey = step.fixture, by = 'replay', p
      if (!action) {
        const missed = { op: step.op, role: step.role, name: step.name }
        if (!jev.available) return blocked(`step ${n} missed (${describe(step)}): jev unavailable`, steps, diverged)
        if (healed >= maxHeals) return blocked(`more than ${maxHeals} steps missed (step ${n}: ${describe(step)})`, steps, diverged)
        let d
        try {
          d = await chooseAction(jev, { goal: flow.goal, snap, history, fixtureKeys: Object.keys(fixtures), secrets, stepToReplace: missed })
        } catch (e) {
          if (e instanceof JevError) return blocked(`step ${n} missed (${describe(step)}): ${e.message}`, steps, diverged)
          throw e
        }
        if (d.end) return blocked(`step ${n} missed (${describe(step)}): jev chose ${d.end}`, steps, diverged)
        ;({ action, p } = d)
        fixtureKey = d.fixture
        by = 'jev'
        healed++
        if (healed === 1 && shotFile) {
          await shot(page, snap, shotFile, redact(`replay miss: ${describe(step)} not on page -> Jev re-picks ${describe(toStep(snap, action, fixtureKey))}`, secrets), action.node).catch(() => {})
        }
        diverged.push({ step: n, was: missed, now: pick(toStep(snap, action, fixtureKey)), p: +p.toFixed(3) })
      }
      const ran = toStep(snap, action, fixtureKey)
      await perform(page, action, fixtures[fixtureKey])
      steps.push({ ...ran, by })
      history.push({ action: redact(describe(ran), secrets), fixture: ran.fixture })
      if (onLogin(page, loginPath, flow.start)) return { end: 'env', error: `redirected to ${loginPath}`, steps, diverged }
    } catch (e) {
      return blocked(`step ${n} failed (${describe(step)}): ${redact(e.message.split('\n')[0], Object.values(fixtures))}`, steps, diverged)
    }
  }
  return { end: 'done', error: null, steps, diverged }
}

const pick = ({ op, role, name }) => ({ op, role, name })
