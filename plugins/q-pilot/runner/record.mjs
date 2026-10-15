// The pilot loop: Jev picks each action until DONE, BLOCKED or the budget runs out.
import { observe } from './snapshot.mjs'
import { perform, toStep, describe, onLogin } from './act.mjs'
import { chooseAction, JevError } from './jev.mjs'
import { redact } from './redact.mjs'

/** Returns { end: 'done' | 'blocked' | 'env', error, steps, diverged: [] }. */
export async function pilot(page, { flow, fixtures, jev, loginPath, deadline }) {
  const secrets = Object.values(fixtures)
  const steps = [], history = []
  const out = (end, error) => ({ end, error, steps, diverged: [] })
  while (steps.length < flow.budget.steps) {
    if (Date.now() > deadline) return out('blocked', 'time budget exceeded')
    try {
      const snap = await observe(page)
      const d = await chooseAction(jev, { goal: flow.goal, snap, history, fixtureKeys: Object.keys(fixtures), secrets })
      if (d.end === 'DONE') return out('done', null)
      if (d.end) return out('blocked', `jev chose ${d.end}`)
      const ran = toStep(snap, d.action, d.fixture)
      await perform(page, d.action, fixtures[d.fixture])
      steps.push({ ...ran, by: 'jev' })
      history.push({ action: redact(describe(ran), secrets), fixture: ran.fixture })
      if (onLogin(page, loginPath, flow.start)) return out('env', `redirected to ${loginPath}`)
    } catch (e) {
      return out('blocked', e instanceof JevError ? e.message : `step ${steps.length + 1} failed: ${redact(e.message.split('\n')[0], secrets)}`)
    }
  }
  return out('blocked', 'step budget exceeded')
}
