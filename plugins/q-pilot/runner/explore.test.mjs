// Prompt mode (explore, save), press, and the occlusion filter. Jev is stubbed.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from './pilot.mjs'
import { observe } from './snapshot.mjs'
import { pressMatches } from './replay.mjs'
import { BUG, DRIFT, coffeePolicy, DEMO, ENV, makeApp, stubJev } from './testkit.mjs'

const FIXTURE = 'buyer@example.test'
const GOAL = 'Buy one bag of coffee beans and place the order with the email from the fixtures. Stop when an order confirmation is shown.'
const CHECKS = [{ testid: 'total', text: '€12.00' }, { role: 'status', text: 'Order confirmed' }]

const specFor = (port, over = {}) => ({ name: 'coffee', baseURL: `http://localhost:${port}`, start: '/', goal: GOAL, fixtures: { email: FIXTURE }, checks: CHECKS, ...over })
const explore = (root, spec, ...extra) => main(['explore', '--root', root, '--spec-json', JSON.stringify(spec), ...extra], ENV)
const flowOf = r => {
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.flows[0]
}
async function withApp(edits, fn) {
  const app = await makeApp(edits)
  try {
    return await fn(app)
  } finally {
    app.cleanup()
  }
}

test('explore pass: Jev drives, code grades, proposals and a final screenshot are written', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const r = await explore(root, specFor(port))
      const f = flowOf(r)
      assert.equal(f.outcome, 'pass')
      assert.equal(f.id, 'coffee')
      assert.equal(f.jevCalls, 4)
      assert.deepEqual(f.steps.map(s => s.by), ['jev', 'jev', 'jev'])
      assert.ok(f.steps.every(s => s.p > 0.5))
      assert.deepEqual(f.checks.map(c => c.ok), [true, true])
      assert.deepEqual(f.warnings, [])
      assert.ok(existsSync(f.screenshot))
      const trace = JSON.parse(readFileSync(f.proposal, 'utf8'))
      assert.equal(trace.flow, 'coffee')
      assert.equal(trace.steps.some(s => 'p' in s || 'by' in s), false)
      const flow = JSON.parse(readFileSync(f.flowProposal, 'utf8'))
      assert.deepEqual({ id: flow.id, start: flow.start, verify: flow.verify, covers: flow.covers, tags: flow.tags }, { id: 'coffee', start: '/', verify: CHECKS, covers: [], tags: [] })
      assert.equal(existsSync(join(root, '.q-pilot', 'traces', 'coffee.json')), false, 'explore writes only into the run dir')
    } finally { stub.restore() }
  }))

test('explore fail: Jev says DONE but a check is red, so the outcome is fail with no proposal', () =>
  withApp(BUG, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const f = flowOf(await explore(root, specFor(port)))
      assert.equal(f.outcome, 'fail')
      assert.deepEqual(f.verifyFails, [{ check: CHECKS[0], actual: '€120.00' }])
      assert.deepEqual(f.checks.map(c => c.ok), [false, true])
      assert.equal(f.proposal, null)
      assert.ok(existsSync(f.screenshot))
    } finally { stub.restore() }
  }))

test('explore blocked: checks are still reported', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(() => ({ op: 'BLOCKED' }))
    try {
      const f = flowOf(await explore(root, specFor(port)))
      assert.equal(f.outcome, 'blocked')
      assert.match(f.error, /jev chose BLOCKED/)
      assert.equal(f.checks.length, 2)
      assert.deepEqual(f.checks.map(c => c.ok), [false, false])
      assert.equal(f.checks[0].actual, null)
      assert.ok(existsSync(f.screenshot))
      assert.equal(f.proposal, null)
    } finally { stub.restore() }
  }))

test('explore without Jev is blocked "jev unavailable" and still reports checks', () =>
  withApp({}, async ({ root, port }) => {
    const f = flowOf(await explore(root, specFor(port), '--no-jev'))
    assert.equal(f.outcome, 'blocked')
    assert.match(f.error, /jev unavailable/)
    assert.equal(f.checks.length, 2)
    assert.equal(f.jevCalls, 0)
  }))

