// A task's plan: Jev is asked about the current step only; a step ends on its `until` check or on Jev's DONE.
// Also the `checked` expectation the steps of a plan often need (a switch turned off).
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pilot } from './record.mjs'
import { createJev } from './jev.mjs'
import { checkOnce } from './verify.mjs'
import { validateCheck, validateTask } from './flow.mjs'
import { exportSpec } from './export.mjs'
import { DEMO, stubJev } from './testkit.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

const task = plan => validateTask({ url: 'https://example.com/', goal: 'g', plan }, null, {})

test('a plan has 2 to 8 steps { do, until? }; until is a check', () => {
  const t = task([{ do: 'Open the filter', until: { role: 'switch', name: 'All', checked: false } }, { do: 'Search' }])
  assert.deepEqual(t.plan.map(s => s.do), ['Open the filter', 'Search'])
  assert.equal(validateTask({ url: 'https://example.com/', goal: 'g' }, null, {}).plan, undefined)
  for (const bad of [[{ do: 'only one' }], [{ do: '' }, { do: 'b' }], [{ do: 'a', then: 'x' }, { do: 'b' }], [{ do: 'a', until: { colour: 'red' } }, { do: 'b' }], 'x']) {
    assert.throws(() => task(bad))
  }
})

test('checked is a boolean expectation; checkOnce reads aria-checked; the export uses toBeChecked', async () => {
  assert.throws(() => validateCheck({ role: 'switch', name: 'All', checked: 'no' }))
  assert.throws(() => validateCheck({ url: '/x', checked: true }))
  const page = await browser.newPage()
  try {
    await page.setContent('<button role=switch aria-checked=false>All</button><input type=checkbox aria-label=Agree checked>')
    assert.deepEqual(await checkOnce(page, { role: 'switch', name: 'All', checked: false }), { ok: true, actual: false })
    assert.deepEqual(await checkOnce(page, { label: 'Agree', checked: false }), { ok: false, actual: true })
  } finally { await page.close() }
  const spec = exportSpec({ id: 'x', start: '/', goal: 'g', fixtures: {}, verify: [{ role: 'switch', name: 'All', checked: false }] }, { steps: [] }, { baseURL: 'http://localhost' })
  assert.match(spec, /toBeChecked\(\{ checked: false, timeout: 2000 \}\)/)
})

const PAGE = `<button role=switch aria-checked=true onclick="this.setAttribute('aria-checked', 'false')">All airlines</button>
<button onclick="n.textContent = +n.textContent + 1">Next</button><p id=n>0</p>`

test('Jev sees the current step; a green until moves the plan on, and DONE on a step without one does too', async () => {
  const page = await browser.newPage()
  const goals = []
  const stub = stubJev(({ questions }) => {
    const goal = questions.operation.instructions.goal
    goals.push(goal.split('\n')[0])
    if (goal.startsWith('Turn off')) return { op: 'CLICK', label: 'All airlines' }
    if (goal.startsWith('Click Next')) return goals.filter(g => g === 'Click Next once').length > 1 ? { op: 'DONE' } : { op: 'CLICK', label: 'Next' }
    return { op: 'DONE' }
  })
  try {
    await page.setContent(PAGE)
    const plan = [
      { do: 'Turn off All airlines', until: { role: 'switch', name: 'All airlines', checked: false } },
      { do: 'Click Next once' },
      { do: 'Stop.' },
    ]
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'Whole task.', budget: { steps: 10 }, plan }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000 })
    assert.equal(r.end, 'done')
    assert.deepEqual(r.steps.map(s => s.name), ['All airlines', 'Next'])
    assert.deepEqual(goals, ['Turn off All airlines', 'Click Next once', 'Click Next once', 'Stop.'])
    assert.match(stub.requests[0].body.questions.operation.instructions.goal, /\(Step 1 of 3 of this task: Whole task\. Earlier steps are done: do only this step now\.\)$/)
    assert.deepEqual(r.decisions.filter(d => /^plan step/.test(d.chose)).map(d => d.why), ['until is green', 'Jev chose DONE'])
  } finally {
    stub.restore()
    await page.close()
  }
})

test('DONE on a step whose until is still red does not move the plan on', async () => {
  const page = await browser.newPage()
  const stub = stubJev(({ questions }) => (questions.operation.criteria.DONE ? { op: 'DONE' } : { op: 'CLICK', label: 'Next' }))
  try {
    await page.setContent(PAGE)
    const plan = [{ do: 'Turn off All airlines', until: { role: 'switch', name: 'All airlines', checked: false } }, { do: 'Stop.' }]
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 3 }, plan }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000 })
    assert.equal(r.end, 'blocked')
    assert.match(r.decisions[0].refused, /^DONE on plan step 1, but its until check is red/)
  } finally {
    stub.restore()
    await page.close()
  }
})
