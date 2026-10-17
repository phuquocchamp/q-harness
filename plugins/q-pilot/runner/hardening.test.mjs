// Review fixes: signals and the hard deadline, ids and paths, stale proposals, redaction, re-run outcomes.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { main } from './pilot.mjs'
import { buildTrace } from './trace.mjs'
import { BUG, DRIFT, ENV, makeApp, stubJev } from './testkit.mjs'

const PILOT = new URL('./pilot.mjs', import.meta.url).pathname
const FIXTURE = 'buyer@example.test'
const run = (root, ...extra) => main(['run', '--root', root, '--flows', 'checkout-coffee', ...extra], ENV)
const flowOf = r => {
  assert.equal(r.ok, true, JSON.stringify(r))
  return r.flows[0]
}
const up = async port => fetch(`http://127.0.0.1:${port}/`).then(() => true, () => false)
const until = async (fn, ms = 10000) => {
  for (const end = Date.now() + ms; Date.now() < end; await new Promise(r => setTimeout(r, 50))) if (await fn()) return true
  return false
}
const readJson = (root, ...p) => JSON.parse(readFileSync(join(root, ...p), 'utf8'))
const patch = (root, rel, fn) => writeFileSync(join(root, rel), JSON.stringify(fn(readJson(root, rel))))

async function withApp(edits, fn) {
  const app = await makeApp(edits)
  try {
    return await fn(app)
  } finally {
    app.cleanup()
  }
}

test('SIGTERM during a run stops the server and exits', () =>
  withApp(BUG, async ({ root, port }) => {
    const child = spawn(process.execPath, [PILOT, 'run', '--root', root, '--all'], { env: { ...process.env, TYPESAFE_API_KEY: '' }, stdio: 'ignore' })
    const exited = new Promise(res => child.on('exit', (code, sig) => res({ code, sig })))
    assert.equal(await until(() => up(port)), true, 'server came up')
    child.kill('SIGTERM')
    const { code } = await exited
    assert.equal(code, 143)
    assert.equal(await until(async () => !(await up(port)), 3000), true, 'server was stopped')
  }))

test('the hard deadline (--budget-ms + 5 s) ends a server that never answers and kills it', () =>
  withApp({}, async ({ root }) => {
    writeFileSync(join(root, 'hang.mjs'), "import { writeFileSync } from 'node:fs'\nwriteFileSync('hang.pid', String(process.pid))\nsetInterval(() => {}, 1000)\n")
    patch(root, 'q-pilot.config.json', c => ({ ...c, server: { ...c.server, command: ['node', 'hang.mjs'], timeoutMs: 60000 } }))
    const t0 = Date.now()
    const r = await run(root, '--budget-ms', '300')
    assert.equal(r.ok, false)
    assert.match(r.error, /hard deadline/)
    assert.ok(Date.now() - t0 < 8000)
    const pid = Number(readFileSync(join(root, 'hang.pid'), 'utf8'))
    assert.equal(await until(() => { try { process.kill(pid, 0); return false } catch { return true } }, 3000), true, 'hanging server was killed')
  }))

test('a re-run that cannot complete is blocked, not app-bug', () =>
  withApp({}, async ({ root }) => {
    // First visit shows the wrong total; later visits rename the button, so the re-run misses step 3 (no Jev).
    const server = join(root, 'server.mjs')
    writeFileSync(server, readFileSync(server, 'utf8').replace('const body = await readFile(file)', `let body = await readFile(file)
    if (path === '/checkout.html') {
      const n = (globalThis.hits = (globalThis.hits ?? 0) + 1)
      body = Buffer.from(String(body).replace(...(n === 1 ? ['€12.00', '€120.00'] : ['Place order', 'Pay now'])))
    }`))
    const f = flowOf(await run(root, '--no-jev'))
    assert.equal(f.outcome, 'blocked')
    assert.match(f.error, /re-run did not complete.*jev unavailable/)
  }))

test('a replay with an empty verify is needs-verify, never pass', () =>
  withApp({}, async ({ root }) => {
    patch(root, 'flows/checkout-coffee.flow.json', f => ({ ...f, verify: [] }))
    const f = flowOf(await run(root, '--no-jev'))
    assert.equal(f.outcome, 'needs-verify')
    assert.ok(f.suggestedVerify.length > 0)
  }))