test('weak-checks: only url, title or bare visible checks warn; a content check does not', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const weak = await explore(root, specFor(port, { checks: [{ url: 'checkout' }, { role: 'status' }] }))
      assert.deepEqual(flowOf(weak).warnings, ['weak-checks'])
      assert.equal(flowOf(weak).outcome, 'pass', 'weak checks still run')
      assert.deepEqual(flowOf(await explore(root, specFor(port, { checks: [{ url: 'checkout' }, { role: 'status', text: 'Order confirmed' }] }))).warnings, [])
    } finally { stub.restore() }
  }))

test('soft checks are reported with p and never change the outcome', async () => {
  // Sequential: the Jev stub replaces the global fetch.
  for (const [edits, outcome, noul] of [[{}, 'pass', 0.02], [BUG, 'fail', 0.99]]) {
    await withApp(edits, async ({ root, port }) => {
      const stub = stubJev(coffeePolicy(), { noul })
      try {
        const f = flowOf(await explore(root, specFor(port, { softChecks: ['Does the page show that the order was placed?'] })))
        assert.equal(f.outcome, outcome)
        assert.deepEqual(f.softChecks, [{ question: 'Does the page show that the order was placed?', p: noul }])
        const soft = stub.requests.find(q => !q.body.questions.operation)
        assert.equal(Object.keys(soft.body.questions).length, 1)
        assert.equal(Object.values(soft.body.questions)[0].type, 'noul')
        assert.equal(soft.raw.includes(FIXTURE), false)
      } finally { stub.restore() }
    })
  }
})

test('explore redacts secret ($env) fixture values from the result, the requests and the run dir files', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const spec = specFor(port, { fixtures: { email: '$env:E2E_EMAIL' }, checks: [...CHECKS, { label: 'Email', value: 'nope' }] })
      const r = await explore(root, spec)
      const f = flowOf(r)
      assert.equal(f.outcome, 'fail')
      assert.equal(f.checks[2].actual, '[redacted]')
      assert.equal(JSON.stringify(r).includes(FIXTURE), false)
      for (const q of stub.requests) assert.equal(q.raw.includes(FIXTURE), false)
      for (const file of readdirSync(r.runDir)) if (file.endsWith('.json')) assert.equal(readFileSync(join(r.runDir, file), 'utf8').includes(FIXTURE), false, file)
    } finally { stub.restore() }
  }))

test('a passing explore with a $env fixture keeps the reference, never the value, in the flow proposal and trace', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const f = flowOf(await explore(root, specFor(port, { fixtures: { email: '$env:E2E_EMAIL' } })))
      assert.equal(f.outcome, 'pass')
      assert.equal(JSON.parse(readFileSync(f.flowProposal, 'utf8')).fixtures.email, '$env:E2E_EMAIL')
      assert.equal(readFileSync(f.proposal, 'utf8').includes(FIXTURE), false)
      for (const q of stub.requests) assert.equal(q.raw.includes(FIXTURE), false)
    } finally { stub.restore() }
  }))

test('a literal fixture is visible to Jev (test data), but the trace stores the key only and Jev gets key names', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const f = flowOf(await explore(root, specFor(port)))
      assert.equal(f.outcome, 'pass')
      assert.ok(stub.requests.some(q => q.raw.includes(FIXTURE)), 'the filled value is in the element values sent to Jev')
      assert.deepEqual(stub.requests[1].body.questions.fixture.criteria, { email: 'fixture "email"' })
      assert.deepEqual(stub.requests[1].body.state.fixtures_available, ['email'])
      const trace = readFileSync(f.proposal, 'utf8')
      assert.match(trace, /"fixture": "email"/)
      assert.equal(trace.includes(FIXTURE), false)
    } finally { stub.restore() }
  }))

test('an invalid spec is an error entry; remote baseURL is refused with Q_PILOT_ALLOW_REMOTE=0', () =>
  withApp({}, async ({ root, port }) => {
    for (const [over, re] of [[{ checks: [] }, /at least one check/], [{ goal: '' }, /goal/], [{ softChecks: ['1', '2', '3', '4', '5', '6'] }, /at most 5/], [{ name: '../x' }, /name/], [{ fixtures: { k: '$env:HOME' } }, /E2E_ or Q_PILOT_/]]) {
      const f = flowOf(await explore(root, specFor(port, over)))
      assert.equal(f.outcome, 'error')
      assert.match(f.error, re)
    }
    const remote = flowOf(await main(['explore', '--root', root, '--spec-json', JSON.stringify(specFor(port, { baseURL: 'https://arxiv.org' }))], { ...ENV, Q_PILOT_ALLOW_REMOTE: '0' }))
    assert.equal(remote.outcome, 'error')
    assert.match(remote.error, /loopback/)
    assert.equal(flowOf(await main(['explore', '--root', root, '--spec-json', '{'], ENV)).outcome, 'error')
  }))

