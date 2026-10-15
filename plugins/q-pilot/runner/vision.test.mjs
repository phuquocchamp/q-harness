// Jev vision (preview): the screenshot goes with a decision when Jev is unsure (gated) or always, never with a secret
// fixture; Box rescue clicks where Jev 1.14 locates the control; the inspector can switch it during the run.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pilot } from './record.mjs'
import { chooseAction, createJev, unsure } from './jev.mjs'
import { createInspector } from './inspect.mjs'
import { DEMO, stubJev } from './testkit.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

const choice = (probs, choice = Object.entries(probs).sort((a, b) => b[1] - a[1])[0][0]) => ({ type: 'choice', choice, confidence: probs[choice], probabilities: probs })
const SNAP = {
  url: 'http://x/', title: 'T', text: '',
  actions: [
    { id: 'e1', node: 1, kind: 'click', role: 'button', name: 'Search', label: 'Search', value: '' },
    { id: 'e2', node: 2, kind: 'click', role: 'clickable', name: 'Da Nang DAD', label: 'Da Nang DAD', value: '' },
  ],
}
const SHOT = { data_base64: Buffer.from('jpeg').toString('base64'), format: 'jpg' }

test('unsure: a low operation p, close top targets, or DONE/BLOCKED; a clear answer is not', () => {
  const a = (op, p, t) => ({ operation: choice({ CLICK: p, DONE: 1 - p }, op), click_target: t && choice(t) })
  const targets = { CLICK: { 1: {}, 2: {} } }
  assert.equal(unsure(a('CLICK', 0.5, { 1: 0.9, 2: 0.1 }), targets), true)
  assert.equal(unsure(a('CLICK', 0.9, { 1: 0.55, 2: 0.45 }), targets), true)
  assert.equal(unsure(a('CLICK', 0.9, { 1: 0.9, 2: 0.1 }), targets), false)
  assert.equal(unsure(a('DONE', 0.1), targets), true)
})

test('gated: an unsure text answer is asked again with the screenshot (the preview header on), and that answer is used', async () => {
  let n = 0
  const stub = stubJev(() => {
    n++
    return n === 1
      ? { raw: { operation: choice({ CLICK: 0.9, DONE: 0.05, BLOCKED: 0.05 }), click_target: choice({ 1: 0.52, 2: 0.48 }) } }
      : { raw: { operation: choice({ CLICK: 0.95, DONE: 0.03, BLOCKED: 0.02 }), click_target: choice({ 1: 0.08, 2: 0.92 }) } }
  })
  try {
    const d = await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap: SNAP, history: [], fixtureKeys: [], secrets: [], vision: { mode: 'gated', model: 'jev-1.14.0', shot: async () => SHOT } })
    assert.equal(stub.requests.length, 2)
    assert.equal(stub.requests[0].body.assets, undefined, 'the first request is text only')
    assert.equal(stub.requests[0].headers['TypeSafe-Danger-Zone-Images'], undefined)
    const second = stub.requests[1]
    const [ref] = Object.keys(second.body.assets)
    assert.equal(second.body.state.page.screenshot, ref)
    assert.equal(second.body.model, 'jev-1.14.0')
    assert.equal(second.headers['TypeSafe-Danger-Zone-Images'], 'true')
    assert.equal(d.action.node, 2, 'the answer with the image wins')
    assert.equal(d.detail.vision.used, true)
    assert.equal(d.detail.vision.mode, 'gated')
  } finally {
    stub.restore()
  }
})

test('always sends the screenshot with the first request; off (no vision) never does', async () => {
  const stub = stubJev(() => ({ op: 'CLICK', label: 'Search' }))
  try {
    await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap: SNAP, history: [], fixtureKeys: [], secrets: [], vision: { mode: 'always', model: 'jev-1.13.0', shot: async () => SHOT } })
    assert.equal(stub.requests.length, 1)
    assert.ok(stub.requests[0].body.assets)
    await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap: SNAP, history: [], fixtureKeys: [], secrets: [] })
    assert.equal(stub.requests[1].body.assets, undefined)
  } finally {
    stub.restore()
  }
})

