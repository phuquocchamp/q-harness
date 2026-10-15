import { expect, test } from 'claude-code/testing'

import { globToRegExp, gotoPaths, isUiRelevant, matchesGlob, routeOf, selectSpecs } from '../hooks/lib/impact'

test('globs: ** spans folders, * and ? stay in one segment, {a,b} alternates', () => {
  expect(matchesGlob('src/checkout/pay.ts', 'src/**')).toBe(true)
  expect(matchesGlob('src', 'src/**')).toBe(true)
  expect(matchesGlob('src/x.ts', 'src/**/x.ts')).toBe(true)
  expect(matchesGlob('src/a/b/x.ts', 'src/**/x.ts')).toBe(true)
  expect(matchesGlob('src/a/x.ts', 'src/*.ts')).toBe(false)
  expect(matchesGlob('tests/checkout.spec.ts', 'tests/checkout*.spec.ts')).toBe(true)
  expect(matchesGlob('a1.ts', 'a?.ts')).toBe(true)
  expect(matchesGlob('a/b.ts', 'a?b.ts')).toBe(false)
  expect(matchesGlob('src/app.tsx', 'src/*.{ts,tsx}')).toBe(true)
  expect(matchesGlob('src/app.js', 'src/*.{ts,tsx}')).toBe(false)
  expect(matchesGlob('./src\\a.ts', 'src/a.ts')).toBe(true)
  expect(globToRegExp('a.b+(c)').test('a.b+(c)')).toBe(true)
  expect(globToRegExp('a.b').test('axb')).toBe(false)
})

test('UI relevance: app code and specs count; docs, configs, lockfiles, unit tests and ignores do not', () => {
  const cfg = {}
  expect(isUiRelevant('src/checkout/Pay.tsx', cfg)).toBe(true)
  expect(isUiRelevant('app/globals.css', cfg)).toBe(true)
  expect(isUiRelevant('tests/checkout.spec.ts', cfg)).toBe(true)
  expect(isUiRelevant('src/locales/en.json', cfg)).toBe(true)
  expect(isUiRelevant('README.md', cfg)).toBe(false)
  expect(isUiRelevant('package-lock.json', cfg)).toBe(false)
  expect(isUiRelevant('playwright.config.ts', cfg)).toBe(false)
  expect(isUiRelevant('src/utils/math.test.ts', cfg)).toBe(false)
  expect(isUiRelevant('.github/workflows/ci.yml', cfg)).toBe(false)
  expect(isUiRelevant('src/gen/api.ts', { ignore: ['src/gen/**'] })).toBe(false)
})

test('routes come from app/, pages/ and routes/ folders', () => {
  expect(routeOf('app/checkout/page.tsx')).toBe('/checkout')
  expect(routeOf('src/app/(shop)/checkout/components/Summary.tsx')).toBe('/checkout')
  expect(routeOf('pages/checkout.tsx')).toBe('/checkout')
  expect(routeOf('pages/checkout/index.tsx')).toBe('/checkout')
  expect(routeOf('src/routes/account/settings/+page.svelte')).toBe('/account/settings')
  expect(routeOf('app/orders/[id]/page.tsx')).toBe('/orders')
  expect(routeOf('app/page.tsx')).toBe('/')
  expect(routeOf('pages/_app.tsx')).toBeUndefined()
  expect(routeOf('app/layout.tsx')).toBeUndefined()
  expect(routeOf('app/globals.css')).toBeUndefined()
  expect(routeOf('src/app/store.ts')).toBeUndefined()
  expect(routeOf('pages/index.tsx')).toBe('/')
  expect(routeOf('pages/api/pay.ts')).toBeUndefined()
  expect(routeOf('src/components/Button.tsx')).toBeUndefined()
})

test('goto paths accept all quote styles and absolute URLs', () => {
  const src = "await page.goto('/checkout'); page.goto(\"http://localhost:3000/cart?x=1\"); page.goto(`/`)"
  expect(gotoPaths(src)).toEqual(['/checkout', '/cart?x=1', '/'])
})