test('save writes flow and trace, refuses to overwrite, and refuses a run without a proposal', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    let runId, failedRun
    try {
      runId = (await explore(root, specFor(port))).runId
      failedRun = (await explore(root, specFor(port, { checks: [{ testid: 'total', text: 'nope' }] }))).runId
    } finally { stub.restore() }
    rmSync(join(root, '.q-pilot', 'traces', 'checkout-coffee.json'))
    rmSync(join(root, 'flows', 'checkout-coffee.flow.json'))
    const saved = await main(['save', '--root', root, '--run', runId, '--name', 'my-coffee'], ENV)
    assert.equal(saved.ok, true, JSON.stringify(saved))
    const flow = JSON.parse(readFileSync(join(root, 'flows', 'my-coffee.flow.json'), 'utf8'))
    assert.equal(flow.id, 'my-coffee')
    assert.equal(JSON.parse(readFileSync(join(root, '.q-pilot', 'traces', 'my-coffee.json'), 'utf8')).flow, 'my-coffee')
    // The saved flow replays with no Jev.
    const replay = flowOf(await main(['run', '--root', root, '--flows', 'my-coffee', '--no-jev'], ENV))
    assert.equal(replay.outcome, 'pass')
    assert.equal(replay.jevCalls, 0)
    const again = await main(['save', '--root', root, '--run', runId, '--name', 'my-coffee'], ENV)
    assert.equal(again.ok, false)
    assert.match(again.error, /already exists/)
    assert.match((await main(['save', '--root', root, '--run', failedRun], ENV)).error, /no proposal/)
    assert.match((await main(['save', '--root', root, '--run', '../x'], ENV)).error, /invalid run id/)
    assert.match((await main(['save', '--root', root, '--run', runId, '--name', '../x'], ENV)).error, /invalid flow id/)
  }))

test('save creates q-pilot.config.json with the spec baseURL when there is none', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    let runId
    try { runId = (await explore(root, specFor(port))).runId } finally { stub.restore() }
    for (const f of ['q-pilot.config.json', 'flows', '.q-pilot/traces']) rmSync(join(root, f), { recursive: true, force: true })
    const saved = await main(['save', '--root', root, '--run', runId], ENV)
    assert.equal(saved.ok, true, JSON.stringify(saved))
    assert.equal(JSON.parse(readFileSync(join(root, 'q-pilot.config.json'), 'utf8')).baseURL, `http://localhost:${port}`)
  }))

test('PRESS_ENTER is offered after a fill, recorded as a press step, and replays with no Jev', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(coffeePolicy('ENTER'))
    let f
    try {
      f = flowOf(await explore(root, specFor(port)))
      assert.equal(f.outcome, 'pass')
      assert.deepEqual(f.steps.map(s => s.op), ['click', 'fill', 'press'])
      assert.equal(f.steps[2].key, 'Enter')
      // PRESS_ENTER is not offered before any field was filled.
      assert.equal('PRESS_ENTER' in stub.requests[0].body.questions.operation.criteria, false)
      assert.equal('PRESS_ENTER' in stub.requests[2].body.questions.operation.criteria, true)
    } finally { stub.restore() }
    const proposal = JSON.parse(readFileSync(f.proposal, 'utf8'))
    assert.deepEqual(proposal.steps[2], { op: 'press', key: 'Enter', url: '/checkout.html?item=coffee' })
    writeFileSync(join(root, '.q-pilot', 'traces', 'checkout-coffee.json'), JSON.stringify(proposal))
    const replay = flowOf(await main(['run', '--root', root, '--flows', 'checkout-coffee', '--no-jev'], ENV))
    assert.equal(replay.outcome, 'pass')
    assert.deepEqual(replay.steps.map(s => s.op), ['click', 'fill', 'press'])
  }))

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(() => browser.close())

