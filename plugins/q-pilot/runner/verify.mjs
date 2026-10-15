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
  const el = locatorOf(page, c).first()
  if ((await el.count()) === 0) return { ok: c.visible === false, actual: null }
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
 * Returns the failures as [{ check, actual }], with fixture values redacted from `actual`.
 */
export async function runVerify(page, checks, { timeoutMs = 2000, secrets = [] } = {}) {
  const end = Date.now() + timeoutMs
  let pending = checks.map(check => ({ check, actual: null }))
  for (;;) {
    const next = []
    for (const p of pending) {
      const r = await checkOnce(page, p.check).catch(e => ({ ok: false, actual: `error: ${e.message.split('\n')[0]}` }))
      if (!r.ok) next.push({ check: p.check, actual: r.actual })
    }
    pending = next
    if (!pending.length || Date.now() >= end) break
    await new Promise(r => setTimeout(r, POLL_MS))
  }
  return pending.map(p => redactDeep({ check: p.check, actual: p.actual }, secrets))
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
