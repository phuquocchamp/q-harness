import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { cpSync, existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { exportSpec } from './export.mjs'

const baseURL = 'http://localhost:4321'

const flow = {
  id: 'checkout-coffee',
  start: '/',
  goal: 'Buy one bag of coffee beans and place the order using the email from the fixtures.',
  fixtures: { email: 'buyer@example.test', password: '$env:E2E_PASSWORD' },
  verify: [
    { url: '/checkout\\.html\\?item=coffee$' },
    { testid: 'total', text: '€12.00' },
    { role: 'status', text: 'Order confirmed' },
  ],
}

const trace = {
  flow: 'checkout-coffee',
  version: 1,
  steps: [
    { op: 'click', role: 'link', name: 'Buy coffee beans', scope: 'Products', url: '/' },
    { op: 'fill', role: 'textbox', name: 'Email', scope: 'pay', fixture: 'email', url: '/checkout.html?item=coffee' },
    { op: 'click', role: 'button', name: 'Place order', scope: 'pay', url: '/checkout.html?item=coffee' },
  ],
}

const lines = (text) => text.split('\n')

test('exports the design example flow', () => {
  assert.equal(
    exportSpec(flow, trace, { baseURL }),
    [
      "import { test, expect } from '@playwright/test'",
      '',
      '// Exported by q-pilot from flow "checkout-coffee". Goal: Buy one bag of coffee beans and place the order using the email from the fixtures.',
      'test.use({ baseURL: process.env.BASE_URL ?? "http://localhost:4321" })',
      '',
      'test("checkout-coffee", async ({ page }) => {',
      '  await page.goto("/")',
      '  await page.getByRole("link", { name: "Buy coffee beans", exact: true }).click()',
      '  await page.getByRole("textbox", { name: "Email", exact: true }).fill("buyer@example.test")',
      '  await page.getByRole("button", { name: "Place order", exact: true }).click()',
      '  await expect.poll(() => { const u = new URL(page.url()); return u.pathname + u.search }, { timeout: 2000 }).toMatch(new RegExp("/checkout\\\\.html\\\\?item=coffee$"))',
      '  await expect(page.getByTestId("total")).toHaveText("€12.00", { timeout: 2000 })',
      '  await expect(page.getByRole("status").first()).toHaveText("Order confirmed", { timeout: 2000 })',
      '})',
      '',
    ].join('\n'),
  )
})

test('writes each check kind', () => {
  const verify = [
    { title: 'Demo Shop' },
    { role: 'heading', name: 'Products' },
    { role: 'heading', name: 'Products', contains: 'Prod' },
    { testid: 'total', visible: false },
    { label: 'Email', value: 'a@b.test' },
    { text: 'Order confirmed' },
    { testid: 'total', contains: '12' },
  ]
  const out = exportSpec({ ...flow, verify }, { steps: [] }, { baseURL })
  const body = lines(out).filter((l) => l.includes('expect('))
  assert.deepEqual(body, [
    '  await expect(page).toHaveTitle("Demo Shop", { timeout: 2000 })',
    '  await expect(page.getByRole("heading", { name: "Products", exact: true }).first()).toBeVisible({ timeout: 2000 })',
    '  await expect(page.getByRole("heading", { name: "Products", exact: true }).first()).toContainText("Prod", { timeout: 2000 })',
    '  await expect(page.getByTestId("total")).toBeHidden({ timeout: 2000 })',
    '  await expect(page.getByLabel("Email", { exact: true })).toHaveValue("a@b.test", { timeout: 2000 })',
    '  await expect(page.getByText("Order confirmed", { exact: true })).toBeVisible({ timeout: 2000 })',
    '  await expect(page.getByTestId("total")).toContainText("12", { timeout: 2000 })',
  ])
})

test('url checks match pathname + search, so anchored patterns work', () => {
  const out = exportSpec({ ...flow, verify: [{ url: '^/$' }] }, { steps: [] }, { baseURL })
  assert.ok(out.includes('toMatch(new RegExp("^/$"))'))
  assert.ok(out.includes('u.pathname + u.search'))
  assert.ok(!out.includes('toHaveURL'))
})

test('writes select, scroll and wait steps', () => {
  const steps = [
    { op: 'select', role: 'combobox', name: 'Size', option: 'Large' },
    { op: 'scroll', delta: 400 },
    { op: 'wait' },
  ]
  const out = exportSpec({ ...flow, verify: [] }, { steps }, { baseURL })
  assert.ok(out.includes('  await page.getByRole("combobox", { name: "Size", exact: true }).selectOption({ label: "Large" })'))
  assert.ok(out.includes('  await page.mouse.wheel(0, 400)'))
  assert.ok(out.includes('  await page.waitForTimeout(100)'))
})

test('quotes names with quotes and backslashes safely', () => {
  const name = 'Say "hi" \\ there\nnext'
  const out = exportSpec(
    { ...flow, id: 'a"b', goal: 'line one\nline two', verify: [{ text: name }] },
    { steps: [{ op: 'click', role: 'button', name }] },
    { baseURL },
  )
  assert.ok(out.includes(`name: ${JSON.stringify(name)}`))
  assert.ok(out.includes(`getByText(${JSON.stringify(name)}`))
  assert.ok(out.includes('test("a\\"b"'))
  assert.ok(out.includes('Goal: line one line two'))
  assert.equal(lines(out).filter((l) => l.startsWith('//')).length, 1)
})

test('$env fixtures become process.env and literals stay literal', () => {
  const out = exportSpec(
    flow,
    {
      steps: [
        { op: 'fill', role: 'textbox', name: 'Password', fixture: 'password' },
        { op: 'fill', role: 'textbox', name: 'Email', fixture: 'email' },
      ],
    },
    { baseURL },
  )
  assert.ok(out.includes('.fill(process.env.E2E_PASSWORD!)'))
  assert.ok(out.includes('.fill("buyer@example.test")'))
  assert.ok(!out.includes('"$env:'))
})

test('throws on an unknown op, an unknown check and a missing fixture', () => {
  assert.throws(() => exportSpec(flow, { steps: [{ op: 'drag' }] }, { baseURL }), /unknown step op "drag"/)
  assert.throws(() => exportSpec({ ...flow, verify: [{ css: '#x' }] }, { steps: [] }, { baseURL }), /unknown check key "css"/)
  assert.throws(() => exportSpec({ ...flow, verify: [{ visible: true }] }, { steps: [] }, { baseURL }), /no target/)
  assert.throws(
    () => exportSpec(flow, { steps: [{ op: 'fill', role: 'textbox', name: 'X', fixture: 'nope' }] }, { baseURL }),
    /fixture "nope"/,
  )
})

const demo = join(dirname(fileURLToPath(import.meta.url)), '..', 'examples', 'demo-app')
const playwrightCli = join(demo, 'node_modules', '@playwright', 'test', 'cli.js')
const skipReason = existsSync(playwrightCli) ? false : 'Playwright is not installed in examples/demo-app/node_modules'

// A minimal Playwright config for the temp copy: the demo server on the port the exported spec uses.
const PLAYWRIGHT_CONFIG = `import { defineConfig } from '@playwright/test'
export default defineConfig({
  testDir: './tests',
  use: { baseURL: '${baseURL}' },
  webServer: { command: 'node server.mjs', url: '${baseURL}', env: { PORT: '${new URL(baseURL).port}' }, reuseExistingServer: false },
})
`

test('the exported spec runs green against the demo app', { skip: skipReason, timeout: 120000 }, () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-pilot-export-'))
  try {
    for (const name of ['src', 'server.mjs']) cpSync(join(demo, name), join(dir, name), { recursive: true })
    writeFileSync(join(dir, 'playwright.config.ts'), PLAYWRIGHT_CONFIG)
    symlinkSync(join(demo, 'node_modules'), join(dir, 'node_modules'))
    mkdirSync(join(dir, 'tests'))
    writeFileSync(join(dir, 'tests', 'checkout-coffee.spec.ts'), exportSpec({ ...flow, verify: [...flow.verify, { url: '^/checkout\\.html' }] }, trace, { baseURL }))
    const env = { ...process.env, E2E_PASSWORD: 'unused' }
    const run = spawnSync(process.execPath, [playwrightCli, 'test', '--reporter=line', '--retries=0'], { cwd: dir, env, encoding: 'utf8' })
    assert.equal(run.status, 0, `${run.stdout}\n${run.stderr}`)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
