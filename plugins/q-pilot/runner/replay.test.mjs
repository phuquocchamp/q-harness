import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { match, replay } from './replay.mjs'
import { DEMO } from './testkit.mjs'

const a = (node, over) => ({ node, kind: 'click', role: 'button', name: 'Add', scope: '', ...over })

test('one candidate is acted on', () => {
  const r = match([a(1), a(2, { name: 'Other' })], { op: 'click', role: 'button', name: 'Add', scope: 'x' })
  assert.equal(r.action.node, 1)
})

test('name matching collapses whitespace; op and role must agree', () => {
  assert.equal(match([a(1, { name: 'Add' })], { op: 'click', role: 'button', name: ' Add ' }).action.node, 1)
  assert.equal(match([a(1)], { op: 'fill', role: 'button', name: 'Add' }).action, null)
  assert.equal(match([a(1)], { op: 'click', role: 'link', name: 'Add' }).action, null)
})

test('no candidate is a miss', () => {
  assert.deepEqual(match([a(1)], { op: 'click', role: 'button', name: 'Pay' }), { action: null, candidates: 0 })
})

test('look-alikes are narrowed by scope', () => {
  const list = [a(1, { scope: 'Coffee' }), a(2, { scope: 'Tea' })]
  assert.equal(match(list, { op: 'click', role: 'button', name: 'Add', scope: 'Tea' }).action.node, 2)
})

test('look-alikes that scope cannot tell apart are a miss, never a guess', () => {
  const same = [a(1, { scope: 'Cart' }), a(2, { scope: 'Cart' })]
  assert.deepEqual(match(same, { op: 'click', role: 'button', name: 'Add', scope: 'Cart' }), { action: null, candidates: 2 })
  assert.equal(match(same, { op: 'click', role: 'button', name: 'Add', scope: 'Other' }).action, null)
  assert.equal(match([a(1, { scope: 'A' }), a(2, { scope: 'B' })], { op: 'click', role: 'button', name: 'Add' }).action, null)
})

test('select steps also match the option; one node listed twice counts once', () => {
  const sel = [a(1, { kind: 'select', role: 'combobox', name: 'Size', option: 'S' }), a(1, { kind: 'select', role: 'combobox', name: 'Size', option: 'L' })]
  assert.equal(match(sel, { op: 'select', role: 'combobox', name: 'Size', option: 'L' }).action.option, 'L')
  assert.equal(match([a(1), a(1)], { op: 'click', role: 'button', name: 'Add' }).candidates, 1)
})

test('replay tells the inspector what it saw and did per step (by replay, with the phase), never gates, and survives a throwing inspector', async () => {
  const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
  const browser = await chromium.launch()
  const page = await browser.newPage()
  const calls = []
  const inspector = new Proxy({}, { get: (_, k) => (...a) => { calls.push([k, ...a]) } })
  try {
    await page.setContent('<button onclick="document.title=1">Add</button><button onclick="document.title=2">Pay</button>')
    const trace = { steps: [{ op: 'click', role: 'button', name: 'Add' }, { op: 'click', role: 'button', name: 'Pay' }] }
    const flow = { id: 't', start: '/', goal: 'g', budget: { steps: 5 } }
    const r = await replay(page, { flow, trace, fixtures: {}, jev: { available: false }, deadline: Date.now() + 10000, inspector, phase: 'rerun' })
    assert.equal(r.end, 'done')
    assert.deepEqual(calls.map(c => c[0]), ['observed', 'acted', 'observed', 'acted'])
    assert.deepEqual(calls.filter(c => c[0] === 'observed').map(c => c[3]), [1, 2])
    assert.deepEqual(calls.filter(c => c[0] === 'acted').map(c => [c[1].step, c[1].by, c[1].phase]), [[1, 'replay', 'rerun'], [2, 'replay', 'rerun']])
    assert.equal(calls.some(c => c[0] === 'gate'), false)

    // A throwing inspector never fails the replay.
    const bad = new Proxy({}, { get: () => () => { throw new Error('boom') } })
    await page.setContent('<button>Add</button>')
    assert.equal((await replay(page, { flow, trace: { steps: [trace.steps[0]] }, fixtures: {}, jev: { available: false }, deadline: Date.now() + 10000, inspector: bad })).end, 'done')
  } finally {
    await browser.close()
  }
})
