// End-to-end through main() on temp copies of the demo app. Jev is stubbed; nothing here calls the network.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { headless, main } from './pilot.mjs'
import { BUG, DRIFT, DRIFT_AND_BUG, ENV, freePort, makeApp, stubJev } from './testkit.mjs'
import { withDashFor } from './dashkit.mjs'

const FIXTURE = 'buyer@example.test'
const run = (root, ...extra) => main(['run', '--root', root, '--flows', 'checkout-coffee', ...extra], ENV)
const flowOf = r => {
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.flows[0]
}
const traceFile = root => join(root, '.q-pilot', 'traces', 'checkout-coffee.json')
const answersOf = state => {
  if (state.page.text.includes('Order confirmed')) return { op: 'DONE' }
  const email = state.elements.find(e => e.label === 'Email')
  if (email) return email.value === '' ? { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' } : { op: 'CLICK', label: 'Place order' }
  return { op: 'CLICK', label: 'Buy coffee beans' }
}
const healPolicy = ({ state }) => (state.step_to_replace ? { op: 'CLICK', label: 'Pay now' } : answersOf(state))

async function withApp(edits, fn) {
  const app = await makeApp(edits)
  try {
    return await fn(app)
  } finally {
    app.cleanup()
  }
}

test('green replay passes with 0 Jev calls, starts the server and stops it', () =>
  withApp({}, async ({ root, port }) => {
    const stub = stubJev(() => assert.fail('jev must not be called'))
    try {
      const r = await run(root)
      const f = flowOf(r)
      assert.equal(f.outcome, 'pass')
      assert.equal(f.jevCalls, 0)
      assert.equal(f.recorded, false)
      assert.deepEqual(f.steps.map(s => s.by), ['replay', 'replay', 'replay'])
      assert.equal(f.proposal, null)
      assert.equal(f.trace, null, 'a clean pass keeps no Playwright trace')
      assert.deepEqual(f.pageErrors, [])
      assert.deepEqual(r.playwright, { from: 'project', version: r.playwright.version })
      assert.ok(existsSync(join(r.runDir, 'result.json')))
      assert.equal(await fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false), false, 'server was stopped')
      assert.equal(stub.requests.length, 0)
    } finally { stub.restore() }
  }))

test('the €120 copy is an app-bug with the failed check, the actual value and a screenshot', () =>
  withApp(BUG, async ({ root }) => {
    const f = flowOf(await run(root))
    assert.equal(f.outcome, 'app-bug')
    assert.deepEqual(f.verifyFails, [{ check: { testid: 'total', text: '€12.00' }, actual: '€120.00' }])
    assert.equal(f.jevCalls, 0)
    assert.ok(existsSync(f.screenshot))
    assert.ok(f.trace.endsWith('checkout-coffee.trace.zip') && existsSync(f.trace), 'a red run keeps its Playwright trace')
  }))

test('a failure that goes away on the fresh re-run is flaky', () =>
  withApp({}, async ({ root }) => {
    const server = join(root, 'server.mjs')
    writeFileSync(server, readFileSync(server, 'utf8')
      .replace('const body = await readFile(file)', "let body = await readFile(file)\n    if (path === '/checkout.html' && (globalThis.hits = (globalThis.hits ?? 0) + 1) === 1) body = Buffer.from(String(body).replace('€12.00', '€1.00'))"))
    const f = flowOf(await run(root, '--no-jev'))
    assert.equal(f.outcome, 'flaky')
    assert.equal(f.verifyFails.length, 1)
    assert.equal(f.screenshot, null)
  }))

test('drift copy without Jev is blocked "jev unavailable"', () =>
  withApp(DRIFT, async ({ root }) => {
    const f = flowOf(await run(root, '--no-jev'))
    assert.equal(f.outcome, 'blocked')
    assert.match(f.error, /step 3 missed .*Place order.*jev unavailable/)
    assert.ok(existsSync(f.screenshot))
  }))

