// Runs only with Q_PILOT_LIVE=1 and TYPESAFE_API_KEY: real Jev calls (paid key), so run it rarely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { main } from './pilot.mjs'
import { DRIFT, makeApp } from './testkit.mjs'

const live = process.env.Q_PILOT_LIVE === '1' && process.env.TYPESAFE_API_KEY
const trace = root => join(root, '.q-pilot', 'traces', 'checkout-coffee.json')
const first = async args => (await main(args, process.env)).flows[0]

test('live: record, replay green, then heal a renamed button', { skip: live ? false : 'set Q_PILOT_LIVE=1 and TYPESAFE_API_KEY' }, async () => {
  const plain = await makeApp(), drifted = await makeApp(DRIFT)
  try {
    rmSync(trace(plain.root))
    const rec = await first(['record', '--root', plain.root, '--flow', 'checkout-coffee'])
    console.error('live record', JSON.stringify({ outcome: rec.outcome, jevCalls: rec.jevCalls, jevMs: rec.jevMs }))
    assert.equal(rec.outcome, 'pass')
    assert.ok(existsSync(trace(plain.root)))

    const green = await first(['run', '--root', plain.root, '--flows', 'checkout-coffee'])
    assert.equal(green.outcome, 'pass')
    assert.equal(green.jevCalls, 0)

    copyFileSync(trace(plain.root), trace(drifted.root))
    const healed = await first(['run', '--root', drifted.root, '--flows', 'checkout-coffee'])
    console.error('live heal', JSON.stringify({ outcome: healed.outcome, jevCalls: healed.jevCalls, jevMs: healed.jevMs, diverged: healed.diverged }))
    assert.equal(healed.outcome, 'drift')
    assert.equal(healed.jevCalls, 1)
    assert.equal(healed.diverged[0].now.name, 'Pay now')
    assert.ok(existsSync(healed.proposal))
  } finally {
    plain.cleanup()
    drifted.cleanup()
  }
})

// Prompt mode against real Jev. Three runs in total; the arXiv case needs the network (open by default).
const skip = live ? false : 'set Q_PILOT_LIVE=1 and TYPESAFE_API_KEY'
const GOAL = 'Buy one bag of coffee beans and place the order with the email from the fixtures. Stop when an order confirmation is shown.'
const COFFEE_CHECKS = [{ testid: 'total', text: '€12.00' }, { role: 'status', text: 'Order confirmed' }]
const explore = (root, spec) => main(['explore', '--root', root, '--spec-json', JSON.stringify(spec)], process.env)
const line = f => console.error('live explore', JSON.stringify({ outcome: f.outcome, error: f.error, jevCalls: f.jevCalls, jevMs: f.jevMs, steps: f.steps.map(s => `${s.op} ${s.role ?? ''} ${s.name ?? ''}`.trim()), checks: f.checks.map(c => c.ok), screenshot: f.screenshot }))

test('live explore: demo green passes', { skip }, async () => {
  const app = await makeApp()
  try {
    const f = (await explore(app.root, { name: 'coffee', baseURL: `http://localhost:${app.port}`, goal: GOAL, fixtures: { email: 'buyer@example.test' }, checks: COFFEE_CHECKS })).flows[0]
    line(f)
    assert.equal(f.outcome, 'pass')
  } finally { app.cleanup() }
})

test('live explore: demo with the 120 euro bug fails', { skip }, async () => {
  const app = await makeApp({ 'checkout.html': [['€12.00', '€120.00']] })
  try {
    const f = (await explore(app.root, { name: 'coffee', baseURL: `http://localhost:${app.port}`, goal: GOAL, fixtures: { email: 'buyer@example.test' }, checks: COFFEE_CHECKS })).flows[0]
    line(f)
    assert.equal(f.outcome, 'fail')
  } finally { app.cleanup() }
})

test('live explore: arXiv search from the home page (reports honestly, no assertion on pass)', { skip }, async () => {
  const app = await makeApp()
  try {
    const f = (await explore(app.root, {
      name: 'arxiv', baseURL: 'https://arxiv.org', start: '/',
      goal: 'Find papers related to the query from the fixtures on arXiv using its search. Stop when a list of search results for that query is shown.',
      fixtures: { query: 'agent harness' },
      checks: [{ url: '^/search/\\?.*query=agent\\+harness' }, { role: 'heading', contains: 'results for all: agent harness' }],
    })).flows[0]
    line(f)
    assert.ok(['pass', 'fail', 'blocked'].includes(f.outcome))
  } finally { app.cleanup() }
})
