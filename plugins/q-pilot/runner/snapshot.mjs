// Observe the page: runs the jev-ultrafast snapshot (see snapshot.js for the credit) and normalizes its actions.
import { readFileSync } from 'node:fs'

const SOURCE = readFileSync(new URL('./snapshot.js', import.meta.url), 'utf8')
const OPS = { click: 'CLICK', fill: 'TYPE_TEXT', select: 'SELECT' }

export const collapse = s => String(s ?? '').replace(/\s+/g, ' ').trim()

/** Snapshot of the visible, actionable elements. Each action gets `name` (accessible name, without the select option). */
export async function observe(page) {
  let snap
  for (let i = 0; ; i++) {
    try {
      snap = await page.evaluate(SOURCE)
      break
    } catch (e) {
      // The page navigated under the snapshot: wait for it and try again.
      if (i >= 2) throw e
      await page.waitForLoadState('domcontentloaded').catch(() => {})
    }
  }
  if (!snap) return { url: page.url(), title: '', text: '', actions: [] }
  for (const a of snap.actions) {
    if (a.kind === 'select') a.name = collapse(a.label.slice(0, a.label.length - a.option.length - 3))
    // An "Open <field>" click keeps the field's own name: the element is the field, the label says what the click does.
    else if (a.node !== undefined) a.name = collapse(a.open ? a.label.slice(5) : a.label)
    if (a.scope !== undefined) a.scope = collapse(a.scope)
  }
  return snap
}

/** One index per distinct element, in snapshot order: Map(node -> "1", "2", ...). Shared by Jev requests and overlays. */
export function elementIndex(actions) {
  const index = new Map()
  for (const a of actions) if (OPS[a.kind] && !index.has(a.node)) index.set(a.node, String(index.size + 1))
  return index
}

export const pathOf = url => {
  try {
    const u = new URL(url)
    return u.pathname + u.search
  } catch {
    return url
  }
}
