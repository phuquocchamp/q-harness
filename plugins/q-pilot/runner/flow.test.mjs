import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ConfigError, loadConfig, loadFlow, resolveFixtures, validateCheck, validateFlow } from './flow.mjs'

const good = () => ({ id: 'a-b', start: '/', goal: 'g', fixtures: { email: 'x@y.z' }, verify: [{ url: 'x$' }] })

test('a valid flow gets defaults', () => {
  const f = validateFlow(good(), 'a-b')
  assert.deepEqual(f.budget, { steps: 20, seconds: 20 })
  assert.deepEqual(f.covers, [])
})

test('id must equal the file stem and match [a-z0-9-]+', () => {
  assert.throws(() => validateFlow(good(), 'other'), /file name stem/)
  assert.throws(() => validateFlow({ ...good(), id: 'A_b' }, 'A_b'), /\[a-z0-9-\]/)
})

test('start must be a path on the base origin, never //host or /\\host', () => {
  for (const start of ['//evil.com/x', '/\\evil.com', '//', 'x', 'http://evil.com']) assert.throws(() => validateFlow({ ...good(), start }, 'a-b'), /start/, start)
  for (const start of ['/', '/a/b?c=1', '/a//b']) assert.ok(validateFlow({ ...good(), start }, 'a-b'), start)
})

test('start, goal, fixtures, verify and budget are validated', () => {
  assert.throws(() => validateFlow({ ...good(), start: 'x' }, 'a-b'), /start/)
  assert.throws(() => validateFlow({ ...good(), goal: '' }, 'a-b'), /goal/)
  assert.throws(() => validateFlow({ ...good(), fixtures: { a: 1 } }, 'a-b'), /fixtures/)
  assert.throws(() => validateFlow({ ...good(), verify: {} }, 'a-b'), /verify/)
  assert.throws(() => validateFlow({ ...good(), budget: { steps: 0 } }, 'a-b'), /budget/)
})

test('verify checks: unknown keys, two targets, two expectations, bad regex', () => {
  assert.throws(() => validateCheck({ url: 'x', foo: 1 }), /unknown key "foo"/)
  assert.throws(() => validateCheck({ url: 'x', title: 'y' }), /more than one target/)
  assert.throws(() => validateCheck({ testid: 't', text: 'a', contains: 'b' }), /more than one expectation/)
  assert.throws(() => validateCheck({ url: '(' }), /regex/)
  assert.throws(() => validateCheck({ name: 'n' }), /needs a target|only valid/)
  assert.throws(() => validateCheck({ testid: 't', name: 'n' }), /only valid with "role"/)
  assert.throws(() => validateCheck({ url: 'x', text: 'y' }), /takes no expectation/)
  assert.throws(() => validateCheck({ text: 'a', visible: false }), /alone/)
})

test('verify checks: every valid shape passes', () => {
  for (const c of [{ url: 'x$' }, { title: 'T' }, { role: 'status' }, { role: 'link', name: 'N', visible: false }, { testid: 't', text: 'a' }, { testid: 't', contains: 'a' }, { label: 'L', value: 'v' }, { text: 'hello' }]) {
    assert.equal(validateCheck(c), c)
  }
})

test('$env: fixtures resolve from env; a missing one is reported by name', () => {
  const flow = validateFlow({ ...good(), fixtures: { email: 'x@y.z', password: '$env:E2E_PASSWORD' } }, 'a-b')
  // Only values from the environment are secret; a literal is plain test data.
  assert.deepEqual(resolveFixtures(flow, { E2E_PASSWORD: 's3cret!' }), { values: { email: 'x@y.z', password: 's3cret!' }, missing: [], secrets: ['s3cret!'] })
  assert.deepEqual(resolveFixtures(flow, {}), { values: { email: 'x@y.z' }, missing: ['E2E_PASSWORD'], secrets: [] })
})

test('config: baseURL is required, server needs command and url', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-pilot-cfg-'))
  const put = c => writeFileSync(join(root, 'q-pilot.config.json'), JSON.stringify(c))
  assert.throws(() => loadConfig(root), ConfigError)
  put({})
  assert.throws(() => loadConfig(root), /baseURL/)
  put({ baseURL: 'http://localhost:1', server: { command: [] } })
  assert.throws(() => loadConfig(root), /server/)
  put({ baseURL: 'http://localhost:1', server: { command: ['node', 's.mjs'], url: 'http://localhost:1' } })
  assert.deepEqual(loadConfig(root).server, { command: ['node', 's.mjs'], url: 'http://localhost:1', timeoutMs: 20000 })
  assert.equal(loadConfig(root).flowsDir, 'flows')
})

test('loadFlow reports a missing and a malformed file', () => {
  const root = mkdtempSync(join(tmpdir(), 'q-pilot-cfg-'))
  mkdirSync(join(root, 'flows'))
  writeFileSync(join(root, 'flows', 'bad.flow.json'), '{')
  assert.throws(() => loadFlow(root, { flowsDir: 'flows' }, 'nope'), /not found/)
  assert.throws(() => loadFlow(root, { flowsDir: 'flows' }, 'bad'), ConfigError)
})

test('$env: names must start with E2E_ or Q_PILOT_; TYPESAFE_API_KEY is never allowed', () => {
  const withEnv = name => ({ ...good(), fixtures: { k: `$env:${name}` } })
  assert.ok(validateFlow(withEnv('E2E_PASSWORD'), 'a-b'))
  assert.ok(validateFlow(withEnv('Q_PILOT_TOKEN'), 'a-b'))
  for (const bad of ['AWS_SECRET_ACCESS_KEY', 'TYPESAFE_API_KEY', 'PATH', 'E2E', 'e2e_x']) {
    assert.throws(() => validateFlow(withEnv(bad), 'a-b'), /must start with E2E_ or Q_PILOT_/, bad)
  }
})

test('remote baseURL is allowed by default; with Q_PILOT_ALLOW_REMOTE=0, baseURL and server.url must be loopback', () => {
  const local = { Q_PILOT_ALLOW_REMOTE: '0' }
  const root = mkdtempSync(join(tmpdir(), 'q-pilot-cfg-'))
  const put = c => writeFileSync(join(root, 'q-pilot.config.json'), JSON.stringify(c))
  for (const url of ['http://localhost:3000', 'http://127.0.0.1:1', 'http://[::1]:1']) {
    put({ baseURL: url })
    assert.equal(loadConfig(root, local).baseURL, url)
  }
  put({ baseURL: 'https://staging.example.com' })
  assert.throws(() => loadConfig(root, local), /baseURL must be loopback.*Q_PILOT_ALLOW_REMOTE=0/)
  assert.equal(loadConfig(root, {}).baseURL, 'https://staging.example.com')
  assert.equal(loadConfig(root, { Q_PILOT_ALLOW_REMOTE: '1' }).baseURL, 'https://staging.example.com')
  put({ baseURL: 'http://localhost:1', server: { command: ['x'], url: 'http://evil.test' } })
  assert.throws(() => loadConfig(root, local), /server\.url must be loopback/)
  put({ baseURL: 'http://localhost.evil.test' })
  assert.throws(() => loadConfig(root, local), /loopback/)
})
