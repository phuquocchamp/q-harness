// Jev's goal-met and stuck cross-checks: asked in the same request, used to hold back a DONE on a task without
// checks and to refuse an action Jev repeats while it says it is stuck.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pilot } from './record.mjs'
import { chooseAction, createJev } from './jev.mjs'
import { DEMO, stubJev } from './testkit.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

const run = (page, over = {}) =>
  pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: over.steps ?? 20 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, crossCheck: true, checkDone: over.checkDone ?? null })

const snap = { url: 'http://x/', title: 'T', text: '', actions: [{ id: 'e1', node: 1, kind: 'click', role: 'button', name: 'Go', label: 'Go', value: '' }] }

test('crossCheck adds the goal-met and stuck questions to the same request and returns their answers', async () => {
  const stub = stubJev(() => ({ op: 'CLICK', goal_met: 0.1, stuck: 0.8 }))
  try {
    const d = await chooseAction(createJev({ apiKey: 'k' }), { goal: 'Open the page', snap, history: [], fixtureKeys: [], secrets: [], crossCheck: true })
    assert.equal(stub.requests.length, 1)
    const q = stub.requests[0].body.questions
    assert.deepEqual([q.goal_met.type, q.stuck.type], ['noul', 'noul'])
    assert.match(q.goal_met.instructions, /^Goal: Open the page\n/)
    assert.deepEqual([d.detail.goalMet, d.detail.stuck], [0.1, 0.8])
    await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap, history: [], fixtureKeys: [], secrets: [] })
    assert.equal('goal_met' in stub.requests[1].body.questions, false)
  } finally { stub.restore() }
})

const COUNTER = '<button onclick="n.textContent = +n.textContent + 1">Next</button><p id=n>0</p>'

test('a DONE on a task without checks is held back once when "goal met?" is low, then stands', async () => {
  const page = await browser.newPage()
  const stub = stubJev(({ questions }) => (questions.operation.criteria.DONE ? { op: 'DONE', goal_met: 0.2 } : { op: 'CLICK', label: 'Next' }))
  try {
    await page.setContent(COUNTER)
    const r = await run(page)
    assert.equal(r.end, 'done')
    // DONE refused at step 1, three clicks while it is not offered, then DONE stands (one veto per run).
    assert.equal(r.steps.length, 3)
    assert.match(r.decisions[0].refused, /^DONE while "goal met\?" is p 0\.20/)
  } finally {
    stub.restore()
    await page.close()
  }
})

test('with checks, "goal met?" never holds a DONE back: the checks decide', async () => {
  const page = await browser.newPage()
  const stub = stubJev(() => ({ op: 'DONE', goal_met: 0.1 }))
  try {
    await page.setContent(COUNTER)
    const r = await run(page, { checkDone: async () => [] })
    assert.deepEqual([r.end, r.steps.length], ['done', 0])
  } finally {
    stub.restore()
    await page.close()
  }
})

test('an action repeated while "stuck?" is high is refused like one that changed nothing', async () => {
  const page = await browser.newPage()
  // The switch changes the page every time, so only the cross-check stops the toggling.
  const offered = q => Object.values(q.click_target?.criteria ?? {}).some(c => c.element.includes('] Select all'))
  const stub = stubJev(({ questions }) => (offered(questions) ? { op: 'CLICK', label: 'Select all', stuck: 0.9 } : { op: 'BLOCKED' }))
  try {
    await page.setContent('<button role=switch aria-checked=true onclick="this.setAttribute(\'aria-checked\', this.getAttribute(\'aria-checked\') === \'true\' ? \'false\' : \'true\')">Select all</button><button>Close</button>')
    const r = await run(page)
    // Toggled once; the second toggle is refused, so the switch is no longer offered and Jev gives up.
    assert.deepEqual([r.end, r.error, r.steps.length], ['blocked', 'jev chose BLOCKED', 1])
    assert.ok(r.decisions.some(d => /repeats a recent action/.test(d.refused ?? '')))
  } finally {
    stub.restore()
    await page.close()
  }
})