test('the occlusion filter drops elements covered by a fixed overlay', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`<button style="position:absolute;left:20px;top:20px">Search</button>
    <button style="position:absolute;left:20px;top:100px">Visible</button>
    <div style="position:fixed;left:0;top:0;width:400px;height:60px;background:#fff"></div>
    <a href="#x" style="position:absolute;left:20px;top:200px"><span>Inner link</span></a>`)
  const names = (await observe(page)).actions.filter(a => a.node).map(a => a.name)
  assert.deepEqual(names, ['Visible', 'Inner link'])
  await page.close()
})

test('the snapshot offers the extra "Open" click for every editable field, like jev-ultrafast (date and place pickers open on click)', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`<input aria-label="Plain"><input type="search" aria-label="Find"><input role="combobox" aria-label="Pick"><textarea aria-label="Notes"></textarea><input readonly aria-label="Date"></textarea>`)
  const seen = (await observe(page)).actions.filter(a => a.node).map(a => `${a.kind} ${a.label}`)
  // The "Open" click keeps the field's name; only its label says Open.
  assert.ok((await observe(page)).actions.filter(a => a.open).every(a => !a.name.startsWith('Open ')))
  assert.deepEqual(seen, ['fill Plain', 'click Open Plain', 'fill Find', 'click Open Find', 'fill Pick', 'click Open Pick', 'fill Notes', 'click Open Notes', 'click Date'])
  await page.close()
})

test('loop guard: an action that changed nothing is not offered again until the page changes', () =>
  withApp({ 'index.html': [['<h1>Products</h1>', '<h1>Products</h1><button>Noop</button>']] }, async ({ root, port }) => {
    const stub = stubJev(({ questions }) => (questions.operation.criteria.CLICK && stub.requests.length === 1 ? { op: 'CLICK', label: 'Noop' } : { op: 'DONE' }))
    try {
      await explore(root, specFor(port, { checks: [{ url: '.*' }] }))
      const offered = r => Object.values(r.body.questions.click_target.criteria).map(c => c.element)
      assert.ok(offered(stub.requests[0]).some(e => e.includes('Noop')))
      assert.equal(stub.requests.length, 2)
      assert.equal(offered(stub.requests[1]).some(e => e.includes('Noop')), false)
      assert.ok(offered(stub.requests[1]).some(e => e.includes('Buy coffee beans')), 'other actions remain')
    } finally { stub.restore() }
  }))

const noops = { 'index.html': [['<h1>Products</h1>', '<h1>Products</h1><button>Noop1</button><button>Noop2</button><button>Noop3</button>']] }

test('loop guard: 3 actions in a row without a page change end as blocked', () =>
  withApp(noops, async ({ root, port }) => {
    const stub = stubJev(() => ({ op: 'CLICK', label: `Noop${stub.requests.length}` }))
    try {
      const f = flowOf(await explore(root, specFor(port)))
      assert.equal(f.outcome, 'blocked')
      assert.equal(f.error, 'no progress: 3 actions without a page change')
      assert.equal(f.jevCalls, 3)
      assert.equal(f.steps.length, 3)
      assert.equal(f.checks.length, 2, 'checks still reported')
    } finally { stub.restore() }
  }))

test('loop guard: WAIT has its own allowance, so 3 waits while loading do not block', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(() => (stub.requests.length <= 3 ? { op: 'WAIT' } : { op: 'DONE' }))
    try {
      const f = flowOf(await explore(root, specFor(port, { checks: [{ url: '.*' }] })))
      assert.equal(f.outcome, 'pass')
      assert.equal(f.jevCalls, 4)
    } finally { stub.restore() }
  }))

test('loop guard: 10 waits without a page change end as blocked', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(() => ({ op: 'WAIT' }))
    try {
      const f = flowOf(await explore(root, specFor(port)))
      assert.equal(f.outcome, 'blocked')
      assert.equal(f.error, 'no progress: 10 waits or scrolls without a page change')
      assert.equal(f.jevCalls, 10)
    } finally { stub.restore() }
  }))