test('drift heals one step with a stubbed Jev: old -> new, a proposal, the trace untouched', () =>
  withApp(DRIFT, async ({ root }) => {
    const before = readFileSync(traceFile(root), 'utf8')
    const stub = stubJev(healPolicy)
    try {
      const f = flowOf(await run(root))
      assert.equal(f.outcome, 'drift')
      assert.equal(f.jevCalls, 1)
      assert.equal(f.diverged.length, 1)
      assert.deepEqual(f.diverged[0].was, { op: 'click', role: 'button', name: 'Place order' })
      assert.deepEqual(f.diverged[0].now, { op: 'click', role: 'button', name: 'Pay now' })
      assert.equal(f.diverged[0].step, 3)
      assert.ok(f.diverged[0].p > 0.5)
      assert.deepEqual(f.steps.map(s => s.by), ['replay', 'replay', 'jev'])
      assert.ok(existsSync(f.proposal) && existsSync(f.screenshot))
      const proposal = JSON.parse(readFileSync(f.proposal, 'utf8'))
      assert.equal(proposal.version, 2)
      assert.equal(proposal.steps[2].name, 'Pay now')
      assert.equal(readFileSync(traceFile(root), 'utf8'), before)
      assert.deepEqual(stub.requests[0].body.state.step_to_replace, { op: 'click', role: 'button', name: 'Place order' })

      // accept copies the proposal over the trace
      const acc = await main(['accept', '--root', root, '--flow', 'checkout-coffee'], ENV)
      assert.equal(acc.ok, true)
      assert.equal(JSON.parse(readFileSync(traceFile(root), 'utf8')).steps[2].name, 'Pay now')
      assert.equal(flowOf(await run(root, '--no-jev')).outcome, 'pass')
    } finally { stub.restore() }
  }))

test('accept with no proposal reports it', () =>
  withApp({}, async ({ root }) => {
    const r = await main(['accept', '--root', root, '--flow', 'checkout-coffee'], ENV)
    assert.equal(r.ok, false)
    assert.match(r.error, /no proposal/)
  }))

test('more than 2 missed steps is blocked', () =>
  withApp({}, async ({ root }) => {
    const bogus = n => ({ op: 'click', role: 'button', name: `Nope ${n}`, scope: '', url: '/' })
    writeFileSync(traceFile(root), JSON.stringify({ flow: 'checkout-coffee', version: 1, steps: [bogus(1), bogus(2), bogus(3)] }))
    const stub = stubJev(() => ({ op: 'WAIT' }))
    try {
      const f = flowOf(await run(root))
      assert.equal(f.outcome, 'blocked')
      assert.match(f.error, /more than 2 steps missed/)
      assert.equal(f.jevCalls, 2)
    } finally { stub.restore() }
  }))

test('a heal below the probability threshold is blocked and names Jev\'s pick', () =>
  withApp(DRIFT, async ({ root }) => {
    // CLICK at 0.4 (the argmax) and a certain target: p = 0.4 < 0.5.
    const stub = stubJev(({ questions }) => {
      const ops = Object.keys(questions.operation.criteria)
      const answers = { operation: { type: 'choice', choice: 'CLICK', confidence: 0.4, probabilities: Object.fromEntries(ops.map(o => [o, o === 'CLICK' ? 0.4 : 0.6 / (ops.length - 1)])) } }
      for (const [name, q] of Object.entries(questions)) {
        if (name === 'operation' || name === 'fixture') continue
        const ids = Object.keys(q.criteria)
        const pick = ids.find(k => q.criteria[k].element.includes('] Pay now')) ?? ids[0]
        answers[name] = { type: 'choice', choice: pick, confidence: 1, probabilities: Object.fromEntries(ids.map(i => [i, i === pick ? 1 : 0])) }
      }
      return { raw: answers }
    })
    try {
      const f = flowOf(await run(root))
      assert.equal(f.outcome, 'blocked')
      assert.match(f.error, /step 3 missed .*Place order.*Pay now.* has p 0\.40 < 0\.5/)
      assert.equal(f.diverged.length, 0)
    } finally { stub.restore() }
  }))

test('an invalid Jev answer during a heal is blocked with the reason', () =>
  withApp(DRIFT, async ({ root }) => {
    const stub = stubJev(() => ({ raw: { operation: { type: 'choice', choice: 'CLICK', confidence: 0.9, probabilities: { CLICK: 0.2 } } } }))
    try {
      const f = flowOf(await run(root))
      assert.equal(f.outcome, 'blocked')
      assert.match(f.error, /invalid operation answer/)
    } finally { stub.restore() }
  }))

test('Jev choosing DONE before the trace end is blocked', () =>
  withApp(DRIFT, async ({ root }) => {
    const stub = stubJev(() => ({ op: 'DONE' }))
    try {
      const f = flowOf(await run(root))
      assert.equal(f.outcome, 'blocked')
      assert.match(f.error, /jev chose DONE/)
    } finally { stub.restore() }
  }))

