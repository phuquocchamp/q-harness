// The closed set of verify checks, evaluated by code only. Jev's DONE never decides pass or fail.
import { pathOf, collapse } from './snapshot.mjs'
import { redactDeep, redactValue } from './redact.mjs'

const POLL_MS = 100

function locatorOf(page, c) {
  if ('role' in c) return page.getByRole(c.role, c.name === undefined ? {} : { name: c.name, exact: true })
  if ('testid' in c) return page.getByTestId(c.testid)
  if ('label' in c) return page.getByLabel(c.label, { exact: true })
  return page.getByText(c.text, { exact: true })
}

/** One evaluation of one check: { ok, actual } where actual is what was found (null when the element is missing). */
export async function checkOnce(page, c) {
  if ('url' in c) {
    const actual = pathOf(page.url())
    return { ok: new RegExp(c.url).test(actual), actual }
  }
  if ('title' in c) {
    const actual = await page.title()
    return { ok: actual === c.title, actual }
  }
  const all = locatorOf(page, c)
  const n = await all.count()
  if (n === 0) return { ok: c.visible === false, actual: null }
  // Strict like Playwright's expect: a check that matches several elements is not trusted to grade the right one.
  if (n > 1) return { ok: false, actual: `ambiguous: ${n} elements match` }
  const el = all.first()
  const target = ['role', 'testid', 'label'].some(k => k in c)
  const exp = !target ? 'visible' : ['text', 'contains', 'value'].find(k => k in c) ?? 'visible'
  if (exp === 'visible') {
    const shown = await el.isVisible()
    return { ok: shown === (c.visible ?? true), actual: shown ? 'visible' : 'hidden' }
  }
  if (exp === 'value') {
    const actual = await el.inputValue({ timeout: 500 }).catch(() => null)
    return { ok: actual === c.value, actual }
  }
  const actual = collapse(await el.textContent({ timeout: 500 }).catch(() => ''))
  return { ok: exp === 'text' ? actual === collapse(c.text) : actual.includes(collapse(c.contains)), actual }
}

/**
 * Evaluates all checks, polling the ones that fail for up to `timeoutMs` (like `expect`).
 * Returns every check as { check, ok, actual }, redacted with the fixture secrets.
 */
export async function runChecks(page, checks, { timeoutMs = 2000, secrets = [] } = {}) {
  const end = Date.now() + timeoutMs
  const results = checks.map(check => ({ check, ok: false, actual: null }))
  for (;;) {
    for (const r of results) {
      if (r.ok) continue
      const v = await checkOnce(page, r.check).catch(e => ({ ok: false, actual: `error: ${e.message.split('\n')[0]}` }))
      Object.assign(r, v)
    }
    if (results.every(r => r.ok) || Date.now() >= end) break
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  return redactDeep(results, secrets)
}

/**
 * Evaluates all checks, polling the ones that fail for up to `timeoutMs` (like `expect`).
 * Returns the failures as [{ check, actual }], with fixture values redacted from `actual`.
 */
export async function runVerify(page, checks, opts = {}) {
  const results = await runChecks(page, checks, opts)
  return results.filter(r => !r.ok).map(({ check, actual }) => ({ check, actual }))
}

/** Checks suggested for a flow with an empty verify: the final url, headings and status/alert texts. */
export async function suggestVerify(page, secrets = []) {
  const found = await page.evaluate(() => {
    const texts = sel => [...document.querySelectorAll(sel)].map(e => e.textContent.replace(/\s+/g, ' ').trim()).filter(Boolean)
    return { headings: texts('h1,h2'), status: texts('[role=status],[role=alert]') }
  })
  const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  const r = s => redactValue(s, secrets)
  return [
    { url: `${esc(pathOf(page.url()))}$` },
    ...found.headings.slice(0, 3).map(name => ({ role: 'heading', name: r(name) })),
    ...found.status.slice(0, 3).map(text => ({ role: 'status', text: r(text) })),
  ]
}
