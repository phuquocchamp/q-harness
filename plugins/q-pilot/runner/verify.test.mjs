import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { DEMO } from './testkit.mjs'
import { checkOnce, runVerify } from './verify.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser, page

before(async () => {
  browser = await chromium.launch()
  page = await (await browser.newContext()).newPage()
  await page.goto('http://localhost:1/x', { waitUntil: 'commit' }).catch(() => {})
  await page.route('**/*', r => r.fulfill({ contentType: 'text/html; charset=utf-8', body: `<!doctype html><title>Shop</title>
    <p data-testid="total">  €12.00 </p><p data-testid="note">Free shipping today</p>
    <label>Email <input value="a@b.c"></label><p role="status">Order confirmed</p>
    <button>Pay</button><p>Plain text</p><p data-testid="gone" hidden>x</p>` }))
  await page.goto('http://localhost:1/cart?item=1')
})
after(() => browser.close())

const ok = async c => (await checkOnce(page, c)).ok

test('url is a regex on pathname+search', async () => {
  assert.equal(await ok({ url: '/cart\\?item=1$' }), true)
  assert.deepEqual(await checkOnce(page, { url: '^/other' }), { ok: false, actual: '/cart?item=1' })
})

test('title is exact', async () => {
  assert.equal(await ok({ title: 'Shop' }), true)
  assert.equal(await ok({ title: 'Sho' }), false)
})

test('testid with text (trimmed) and contains', async () => {
  assert.equal(await ok({ testid: 'total', text: '€12.00' }), true)
  assert.deepEqual(await checkOnce(page, { testid: 'total', text: '€1.00' }), { ok: false, actual: '€12.00' })
  assert.equal(await ok({ testid: 'note', contains: 'shipping' }), true)
  assert.equal(await ok({ testid: 'note', contains: 'refund' }), false)
})

test('role with and without name, status text', async () => {
  assert.equal(await ok({ role: 'button', name: 'Pay' }), true)
  assert.equal(await ok({ role: 'button', name: 'Pa' }), false)
  assert.equal(await ok({ role: 'status', text: 'Order confirmed' }), true)
  assert.equal(await ok({ role: 'button' }), true)
})

test('label checks the input value', async () => {
  assert.equal(await ok({ label: 'Email', value: 'a@b.c' }), true)
  assert.deepEqual(await checkOnce(page, { label: 'Email', value: 'x' }), { ok: false, actual: 'a@b.c' })
})

test('text alone is an exact visible match', async () => {
  assert.equal(await ok({ text: 'Plain text' }), true)
  assert.equal(await ok({ text: 'Plain' }), false)
})

test('visible true/false, and a missing element has actual null', async () => {
  assert.equal(await ok({ testid: 'note', visible: true }), true)
  assert.equal(await ok({ testid: 'gone', visible: false }), true)
  assert.equal(await ok({ testid: 'gone' }), false)
  assert.equal(await ok({ testid: 'nothing', visible: false }), true)
  assert.deepEqual(await checkOnce(page, { testid: 'nothing', text: 'x' }), { ok: false, actual: null })
})

test('runVerify returns only the failures and polls until the deadline', async () => {
  const t0 = Date.now()
  const fails = await runVerify(page, [{ title: 'Shop' }, { testid: 'total', text: 'nope' }], { timeoutMs: 300 })
  assert.equal(fails.length, 1)
  assert.deepEqual(fails[0], { check: { testid: 'total', text: 'nope' }, actual: '€12.00' })
  assert.ok(Date.now() - t0 >= 250)
})

test('runVerify redacts fixture values in actual', async () => {
  const fails = await runVerify(page, [{ label: 'Email', value: 'x' }], { timeoutMs: 100, secrets: ['a@b.c'] })
  assert.equal(fails[0].actual, '[redacted]')
})

test('runVerify passes a check that becomes true while polling', async () => {
  await page.evaluate(() => setTimeout(() => (document.querySelector('[role=status]').textContent = 'Later'), 300))
  assert.deepEqual(await runVerify(page, [{ role: 'status', text: 'Later' }], { timeoutMs: 2000 }), [])
})

test('a check that matches several elements fails as ambiguous instead of grading the first', async () => {
  assert.deepEqual(await checkOnce(page, { role: 'paragraph' }), { ok: false, actual: 'ambiguous: 3 elements match' })
  assert.deepEqual(await checkOnce(page, { role: 'paragraph', visible: false }), { ok: false, actual: 'ambiguous: 3 elements match' })
})
