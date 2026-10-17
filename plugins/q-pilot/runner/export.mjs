// Turns a flow and its trace into the text of a Playwright test file. Pure: no I/O.

const str = (value) => JSON.stringify(String(value))

const oneLine = (value) => String(value).replace(/\s+/g, ' ').trim()

const envRef = (name) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? `process.env.${name}` : `process.env[${str(name)}]`)

// A "clickable" step is a plain element with a pointer cursor and no ARIA role: found by its text.
const roleLocator = (step) => step.role === 'clickable' ? `page.getByText(${str(step.name)}, { exact: true })` : `page.getByRole(${str(step.role)}, { name: ${str(step.name)}, exact: true })`

function fixtureValue(flow, step) {
  const fixtures = flow.fixtures ?? {}
  if (!Object.hasOwn(fixtures, step.fixture)) {
    throw new Error(`export: step "${step.name}" uses fixture "${step.fixture}", which flow "${flow.id}" does not define`)
  }
  const value = fixtures[step.fixture]
  const env = typeof value === 'string' ? /^\$env:(.+)$/.exec(value) : null
  return env ? `${envRef(env[1])}!` : str(value)
}

function stepLines(flow, step) {
  switch (step.op) {
    case 'click':
      return [`await ${roleLocator(step)}.click()`]
    case 'fill':
      return [`await ${roleLocator(step)}.fill(${fixtureValue(flow, step)})`]
    case 'select':
      return [`await ${roleLocator(step)}.selectOption({ label: ${str(step.option)} })`]
    case 'scroll':
      return [`await page.mouse.wheel(0, ${Number(step.delta)})`]
    case 'press':
      if (step.key !== 'Enter') throw new Error(`export: unsupported key "${step.key}" (only "Enter")`)
      return [`await page.keyboard.press(${str(step.key)})`]
    case 'wait':
      return ['await page.waitForTimeout(100)']
    default:
      throw new Error(`export: unknown step op "${step.op}"`)
  }
}

const TARGETS = ['url', 'title', 'role', 'testid', 'label', 'text']
const EXPECTATIONS = ['contains', 'value', 'visible']

function checkLine(check) {
  const opts = '{ timeout: 2000 }'
  const keys = Object.keys(check)
  const known = new Set([...TARGETS, 'name', ...EXPECTATIONS])
  const unknown = keys.find((key) => !known.has(key))
  if (unknown) throw new Error(`export: unknown check key "${unknown}"`)

  // The runner tests the regex against pathname + search, so the spec does too (toHaveURL sees the full URL).
  if ('url' in check) {
    const path = "() => { const u = new URL(page.url()); return u.pathname + u.search }"
    return `await expect.poll(${path}, ${opts}).toMatch(new RegExp(${str(check.url)}))`
  }
  if ('title' in check) return `await expect(page).toHaveTitle(${str(check.title)}, ${opts})`

  let locator
  let ownsText = false
  if ('role' in check) {
    const name = 'name' in check ? `, { name: ${str(check.name)}, exact: true }` : ''
    locator = `page.getByRole(${str(check.role)}${name})`
  } else if ('testid' in check) {
    locator = `page.getByTestId(${str(check.testid)})`
  } else if ('label' in check) {
    locator = `page.getByLabel(${str(check.label)}, { exact: true })`
  } else if ('text' in check) {
    locator = `page.getByText(${str(check.text)}, { exact: true })`
    ownsText = true
  } else {
    throw new Error(`export: check has no target: ${JSON.stringify(check)}`)
  }

  const expectation = ownsText ? null : 'text' in check ? 'text' : EXPECTATIONS.find((key) => key in check)
  switch (expectation) {
    case 'text':
      return `await expect(${locator}).toHaveText(${str(check.text)}, ${opts})`
    case 'contains':
      return `await expect(${locator}).toContainText(${str(check.contains)}, ${opts})`
    case 'value':
      return `await expect(${locator}).toHaveValue(${str(check.value)}, ${opts})`
    default: {
      const visible = ownsText || !('visible' in check) || check.visible !== false
      return `await expect(${locator}).${visible ? 'toBeVisible' : 'toBeHidden'}(${opts})`
    }
  }
}

export function exportSpec(flow, trace, { baseURL }) {
  const body = [`await page.goto(${str(flow.start ?? '/')})`]
  for (const step of trace.steps ?? []) body.push(...stepLines(flow, step))
  for (const check of flow.verify ?? []) body.push(checkLine(check))

  return [
    "import { test, expect } from '@playwright/test'",
    '',
    `// Exported by q-pilot from flow "${oneLine(flow.id).replace(/"/g, "'")}". Goal: ${oneLine(flow.goal ?? '')}`,
    `test.use({ baseURL: process.env.BASE_URL ?? ${str(baseURL)} })`,
    '',
    `test(${str(flow.id)}, async ({ page }) => {`,
    ...body.map((line) => `  ${line}`),
    '})',
    '',
  ].join('\n')
}
