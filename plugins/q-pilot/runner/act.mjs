// Performing one action on the page, and turning an observed action into a trace step.
import { pathOf } from './snapshot.mjs'

/** Acts through the element handle behind the snapshot node. Playwright's actionability checks run before input. */
export async function perform(page, action, fixtureValue) {
  if (action.kind === 'scroll') await page.mouse.wheel(0, action.delta)
  else if (action.kind === 'wait') await page.waitForTimeout(100)
  else {
    const el = (await page.evaluateHandle(n => window.__jevFast.nodes.get(n), action.node)).asElement()
    if (!el) throw new Error('element is gone')
    if (action.kind === 'fill') await el.fill(fixtureValue, { timeout: 2000 })
    else if (action.kind === 'select') await el.selectOption({ label: action.option }, { timeout: 2000 })
    else await el.click({ timeout: 2000 })
  }
  await page.waitForLoadState('domcontentloaded').catch(() => {})
  await page.waitForTimeout(50)
}

/** The step stored in a trace: meaning only (op, role, name, scope), never an index and never a fixture value. */
export function toStep(snap, action, fixture) {
  const url = pathOf(snap.url)
  if (action.kind === 'scroll') return { op: 'scroll', delta: action.delta, url }
  if (action.kind === 'wait') return { op: 'wait', url }
  const step = { op: action.kind, role: action.role, name: action.name, scope: action.scope ?? '' }
  if (action.kind === 'select') step.option = action.option
  if (fixture) step.fixture = fixture
  step.url = url
  return step
}

export const describe = s => (s.role ? `${s.op} ${s.role} "${s.name}"` : s.op)

/** True when the page sits on the configured login path (and the flow did not start there). */
export function onLogin(page, loginPath, start) {
  if (!loginPath || pathOf(start).split('?')[0] === loginPath) return false
  return pathOf(page.url()).split('?')[0] === loginPath
}