test('a run that types a secret never sends a screenshot, whatever the vision setting', async () => {
  const page = await browser.newPage()
  const stub = stubJev(({ state }) => (state.elements.find(e => e.label === 'Email')?.value ? { op: 'DONE' } : { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' }))
  try {
    await page.setContent('<input aria-label="Email">')
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 5 } }, fixtures: { email: 'secret@x.test' }, secrets: ['secret@x.test'], jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 10000, vision: { mode: 'always', model: 'jev-1.13.0', box: true } })
    assert.equal(r.end, 'done')
    assert.ok(stub.requests.every(q => !q.body.assets), 'no request carried an image')
  } finally {
    stub.restore()
    await page.close()
  }
})

test('Box rescue: where Jev is stuck, Jev 1.14 locates the control and the run clicks its centre, then Jev goes on', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  // A suggestion Jev cannot see in the element list (no role, no pointer cursor): only the screenshot shows it.
  const stub = stubJev(({ state }) => (state.page.text.includes('Picked') ? { op: 'DONE' } : { op: 'BLOCKED' }), { box: { top: 0.2, bottom: 0.3, left: 0.1, right: 0.3, confidence: 0.9 }, noul: 0.95 })
  try {
    await page.setContent('<button style="position:absolute;left:600px;top:400px">Other</button><div style="position:absolute;left:100px;top:120px;width:200px;height:60px" onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Picked</p>\')">Da Nang DAD</div>')
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'Pick Da Nang.', budget: { steps: 6 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 15000, vision: { mode: 'off', model: 'jev-1.13.0', box: true } })
    assert.equal(r.end, 'done')
    const boxReq = stub.requests.find(q => q.body.questions.where?.type === 'box')
    assert.equal(boxReq.body.model, 'jev-1.14.0')
    assert.equal(boxReq.headers['TypeSafe-Danger-Zone-Images'], 'true')
    assert.deepEqual(r.steps.find(s => s.by === 'box'), { op: 'click_at', x: 200, y: 150, url: 'blank', by: 'box', p: 0.855 })
    assert.equal(r.decisions.find(d => d.box)?.chose, 'click at (200, 150)')
  } finally {
    stub.restore()
    await page.close()
  }
})

test('a box with low visibility is not clicked: the run ends as before (no helper)', async () => {
  const page = await browser.newPage({ viewport: { width: 1000, height: 600 } })
  const stub = stubJev(() => ({ op: 'BLOCKED' }), { noul: 0.2 })
  try {
    await page.setContent('<button>Other</button><p>Nothing to click</p>')
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 3 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 10000, vision: { mode: 'off', model: 'jev-1.13.0', box: true } })
    assert.deepEqual([r.end, r.error], ['blocked', 'jev chose BLOCKED'])
    assert.equal(r.steps.length, 0)
    assert.equal(r.decisions.find(d => d.box)?.chose, 'no box rescue')
  } finally {
    stub.restore()
    await page.close()
  }
})

test('the inspector switches vision during the run, and refuses it for a run with a secret', async () => {
  const vision = { mode: 'off', model: 'jev-1.13.0', box: false }
  const ins = await createInspector({ port: 0, vision })
  try {
    const token = /pilot-token" content="([^"]+)"/.exec(await (await fetch(ins.url)).text())[1]
    const set = body => fetch(new URL('/api/settings', ins.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify(body) })
    ins.start({ name: 't', goal: 'g' })
    assert.equal((await set({ mode: 'gated', model: 'jev-1.14.0', box: true })).status, 200)
    assert.deepEqual(vision, { mode: 'gated', model: 'jev-1.14.0', box: true }, 'the run reads the same object')
    assert.equal(ins.state.vision.mode, 'gated')
    assert.equal((await set({ mode: 'sometimes' })).status, 400)
    assert.equal((await set({ model: 'gpt-4o' })).status, 400)
    ins.start({ name: 't', goal: 'g', secrets: ['pw'] })
    assert.equal(vision.mode, 'off')
    assert.match(ins.state.vision.blocked, /secret fixture/)
    assert.equal((await set({ mode: 'always' })).status, 409)
  } finally {
    await ins.close()
  }
})
