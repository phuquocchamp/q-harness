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

test('a timeout and an HTTP error are JevErrors, busy answers are retried, and calls are counted', async () => {
  const real = globalThis.fetch
  try {
    globalThis.fetch = (u, init) => new Promise((_, rej) => init.signal.addEventListener('abort', () => rej(Object.assign(new Error('x'), { name: 'AbortError' }))))
    // A timeout is retried (3 attempts with backoff) before it surfaces.
    const slow = createJev({ apiKey: 'k', timeoutMs: 30 })
    await assert.rejects(slow.request({}), /timeout/)
    assert.equal(slow.calls, 3)
    // A server error is not a busy answer: no retry.
    let n = 0
    globalThis.fetch = async () => (n++, new Response('{}', { status: 500 }))
    await assert.rejects(createJev({ apiKey: 'k' }).request({}), /HTTP 500/)
    assert.equal(n, 1)
    // 429 and 503 are retried; the third answer wins.
    n = 0
    globalThis.fetch = async () => (++n < 3 ? new Response('{}', { status: n === 1 ? 429 : 503 }) : new Response('{"answers":{}}', { status: 200 }))
    const busy = createJev({ apiKey: 'k' })
    assert.deepEqual(await busy.request({}), { answers: {} })
    assert.equal(busy.calls, 3)
  } finally { globalThis.fetch = real }
})

test('chooseAction sends element state, scope and the fixture a field already holds, never its value', async () => {
  const stub = stubJev(() => ({ op: 'CLICK' }))
  try {
    const s = {
      url: 'http://x/', title: 'T', text: '',
      actions: [
        { id: 'e1', node: 1, kind: 'fill', role: 'searchbox', name: 'Search', label: 'Search', value: 'Agentic ', scope: 'Channel', expanded: 'true' },
        { id: 'e2', node: 2, kind: 'click', role: 'tab', name: 'Videos', label: 'Videos', value: '', selected: 'true' },
        { id: 'e3', node: 3, kind: 'fill', role: 'textbox', name: 'Other', label: 'Other', value: 'x' },
      ],
    }
    const history = [{ action: 'click button "Search"', kind: 'click', page_changed: false }]
    await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap: s, history, fixtureKeys: ['q'], fixtures: { q: 'agentic' }, secrets: [] })
    const { body, raw } = stub.requests[0]
    const [search, videos, other] = body.state.elements
    assert.deepEqual([search.scope, search.expanded, search.holds_fixture], ['Channel', 'true', 'q'])
    assert.equal(videos.selected, 'true')
    assert.equal(other.holds_fixture, undefined)
    const t = body.questions.type_text_target.criteria['1']
    assert.match(t.element, /\(in Channel\)$/)
    assert.equal(t.holds_fixture, 'q')
    assert.equal(body.questions.click_target.criteria['2'].selected, 'true')
    assert.equal(body.state.recent_actions[0].page_changed, false)
    assert.equal(raw.includes('"agentic"'), false)
  } finally { stub.restore() }
})
