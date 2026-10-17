// Runs only with Q_PILOT_LIVE=1 and TYPESAFE_API_KEY: real Jev calls (paid key), so run it rarely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { createRequire } from 'node:module'
import { main } from './pilot.mjs'
import { sendInput, startLive } from './screencast.mjs'
import { DEMO, DRIFT, makeApp } from './testkit.mjs'

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

// Needs only the Playwright install the demo app uses (no key): a real Chromium screencast and take-control input.
const chromium = (() => {
  try { return createRequire(`${DEMO}/package.json`)('playwright').chromium } catch { return null }
})()

test('screencast: a real Chromium streams JPEG frames, take-control input lands in the page, stop is clean', { skip: chromium ? false : 'Playwright not installed' }, async () => {
  const browser = await chromium.launch()
  const page = await browser.newPage({ viewport: { width: 640, height: 400 } })
  try {
    await page.setContent('<button style="position:fixed;left:0;top:0;width:640px;height:400px" onclick="document.title=\'clicked\'">Go</button><input id="i" style="position:fixed;left:0;top:0;width:10px">')
    const frames = []
    const live = await startLive(page, (buf, meta) => frames.push({ buf, meta }), { fps: 20 })
    const t0 = Date.now()
    while (!frames.length && Date.now() - t0 < 5000) {
      await page.evaluate(() => (document.body.style.background = `#${Math.floor(Math.random() * 0xffffff).toString(16).padStart(6, '0')}`))
      await page.waitForTimeout(100)
    }
    assert.ok(frames.length, 'no screencast frame within 5 s')
    assert.deepEqual([...frames[0].buf.subarray(0, 2)], [0xff, 0xd8], 'a JPEG')
    assert.ok(frames[0].meta.deviceWidth > 0)
    assert.match(await sendInput(page, { type: 'click', x: 0.5, y: 0.5 }, frames[0].meta), /^click at \(\d+, \d+\)$/)
    assert.equal(await page.title(), 'clicked')
    await live.stop()
    await live.stop()
  } finally {
    await browser.close()
  }
})