test('fixture values are redacted from verifyFails (check and actual) in the result', () =>
  withApp({}, async ({ root }) => {
    patch(root, 'flows/checkout-coffee.flow.json', f => ({ ...f, fixtures: { email: '$env:E2E_EMAIL' }, verify: [{ label: 'Email', value: 'nope' }, { role: 'status', text: FIXTURE }] }))
    const r = await run(root, '--no-jev')
    const f = flowOf(r)
    assert.equal(f.outcome, 'app-bug')
    assert.equal(f.verifyFails.length, 2)
    assert.equal(JSON.stringify(r).includes(FIXTURE), false)
    assert.equal(f.verifyFails[0].actual, '[redacted]')
  }))

test('a secret echoed by the page is [redacted] for Jev and in the trace, and replay still matches it', () =>
  withApp({ 'checkout.html': [['Place order', `Pay ${FIXTURE}`]] }, async ({ root }) => {
    const stub = stubJev(({ state }) => {
      if (state.page.text.includes('Order confirmed')) return { op: 'DONE' }
      const email = state.elements.find(e => e.label === 'Email')
      if (email) return email.value === '' ? { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' } : { op: 'CLICK', label: 'Pay [redacted]' }
      return { op: 'CLICK', label: 'Buy coffee beans' }
    })
    try {
      patch(root, 'flows/checkout-coffee.flow.json', f => ({ ...f, fixtures: { email: '$env:E2E_EMAIL' } }))
      const rec = flowOf(await main(['record', '--root', root, '--flow', 'checkout-coffee'], ENV))
      assert.equal(rec.outcome, 'pass')
      for (const q of stub.requests) assert.equal(q.raw.includes(FIXTURE), false)
      assert.equal(readJson(root, '.q-pilot/traces/checkout-coffee.json').steps[2].name, 'Pay [redacted]')
      // Live candidates are redacted the same way before matching.
      assert.equal(flowOf(await run(root, '--no-jev')).outcome, 'pass')
    } finally { stub.restore() }
  }))

test('a literal echoed by the page may appear in a trace name, and replay matches it', () =>
  withApp({ 'checkout.html': [['Place order', `Pay ${FIXTURE}`]] }, async ({ root }) => {
    const stub = stubJev(({ state }) => {
      if (state.page.text.includes('Order confirmed')) return { op: 'DONE' }
      const email = state.elements.find(e => e.label === 'Email')
      if (email) return email.value === '' ? { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' } : { op: 'CLICK', label: `Pay ${FIXTURE}` }
      return { op: 'CLICK', label: 'Buy coffee beans' }
    })
    try {
      const rec = flowOf(await main(['record', '--root', root, '--flow', 'checkout-coffee'], ENV))
      assert.equal(rec.outcome, 'pass')
      assert.equal(readJson(root, '.q-pilot/traces/checkout-coffee.json').steps[2].name, `Pay ${FIXTURE}`)
      assert.equal(flowOf(await run(root, '--no-jev')).outcome, 'pass')
    } finally { stub.restore() }
  }))

test('buildTrace redacts secrets from name, scope, option and url; literals stay', () => {
  const step = { op: 'select', role: 'combobox', name: 'Mail buyer@example.test', scope: 'For buyer@example.test', option: 'buyer@example.test', url: '/x?e=buyer@example.test', by: 'jev', p: 0.9 }
  const t = buildTrace('f', [step], 1, [FIXTURE])
  assert.deepEqual(t.steps[0], { op: 'select', role: 'combobox', name: 'Mail [redacted]', scope: 'For [redacted]', option: '[redacted]', url: '/x?e=[redacted]' })
  assert.equal(buildTrace('f', [step], 1, []).steps[0].name, 'Mail buyer@example.test')
})

test('ids are validated: accept, run ids, run --flows and export --out', () =>
  withApp({}, async ({ root }) => {
    const evil = await main(['accept', '--root', root, '--flow', '../../../evil'], ENV)
    assert.equal(evil.ok, false)
    assert.match(evil.error, /invalid flow id/)
    assert.equal(existsSync(join(root, '..', '..', '..', 'evil.json')), false)
    assert.match((await main(['accept', '--root', root, '--flow', 'checkout-coffee', '--run', '../x'], ENV)).error, /invalid run id/)
    const r = await main(['run', '--root', root, '--flows', '../evil'], ENV)
    assert.equal(r.flows[0].outcome, 'error')
    assert.match(r.flows[0].error, /invalid flow id/)
    const out = await main(['export', '--root', root, '--flow', 'checkout-coffee', '--out', '../escape.spec.ts'], ENV)
    assert.equal(out.ok, false)
    assert.match(out.error, /inside --root|export module missing/)
    assert.equal(existsSync(join(root, '..', 'escape.spec.ts')), false)
  }))

test('accept uses only the latest run that contains the flow; no stale fallback', () =>
  withApp(DRIFT, async ({ root }) => {
    const stub = stubJev(({ state }) => (state.step_to_replace ? { op: 'CLICK', label: 'Pay now' } : { op: 'WAIT' }))
    try {
      assert.equal(flowOf(await run(root)).outcome, 'drift')
    } finally { stub.restore() }
    // A later run of the same flow without a proposal (blocked: no Jev) hides the older proposal.
    assert.equal(flowOf(await run(root, '--no-jev')).outcome, 'blocked')
    const r = await main(['accept', '--root', root, '--flow', 'checkout-coffee'], ENV)
    assert.equal(r.ok, false)
    assert.match(r.error, /no proposal/)
    assert.equal(readJson(root, '.q-pilot/traces/checkout-coffee.json').steps[2].name, 'Place order')
  }))

test('with remote access off, a remote baseURL is an error naming the rule', () =>
  withApp({}, async ({ root }) => {
    patch(root, 'q-pilot.config.json', c => ({ ...c, baseURL: 'https://staging.example.com' }))
    const r = await main(['run', '--root', root, '--flows', 'checkout-coffee'], { ...ENV, Q_PILOT_ALLOW_REMOTE: '0' })
    assert.equal(r.ok, false)
    assert.match(r.error, /loopback.*Q_PILOT_ALLOW_REMOTE=0/)
  }))

test('a flow with a disallowed $env: name is an error for that flow', () =>
  withApp({}, async ({ root }) => {
    patch(root, 'flows/checkout-coffee.flow.json', f => ({ ...f, fixtures: { ...f.fixtures, key: '$env:TYPESAFE_API_KEY' } }))
    const f = flowOf(await run(root, '--no-jev'))
    assert.equal(f.outcome, 'error')
    assert.match(f.error, /E2E_ or Q_PILOT_/)
  }))

test('leaving the base origin after an action is allowed by default, blocked with Q_PILOT_ALLOW_REMOTE=0', () =>
  withApp({}, async ({ root, port }) => {
    // 127.0.0.1 is a different origin from the localhost baseURL.
    const index = join(root, 'src', 'index.html')
    writeFileSync(index, readFileSync(index, 'utf8').replace('/checkout.html?item=coffee', `http://127.0.0.1:${port}/checkout.html?item=coffee`))
    const f = flowOf(await main(['run', '--root', root, '--flows', 'checkout-coffee', '--no-jev'], { ...ENV, Q_PILOT_ALLOW_REMOTE: '0' }))
    assert.equal(f.outcome, 'blocked')
    assert.equal(f.error, `left the allowed origin: http://127.0.0.1:${port}`)
    const allowed = flowOf(await run(root, '--no-jev'))
    assert.equal(allowed.outcome, 'pass')
  }))

test('the repo server command never receives the Jev key', () =>
  withApp({}, async ({ root }) => {
    const server = join(root, 'server.mjs')
    writeFileSync(server, "import { writeFileSync } from 'node:fs'\nwriteFileSync('env.json', JSON.stringify({ key: process.env.TYPESAFE_API_KEY ?? null, path: Boolean(process.env.PATH) }))\n" + readFileSync(server, 'utf8'))
    const child = spawn(process.execPath, [PILOT, 'run', '--root', root, '--all', '--no-jev'], { env: { ...process.env, TYPESAFE_API_KEY: 'sk-secret' }, stdio: 'ignore' })
    await new Promise(res => child.on('exit', res))
    assert.deepEqual(JSON.parse(readFileSync(join(root, 'env.json'), 'utf8')), { key: null, path: true })
  }))