test('a drift whose verify then fails is an app-bug', () =>
  withApp(DRIFT_AND_BUG, async ({ root }) => {
    const stub = stubJev(healPolicy)
    try {
      assert.equal(flowOf(await run(root)).outcome, 'app-bug')
    } finally { stub.restore() }
  }))

test('server down is env', () =>
  withApp({}, async ({ root }) => {
    const cfgPath = join(root, 'q-pilot.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    delete cfg.server
    cfg.baseURL = `http://127.0.0.1:${await freePort()}`
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const f = flowOf(await run(root))
    assert.equal(f.outcome, 'env')
    assert.match(f.error, /start not reachable/)
  }))

test('a server that does not start is env for every flow', () =>
  withApp({}, async ({ root }) => {
    const cfgPath = join(root, 'q-pilot.config.json')
    const cfg = JSON.parse(readFileSync(cfgPath, 'utf8'))
    cfg.server.command = ['node', 'missing.mjs']
    writeFileSync(cfgPath, JSON.stringify(cfg))
    const f = flowOf(await run(root))
    assert.equal(f.outcome, 'env')
    assert.match(f.error, /server exited/)
  }))

test('a missing $env: fixture is env and names the variable', () =>
  withApp({}, async ({ root }) => {
    const p = join(root, 'flows', 'checkout-coffee.flow.json')
    const flow = JSON.parse(readFileSync(p, 'utf8'))
    flow.fixtures.password = '$env:E2E_PASSWORD'
    writeFileSync(p, JSON.stringify(flow))
    const f = flowOf(await run(root))
    assert.equal(f.outcome, 'env')
    assert.match(f.error, /E2E_PASSWORD/)
  }))

test('landing on loginPath is env', () =>
  withApp({}, async ({ root }) => {
    const cfgPath = join(root, 'q-pilot.config.json')
    writeFileSync(cfgPath, JSON.stringify({ ...JSON.parse(readFileSync(cfgPath, 'utf8')), loginPath: '/checkout.html' }))
    const f = flowOf(await run(root))
    assert.equal(f.outcome, 'env')
    assert.match(f.error, /redirected to \/checkout\.html/)
  }))

test('no trace and no Jev is untraced and nothing runs', () =>
  withApp({}, async ({ root }) => {
    rmSync(traceFile(root))
    const f = flowOf(await run(root, '--no-jev'))
    assert.equal(f.outcome, 'untraced')
    assert.equal(f.durationMs < 1000, true)
  }))

test('secret ($env) fixture values never reach a trace, a proposal or a Jev request (record and run)', () =>
  withApp({}, async ({ root }) => {
    const flowPath = join(root, 'flows', 'checkout-coffee.flow.json')
    writeFileSync(flowPath, JSON.stringify({ ...JSON.parse(readFileSync(flowPath, 'utf8')), fixtures: { email: '$env:E2E_EMAIL' } }))
    rmSync(traceFile(root))
    const stub = stubJev(({ state }) => answersOf(state))
    try {
      // `run` on an untraced flow records a proposal
      const r = await run(root)
      const f = flowOf(r)
      assert.equal(f.outcome, 'pass')
      assert.equal(f.recorded, true)
      assert.equal(f.jevCalls, 4)
      assert.ok(stub.requests.length === 4)
      assert.ok(existsSync(f.proposal))
      assert.equal(existsSync(traceFile(root)), false, 'run never writes traces')
      const proposal = readFileSync(f.proposal, 'utf8')
      assert.match(proposal, /"fixture": "email"/)
      assert.equal(proposal.includes(FIXTURE), false)

      // `record` writes the trace
      const rec = flowOf(await main(['record', '--root', root, '--flow', 'checkout-coffee'], ENV))
      assert.equal(rec.outcome, 'pass')
      assert.equal(readFileSync(traceFile(root), 'utf8').includes(FIXTURE), false)
      assert.equal(JSON.parse(readFileSync(traceFile(root), 'utf8')).steps.length, 3)

      for (const q of stub.requests) assert.equal(q.raw.includes(FIXTURE), false, 'fixture value in a Jev request')
      // The page showed the filled value to the snapshot: it must have been redacted, not dropped.
      assert.ok(stub.requests.some(q => q.raw.includes('[redacted]')))
      for (const file of readdirSync(r.runDir)) if (file.endsWith('.json')) assert.equal(readFileSync(join(r.runDir, file), 'utf8').includes(FIXTURE), false)
    } finally { stub.restore() }
  }))

test('record with an empty verify returns needs-verify and writes no trace', () =>
  withApp({}, async ({ root }) => {
    const p = join(root, 'flows', 'checkout-coffee.flow.json')
    writeFileSync(p, JSON.stringify({ ...JSON.parse(readFileSync(p, 'utf8')), verify: [] }))
    rmSync(traceFile(root))
    const stub = stubJev(({ state }) => answersOf(state))
    try {
      const f = flowOf(await main(['record', '--root', root, '--flow', 'checkout-coffee'], ENV))
      assert.equal(f.outcome, 'needs-verify')
      assert.equal(existsSync(traceFile(root)), false)
      assert.deepEqual(f.suggestedVerify[0], { url: '/checkout\\.html\\?item=coffee$' })
      assert.ok(f.suggestedVerify.some(c => c.role === 'status' && c.text === 'Order confirmed'))
    } finally { stub.restore() }
  }))

test('flows that do not start before --budget-ms are skipped', () =>
  withApp({}, async ({ root }) => {
    const f = flowOf(await run(root, '--budget-ms', '1'))
    assert.equal(f.outcome, 'skipped')
  }))

test('an unknown flow and an invalid flow are errors for that flow; list reports traces', () =>
  withApp({}, async ({ root }) => {
    writeFileSync(join(root, 'flows', 'broken.flow.json'), JSON.stringify({ id: 'broken', start: '/', goal: 'g', verify: [{ url: 'x', bogus: 1 }] }))
    const r = await main(['run', '--root', root, '--flows', 'nope,broken'], ENV)
    assert.deepEqual(r.flows.map(f => f.outcome), ['error', 'error'])
    assert.match(r.flows[1].error, /unknown key "bogus"/)
    const l = await main(['list', '--root', root], ENV)
    assert.equal(l.flows.find(x => x.id === 'checkout-coffee').hasTrace, true)
  }))

test('bad arguments return ok:false', async () => {
  assert.equal((await main(['run'], ENV)).ok, false)
  assert.equal((await main(['nope', '--root', '.'], ENV)).ok, false)
})

test('export writes a spec through export.mjs', () =>
  withApp({}, async ({ root }) => {
    const r = await main(['export', '--root', root, '--flow', 'checkout-coffee'], ENV)
    if (r.error === 'export module missing') return
    assert.equal(r.ok, true, JSON.stringify(r))
    assert.match(readFileSync(r.out, 'utf8'), /checkout-coffee/)
  }))

test('the browser is headed by default, headless on Q_PILOT_HEADLESS=1, in CI or on Linux without a display', () => {
  assert.equal(headless({}, 'darwin'), false)
  assert.equal(headless({ Q_PILOT_HEADLESS: '1' }, 'darwin'), true)
  assert.equal(headless({ Q_PILOT_HEADLESS: '0' }, 'darwin'), false)
  assert.equal(headless({ CI: 'true' }, 'darwin'), true)
  assert.equal(headless({}, 'linux'), true)
  assert.equal(headless({ DISPLAY: ':0' }, 'linux'), false)
})

test('--dashboard and --keep-trace are accepted flags; --keep-trace keeps the trace of a clean pass', () =>
  withApp({}, async ({ root }) => {
    const stub = stubJev(() => assert.fail('jev must not be called'))
    try {
      const f = flowOf(await run(root, '--dashboard', '--keep-trace'))
      assert.equal(f.outcome, 'pass')
      assert.ok(f.trace && existsSync(f.trace), 'the Playwright trace is kept')
    } finally { stub.restore() }
  }))

test('with a dashboard a replay registers one session per flow: kind flow by default, gate on request, never a tab', () =>
  withApp({}, async ({ root }) => {
    const stub = stubJev(() => assert.fail('jev must not be called'))
    try {
      await withDashFor(root, ENV, async ({ env, sessions, opened }) => {
        const a = await main(['run', '--root', root, '--flows', 'checkout-coffee'], env)
        const g = await main(['run', '--root', root, '--flows', 'checkout-coffee', '--session-kind', 'gate'], env)
        const byId = Object.fromEntries((await sessions()).map(s => [s.id, s]))
        assert.deepEqual([byId[`${a.runId}:checkout-coffee`].kind, byId[`${a.runId}:checkout-coffee`].outcome], ['flow', 'pass'])
        assert.deepEqual([byId[`${g.runId}:checkout-coffee`].kind, byId[`${g.runId}:checkout-coffee`].status], ['gate', 'ended'])
        assert.deepEqual(opened, [])
        assert.equal(flowOf(g).outcome, 'pass')
      })
    } finally { stub.restore() }
  }))