const SPECS = ['tests/checkout.spec.ts', 'tests/checkout-guest.spec.ts', 'tests/cart.spec.ts', 'tests/home.spec.ts']
const SOURCES = {
  'tests/checkout.spec.ts': "test('pay', async ({ page }) => { await page.goto('/checkout') })",
  'tests/checkout-guest.spec.ts': "await page.goto('/checkout?guest=1')",
  'tests/cart.spec.ts': "await page.goto('/cart')",
  'tests/home.spec.ts': "await page.goto('/')",
}

test('pass 1: the config map selects specs by glob', () => {
  const sel = selectSpecs(['src/payments/confirm.ts'], SPECS, SOURCES, { map: { 'src/payments/**': ['tests/checkout*.spec.ts'] } })
  expect(sel.mode).toBe('specs')
  expect(sel.specs).toEqual(['tests/checkout-guest.spec.ts', 'tests/checkout.spec.ts'])
  expect(sel.why[0]).toBe('src/payments/confirm.ts → tests/checkout.spec.ts (map)')
})

test('pass 2: a route change selects specs that visit it, with a path boundary', () => {
  const sel = selectSpecs(['app/checkout/page.tsx'], SPECS, SOURCES, {})
  expect(sel).toMatchObject({ mode: 'specs', specs: ['tests/checkout-guest.spec.ts', 'tests/checkout.spec.ts'] })
  const short = selectSpecs(['app/check/page.tsx'], SPECS, { 'tests/checkout.spec.ts': "page.goto('/checkout')" }, {})
  expect(short.mode).toBe('smoke')
  expect(selectSpecs(['app/page.tsx'], SPECS, SOURCES, {}).specs).toEqual(['tests/home.spec.ts'])
  expect(selectSpecs(['app/layout.tsx'], SPECS, SOURCES, {}).mode).toBe('smoke')
})

test('pass 3: a changed spec selects itself', () => {
  const sel = selectSpecs(['tests/cart.spec.ts', 'README.md'], SPECS, SOURCES, {})
  expect(sel).toMatchObject({ mode: 'specs', specs: ['tests/cart.spec.ts'] })
})

test('unmapped UI change runs smoke; no UI change runs nothing', () => {
  const smoke = selectSpecs(['src/components/Button.tsx'], SPECS, SOURCES, { smokeTag: '@critical' })
  expect(smoke.mode).toBe('smoke')
  expect(smoke.specs).toEqual([])
  expect(smoke.why[0]).toContain('@critical')
  expect(selectSpecs(['docs/a.md', 'package.json'], SPECS, SOURCES, {}).mode).toBe('none')
  expect(selectSpecs([], SPECS, SOURCES, {}).mode).toBe('none')
})

test('mixed: mapped files run their specs and the unmapped ones are noted', () => {
  const sel = selectSpecs(['app/cart/page.tsx', 'src/lib/format.ts'], SPECS, SOURCES, {})
  expect(sel.specs).toEqual(['tests/cart.spec.ts'])
  expect(sel.why.at(-1)).toBe('no spec mapped: src/lib/format.ts')
})

test('mixed: a file no spec covers adds the @smoke specs to the mapped ones', () => {
  const sources = { ...SOURCES, 'tests/home.spec.ts': "test('home @smoke', async ({ page }) => { await page.goto('/') })" }
  const sel = selectSpecs(['app/cart/page.tsx', 'src/lib/format.ts'], SPECS, sources, {})
  expect(sel.mode).toBe('specs')
  expect(sel.specs).toEqual(['tests/cart.spec.ts', 'tests/home.spec.ts'])
  expect(sel.why).toContain('src/lib/format.ts → tests/home.spec.ts (smoke @smoke)')
  expect(sel.why.at(-1)).toBe('no spec mapped: src/lib/format.ts')
  // The configured tag is the one used.
  expect(selectSpecs(['app/cart/page.tsx', 'src/lib/format.ts'], SPECS, sources, { smokeTag: '@critical' }).specs).toEqual(['tests/cart.spec.ts'])
})