test('PRESS_ENTER is not offered once the fill is no longer the last action', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(({ state, questions }) => {
      const n = stub.requests.length
      if (n === 1) return { op: 'CLICK', label: 'Buy coffee beans' }
      if (n === 2) return { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' }
      if (n === 3) {
        assert.ok(questions.operation.criteria.PRESS_ENTER, 'offered right after the fill')
        return { op: 'WAIT' }
      }
      assert.equal('PRESS_ENTER' in questions.operation.criteria, false, 'not offered after a WAIT')
      return { op: 'DONE' }
    })
    try {
      await explore(root, specFor(port, { checks: [{ url: '.*' }] }))
      assert.equal(stub.requests.length, 4)
    } finally { stub.restore() }
  }))

test('PRESS_ENTER is not offered to heal a step that was not a fill', () =>
  withApp(DRIFT, async ({ root }) => {
    const stub = stubJev(({ state, questions }) => {
      assert.ok(state.step_to_replace)
      assert.equal('PRESS_ENTER' in questions.operation.criteria, false)
      return { op: 'CLICK', label: 'Pay now' }
    })
    try {
      const f = flowOf(await main(['run', '--root', root, '--flows', 'checkout-coffee'], ENV))
      assert.equal(f.outcome, 'drift')
      assert.equal(f.jevCalls, 1)
    } finally { stub.restore() }
  }))

test('replay of a press needs the previous step to be a fill of the focused field, else it is a miss', () =>
  withApp({}, async ({ root }) => {
    const p = join(root, '.q-pilot', 'traces', 'checkout-coffee.json')
    const link = { op: 'click', role: 'link', name: 'Buy coffee beans', scope: 'Products', url: '/' }
    writeFileSync(p, JSON.stringify({ flow: 'checkout-coffee', version: 1, steps: [link, { op: 'press', key: 'Enter', url: '/' }] }))
    const f = flowOf(await main(['run', '--root', root, '--flows', 'checkout-coffee', '--no-jev'], ENV))
    assert.equal(f.outcome, 'blocked')
    assert.match(f.error, /step 2 missed \(press Enter\): jev unavailable/)
  }))

test('pressMatches compares the focused field with the previous fill step', () => {
  const snap = { actions: [{ node: 7, kind: 'fill', role: 'textbox', name: 'Search' }, { node: 8, kind: 'fill', role: 'textbox', name: 'Other' }] }
  const fill = { op: 'fill', role: 'textbox', name: 'Search' }
  assert.equal(pressMatches(fill, snap, 7), true)
  assert.equal(pressMatches(fill, snap, 8), false, 'another field has focus')
  assert.equal(pressMatches(fill, snap, null), false, 'nothing focused')
  assert.equal(pressMatches({ op: 'click', role: 'textbox', name: 'Search' }, snap, 7), false, 'previous step is not a fill')
  assert.equal(pressMatches(undefined, snap, 7), false)
})

test('occlusion: a styled element inside the input\'s own label does not hide it, a foreign overlay does', async () => {
  const page = await browser.newPage({ viewport: { width: 800, height: 600 } })
  await page.setContent(`<label><input type="checkbox" style="position:absolute;left:20px;top:20px;width:20px;height:20px"><span style="position:absolute;left:20px;top:20px;width:20px;height:20px;background:red"></span></label>
    <input type="radio" style="position:absolute;left:20px;top:100px"><div style="position:fixed;left:0;top:90px;width:100px;height:40px;background:#fff"></div>`)
  const roles = (await observe(page)).actions.filter(a => a.node).map(a => a.role)
  assert.deepEqual(roles, ['checkbox'])
  await page.close()
})

test('--spec-json is capped at 32 KB', () =>
  withApp({}, async ({ root, port }) => {
    const f = flowOf(await explore(root, specFor(port, { goal: 'x'.repeat(33 * 1024) })))
    assert.equal(f.outcome, 'error')
    assert.match(f.error, /32 KB/)
  }))

test('a start that resolves off-origin is an error entry', () =>
  withApp({}, async ({ root, port }) => {
    for (const start of ['//evil.com/x', '/\\evil.com']) {
      const f = flowOf(await explore(root, specFor(port, { start })))
      assert.equal(f.outcome, 'error')
      assert.match(f.error, /start/)
    }
  }))
