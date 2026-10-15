import { expect, test } from 'claude-code/testing'

import { isUiRelevant, matchesGlob, selectFlows } from '../hooks/lib/impact'

const checkout = { id: 'checkout', covers: ['src/checkout.html', 'src/cart/**'], tags: [] }
const home = { id: 'home', covers: ['src/index.html'], tags: ['smoke'] }
const login = { id: 'login', covers: ['src/login/*.tsx'], tags: ['smoke'] }
const flows = [checkout, home, login]

test('globs: ** spans folders, * stays in one segment, {a,b} alternates', () => {
  expect(matchesGlob('src/cart/a/b.ts', 'src/cart/**')).toBe(true)
  expect(matchesGlob('src/login/a.tsx', 'src/login/*.tsx')).toBe(true)
  expect(matchesGlob('src/login/a/b.tsx', 'src/login/*.tsx')).toBe(false)
  expect(matchesGlob('src/app.tsx', 'src/*.{ts,tsx}')).toBe(true)
})

test('UI relevance: app code counts; docs, configs, unit tests, flows, .q-pilot and ignores do not', () => {
  const cfg = {}
  expect(isUiRelevant('src/checkout.html', cfg)).toBe(true)
  expect(isUiRelevant('app/globals.css', cfg)).toBe(true)
  expect(isUiRelevant('src/locales/en.json', cfg)).toBe(true)
  expect(isUiRelevant('README.md', cfg)).toBe(false)
  expect(isUiRelevant('package-lock.json', cfg)).toBe(false)
  expect(isUiRelevant('vite.config.ts', cfg)).toBe(false)
  expect(isUiRelevant('src/utils/math.test.ts', cfg)).toBe(false)
  expect(isUiRelevant('flows/checkout.flow.json', cfg)).toBe(false)
  expect(isUiRelevant('e2e-flows/x.ts', { flowsDir: 'e2e-flows' })).toBe(false)
  expect(isUiRelevant('.q-pilot/traces/checkout.json', cfg)).toBe(false)
  expect(isUiRelevant('src/gen/api.ts', { ignore: ['src/gen/**'] })).toBe(false)
})

test('a changed file selects the flows whose covers glob matches it', () => {
  const sel = selectFlows(['src/checkout.html'], flows, {})
  expect(sel).toEqual({ mode: 'flows', ids: ['checkout'], why: ['src/checkout.html → checkout (covers)'] })
  expect(selectFlows(['src/cart/item.ts'], flows, {}).ids).toEqual(['checkout'])
})

test('a UI file that no flow covers selects the smoke flows', () => {
  const sel = selectFlows(['src/other.html'], flows, {})
  expect(sel.mode).toBe('flows')
  expect(sel.ids).toEqual(['home', 'login'])
})

test('when some files select flows and others select none, the smoke flows join', () => {
  expect(selectFlows(['src/checkout.html', 'src/other.html'], flows, {}).ids).toEqual(['checkout', 'home', 'login'])
})

test('nothing is selected when the changes are not UI, or nothing covers them and no flow is smoke', () => {
  expect(selectFlows(['README.md', 'flows/checkout.flow.json'], flows, {}).mode).toBe('none')
  expect(selectFlows(['src/other.html'], [checkout], {}).mode).toBe('none')
  expect(selectFlows([], flows, {}).mode).toBe('none')
})

test('mode all runs every flow, but still only for a UI-relevant change', () => {
  expect(selectFlows(['src/other.html'], flows, {}, 'all')).toEqual(expect.objectContaining({ mode: 'all', ids: ['checkout', 'home', 'login'] }))
  expect(selectFlows(['README.md'], flows, {}, 'all').mode).toBe('none')
})

test('a flow without covers is selected only as smoke', () => {
  expect(selectFlows(['src/checkout.html'], [{ id: 'bare' }, checkout], {}).ids).toEqual(['checkout'])
})
