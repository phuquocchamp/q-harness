import { test } from 'node:test'
import assert from 'node:assert/strict'
import { chooseAction, createJev, JevError, validateChoice } from './jev.mjs'
import { stubJev } from './testkit.mjs'

const ids = ['a', 'b']
const good = { choice: 'a', confidence: 0.9, probabilities: { a: 0.9, b: 0.1 } }

test('validateChoice accepts a good answer', () => assert.equal(validateChoice(good, ids), true))

test('validateChoice rejects bad answers', () => {
  const bad = [
    null, 'a', {},
    { ...good, choice: 'c' },
    { ...good, probabilities: { a: 0.9 } },
    { ...good, probabilities: { a: 0.9, b: 0.1, c: 0 } },
    { ...good, probabilities: { a: 0.5, b: 0.1 } },
    { ...good, probabilities: { a: 1.2, b: -0.2 } },
    { ...good, probabilities: { a: 0.1, b: 0.9 } },
    { ...good, confidence: 'high' },
    { ...good, probabilities: { a: NaN, b: 0.1 } },
    { ...good, probabilities: [0.9, 0.1] },
  ]
  for (const b of bad) assert.equal(validateChoice(b, ids), false, JSON.stringify(b))
})

const snap = {
  url: 'http://x/', title: 'T', text: 'hello',
  actions: [
    { id: 'e1', node: 1, kind: 'click', role: 'button', name: 'Go', label: 'Go', value: '' },
    { id: 'wait', kind: 'wait', label: 'Wait' },
  ],
}
const ask = jev => chooseAction(jev, { goal: 'g', snap, history: [], fixtureKeys: [], secrets: [] })

test('chooseAction maps a valid answer to the action', async () => {
  const stub = stubJev(() => ({ op: 'CLICK' }))
  try {
    const d = await ask(createJev({ apiKey: 'k' }))
    assert.equal(d.action.node, 1)
    assert.ok(d.p > 0.8)
    assert.deepEqual(Object.keys(stub.requests[0].body.questions), ['operation', 'click_target'])
  } finally { stub.restore() }
})

test('chooseAction rejects an invalid operation head and an invalid target head', async () => {
  let stub = stubJev(() => ({ raw: { operation: { type: 'choice', choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.5, WAIT: 0.1, DONE: 0, BLOCKED: 0 } } } }))
  try { await assert.rejects(ask(createJev({ apiKey: 'k' })), /invalid operation/) } finally { stub.restore() }
  stub = stubJev(() => ({ raw: {
    operation: { type: 'choice', choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.9, WAIT: 0.1, DONE: 0, BLOCKED: 0 } },
    click_target: { type: 'choice', choice: 'zz', confidence: 1, probabilities: { 1: 1 } },
  } }))
  try { await assert.rejects(ask(createJev({ apiKey: 'k' })), JevError) } finally { stub.restore() }
})

test('chooseAction turns DONE into an end', async () => {
  const stub = stubJev(() => ({ op: 'DONE' }))
  try { assert.equal((await ask(createJev({ apiKey: 'k' }))).end, 'DONE') } finally { stub.restore() }
})

test('a timeout and an HTTP error are JevErrors, and calls are counted', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))
    const slow = createJev({ apiKey: 'k', timeoutMs: 30 })
    await assert.rejects(slow.request({}), /timeout/)
    assert.equal(slow.calls, 1)
    globalThis.fetch = async () => new Response('{}', { status: 500 })
    await assert.rejects(createJev({ apiKey: 'k' }).request({}), /HTTP 500/)
  } finally { globalThis.fetch = real }
})
