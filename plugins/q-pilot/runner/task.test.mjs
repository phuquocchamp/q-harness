// Task mode (any browser task, checks optional) and the live inspector. Jev is stubbed; no browser window opens.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync } from 'node:fs'
import { main } from './pilot.mjs'
import { ConfigError, validateTask } from './flow.mjs'
import { createInspector } from './inspect.mjs'
import { coffeePolicy, ENV, freePort, makeApp, stubJev } from './testkit.mjs'

const GOAL = 'Buy one bag of coffee beans and place the order with the email from the fixtures. Stop when an order confirmation is shown.'
const CHECKS = [{ testid: 'total', text: '€12.00' }, { role: 'status', text: 'Order confirmed' }]
const SECRET = ENV.E2E_EMAIL

const taskFor = (port, over = {}) => ({ name: 'coffee', url: `http://localhost:${port}/`, goal: GOAL, fixtures: { email: 'buyer@example.test' }, ...over })
const task = (root, spec, ...extra) => main(['task', '--root', root, '--spec-json', JSON.stringify(spec), ...extra], ENV)
async function withApp(fn) {
  const app = await makeApp()
  try {
    return await fn(app)
  } finally {
    app.cleanup()
  }
}

test('validateTask splits a full url, keeps checks optional and refuses non-http schemes', () => {
  const t = validateTask({ url: 'https://example.com/search?q=1#x', goal: 'Find it.' }, null, {})
  assert.deepEqual({ baseURL: t.baseURL, start: t.start, checks: t.checks, name: t.name, budget: t.budget }, { baseURL: 'https://example.com', start: '/search?q=1', checks: [], name: 'task', budget: { steps: 40, seconds: 180 } })
  for (const url of ['file:///etc/passwd', 'chrome://settings', 'javascript:alert(1)', 'not a url']) {
    assert.throws(() => validateTask({ url, goal: 'x' }, null, {}), ConfigError, url)
  }
  assert.throws(() => validateTask({ goal: 'x' }, null, {}), /task.url is required/)
  assert.equal(validateTask({ goal: 'x', start: '/a' }, { baseURL: 'http://localhost:1' }, {}).start, '/a')
  assert.throws(() => validateTask({ url: 'https://example.com', goal: 'x' }, null, { Q_PILOT_ALLOW_REMOTE: '0' }), /loopback/)
  assert.throws(() => validateTask({ url: 'https://example.com', goal: 'x', checks: [{ bogus: 1 }] }, null, {}), /unknown key/)
})

test('a task with no checks ends done, is marked unverified and proposes nothing to save', () =>
  withApp(async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const r = await task(root, taskFor(port))
      assert.equal(r.ok, true, JSON.stringify(r))
      assert.equal(r.command, 'task')
      const f = r.flows[0]
      assert.equal(f.outcome, 'done')
      assert.deepEqual(f.warnings, ['unverified'])
      assert.deepEqual(f.checks, [])
      assert.equal(f.steps.length, 3)
      assert.equal(f.proposal, null)
      assert.equal(f.flowProposal, null)
      assert.ok(existsSync(f.screenshot))
      assert.equal(f.trace, null, 'a done run keeps no Playwright trace')
    } finally { stub.restore() }
  }))

test('a task with checks is graded like a prompt-mode test', () =>
  withApp(async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    try {
      const f = (await task(root, taskFor(port, { checks: CHECKS }))).flows[0]
      assert.equal(f.outcome, 'pass')
      assert.ok(f.proposal && f.flowProposal)
    } finally { stub.restore() }
  }))

/** Reads the dashboard like its page does: the token from the HTML, then the event stream. */
async function dashboard(port) {
  const base = `http://127.0.0.1:${port}`
  for (let i = 0; ; i++) {
    try {
      const html = await (await fetch(`${base}/`)).text()
      const token = /name="pilot-token" content="([^"]+)"/.exec(html)[1]
      const states = [], raw = []
      const res = await fetch(`${base}/api/events?t=${token}`)
      const reader = res.body.getReader()
      const dec = new TextDecoder()
      let buf = ''
      const ctl = action => fetch(`${base}/api/control`, { method: 'POST', headers: { 'x-pilot-token': token, 'content-type': 'application/json' }, body: JSON.stringify({ action }) })
      const pump = (async () => {
        for (;;) {
          const { value, done } = await reader.read().catch(() => ({ done: true }))
          if (done) return
          buf += dec.decode(value, { stream: true })
          let k
          while ((k = buf.indexOf('\n\n')) >= 0) {
            const chunk = buf.slice(0, k)
            buf = buf.slice(k + 2)
            if (!chunk.startsWith('data: ')) continue
            raw.push(chunk)
            states.push(JSON.parse(chunk.slice(6)))
            await onState?.(states.at(-1), ctl)
          }
        }
      })()
      let onState
      return { token, states, raw, ctl, pump, on: f => (onState = f) }
    } catch (e) {
      if (i > 100) throw e
      await new Promise(r => setTimeout(r, 50))
    }
  }
}

test('inspector, step by step: Choose next asks Jev, Execute runs the choice, nothing runs while held', () =>
  withApp(async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    const iport = await freePort()
    try {
      const run = task(root, taskFor(port), '--inspect-pause', '--inspect-port', String(iport))
      const d = await dashboard(iport)
      let jevAtHold = -1
      d.on(async (s, ctl) => {
        if (s.status === 'paused') await ctl('choose')
        if (s.status === 'held') {
          // Held after the decision: Jev has answered, the action has not run yet.
          jevAtHold = stub.requests.length
          assert.equal(s.history.length, s.step - 1)
          await ctl('execute')
        }
      })
      const r = await run
      const f = r.flows[0]
      assert.equal(f.outcome, 'done')
      assert.equal(f.steps.length, 3)
      assert.equal(jevAtHold, 4, 'held again on the final DONE decision')
      const last = d.states.at(-1)
      assert.equal(last.status, 'ended')
      // Three actions, then the DONE that ended the run as its own row.
      assert.equal(last.history.filter(r => !r.end).length, 3)
      assert.deepEqual(last.history.at(-1).action, 'DONE')
      assert.ok(d.states.some(s => s.decision?.operations && s.decision.elements?.length), 'decisions carry both probability heads')
      assert.ok(d.states.some(s => s.screenshot), 'a connected dashboard gets screenshots')
      assert.ok(last.pausedMs >= 0)
    } finally { stub.restore() }
  }))

test('inspector streams no secret fixture value and no screenshot when the task types a secret; Stop ends the run', () =>
  withApp(async ({ root, port }) => {
    const stub = stubJev(coffeePolicy())
    const iport = await freePort()
    try {
      const run = task(root, taskFor(port, { fixtures: { email: '$env:E2E_EMAIL' } }), '--inspect-pause', '--inspect-port', String(iport))
      const d = await dashboard(iport)
      d.on(async (s, ctl) => {
        if (s.status === 'paused') await ctl(s.step >= 3 ? 'stop' : 'choose')
        if (s.status === 'held') await ctl('execute')
      })
      const f = (await run).flows[0]
      assert.equal(f.outcome, 'blocked')
      assert.equal(f.error, 'stopped from the dashboard')
      assert.equal(d.raw.some(x => x.includes(SECRET)), false, 'a secret reached the dashboard')
      assert.equal(d.states.some(s => s.screenshot), false)
      assert.equal(d.states.at(-1).screenshots, false)
    } finally { stub.restore() }
  }))

test('inspector refuses other hosts, a missing token and a foreign origin', async () => {
  const port = await freePort()
  const ins = await createInspector({ port })
  try {
    const html = await (await fetch(ins.url)).text()
    const token = /content="([^"]+)"/.exec(html.split('pilot-token')[1])[1]
    const post = headers => fetch(`${ins.url}api/control`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: '{"action":"pause"}' })
    assert.equal((await post({})).status, 403)
    assert.equal((await post({ 'x-pilot-token': token, origin: 'http://evil.test' })).status, 403)
    assert.equal((await post({ 'x-pilot-token': token })).status, 200)
    assert.equal(ins.state.mode, 'pause')
    assert.equal((await fetch(`${ins.url}api/events?t=wrong`)).status, 403)
    // DNS rebinding: the same server reached under another host name.
    assert.equal((await fetch(`http://localhost:${port}/`)).status, 403)
  } finally {
    await ins.close()
  }
})

test('inspector falls back to a free port when its port is taken', async () => {
  const a = await createInspector({ port: await freePort() })
  const b = await createInspector({ port: Number(new URL(a.url).port) })
  try {
    assert.notEqual(a.url, b.url)
  } finally {
    await a.close()
    await b.close()
  }
})

test('a control cut by the bottom edge is offered (booking forms below the fold); a control fully below is not', async () => {
  const { createRequire } = await import('node:module')
  const { DEMO } = await import('./testkit.mjs')
  const { observe } = await import('./snapshot.mjs')
  const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
  const b = await chromium.launch()
  try {
    const page = await b.newPage({ viewport: { width: 800, height: 600 } })
    await page.setContent('<div style="height:560px"></div><button style="height:72px">Choose origin</button><div style="height:400px"></div><button>Far below</button>')
    const names = (await observe(page)).actions.map(a => a.name)
    assert.ok(names.includes('Choose origin'), names.join(','))
    assert.equal(names.includes('Far below'), false)
  } finally {
    await b.close()
  }
})

test('typing the same fixture into the same field is offered at most twice, then Jev must do something else', () =>
  withApp(async ({ root, port }) => {
    const offered = []
    const stub = stubJev(({ state, questions }) => {
      if (!state.page.url.includes('checkout')) return { op: 'CLICK', label: 'Buy coffee beans' }
      offered.push(Boolean(questions.operation.criteria.TYPE_TEXT))
      return questions.operation.criteria.TYPE_TEXT ? { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' } : { op: 'BLOCKED' }
    })
    try {
      const f = (await task(root, taskFor(port))).flows[0]
      assert.equal(f.steps.filter(s => s.op === 'fill').length, 2)
      assert.deepEqual(offered, [true, true, false])
      assert.equal(f.outcome, 'blocked')
    } finally { stub.restore() }
  }))

test('an invalid Jev answer is asked once more instead of ending the run', () =>
  withApp(async ({ root, port }) => {
    let n = 0
    const policy = coffeePolicy()
    const stub = stubJev(body => (++n === 2 ? { raw: { operation: { type: 'choice', choice: 'NOPE', probabilities: {} } } } : policy(body)))
    try {
      const f = (await task(root, taskFor(port))).flows[0]
      assert.equal(f.outcome, 'done')
      assert.equal(f.jevCalls, 5, 'one extra call for the retried decision')
    } finally { stub.restore() }
  }))

test('a page with nothing to act on yet (a dialog still sliding in) is looked at again before Jev is asked', async () => {
  const { createRequire } = await import('node:module')
  const { DEMO } = await import('./testkit.mjs')
  const { pilot } = await import('./record.mjs')
  const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
  const b = await chromium.launch()
  const seen = []
  const stub = stubJev(({ state }) => {
    seen.push(state.elements.map(e => e.label))
    return state.elements.length ? { op: 'DONE' } : { op: 'BLOCKED' }
  })
  try {
    const page = await b.newPage()
    await page.setContent('<script>setTimeout(() => document.body.insertAdjacentHTML("beforeend", "<button>Reject all</button>"), 600)</script>')
    const { createJev } = await import('./jev.mjs')
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'Dismiss the banner.', budget: { steps: 5 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 10000 })
    assert.equal(r.end, 'done')
    assert.deepEqual(seen, [['Reject all']])
  } finally {
    stub.restore()
    await b.close()
  }
})

test('a plain div with a pointer cursor (an airport suggestion) is offered as role clickable; its wrapper and inner tags are not', async () => {
  const { createRequire } = await import('node:module')
  const { DEMO } = await import('./testkit.mjs')
  const { observe } = await import('./snapshot.mjs')
  const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
  const b = await chromium.launch()
  try {
    const page = await b.newPage()
    await page.setContent(`<div class="list"><div class="row" style="cursor:pointer" onclick="this.textContent='picked'"><b style="cursor:pointer">Tp. Hồ Chí Minh</b> <span style="cursor:pointer">SGN</span></div></div>
      <div style="cursor:pointer"><button>Real button</button></div><div>plain text</div>`)
    const clickables = (await observe(page)).actions.filter(a => a.role === 'clickable')
    assert.deepEqual(clickables.map(a => a.name), ['Tp. Hồ Chí Minh SGN'])
  } finally {
    await b.close()
  }
})

test('the same click three times in a row is not offered a fourth time', () =>
  withApp(async ({ root, port }) => {
    const offered = []
    const stub = stubJev(({ questions }) => {
      const targets = Object.values(questions.click_target?.criteria ?? {}).map(c => c.element)
      offered.push(targets.some(t => /\] Demo Shop( \(in .*\))?$/.test(t)))
      return targets.some(t => /\] Demo Shop( \(in .*\))?$/.test(t)) ? { op: 'CLICK', label: 'Demo Shop' } : { op: 'BLOCKED' }
    })
    try {
      const f = (await task(root, taskFor(port))).flows[0]
      assert.equal(f.steps.length, 3)
      assert.deepEqual(offered, [true, true, true, false])
    } finally { stub.restore() }
  }))

test('a click that opens a new tab moves the run into that tab; the final screenshot and checks use it', () =>
  withApp(async ({ root, port }) => {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    writeFileSync(join(root, 'src', 'popup.html'), '<a href="/checkout.html?item=coffee" target="_blank">Open results</a>')
    const stub = stubJev(({ state }) => (state.page.url.includes('checkout') ? { op: 'DONE' } : { op: 'CLICK', label: 'Open results' }))
    try {
      const f = (await task(root, taskFor(port, { url: `http://localhost:${port}/popup.html`, checks: [{ testid: 'total', text: '€12.00' }] }))).flows[0]
      assert.equal(f.outcome, 'pass', JSON.stringify(f))
      assert.equal(f.steps.length, 1)
    } finally { stub.restore() }
  }))

test('a segmented control styled only by class reports its active option; aria-pressed and aria-current are read too', async () => {
  const { createRequire } = await import('node:module')
  const { DEMO } = await import('./testkit.mjs')
  const { observe } = await import('./snapshot.mjs')
  const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
  const b = await chromium.launch()
  try {
    const page = await b.newPage()
    await page.setContent(`<button class="_item_x1 _active_x9">Round trip</button><button class="_item_x1">One way</button>
      <button class="inactive">Multi city</button><button aria-pressed="true">Bold</button><a href="#" aria-current="page">Home</a>`)
    const by = Object.fromEntries((await observe(page)).actions.map(a => [a.name, a]))
    assert.equal(by['Round trip'].selected, 'true')
    assert.equal(by['One way'].selected, undefined)
    assert.equal(by['Multi city'].selected, undefined)
    assert.equal(by.Bold.pressed, 'true')
    assert.equal(by.Home.current, 'page')
  } finally {
    await b.close()
  }
})

test('a page that stays empty while it loads is observed again before Jev is asked', () =>
  withApp(async ({ root, port }) => {
    const { writeFileSync } = await import('node:fs')
    const { join } = await import('node:path')
    // Empty past settleStart's 3 s cap, like a booking engine's app after a search.
    writeFileSync(join(root, 'src', 'slow.html'), `<div id="r"></div><script>setTimeout(() => document.getElementById('r').innerHTML = '<button>Select flight</button>', 6500)</script>`)
    const seen = []
    const stub = stubJev(({ questions }) => {
      seen.push(Object.values(questions.click_target?.criteria ?? {}).map(c => c.element))
      return { op: 'BLOCKED' }
    })
    try {
      await task(root, taskFor(port, { url: `http://localhost:${port}/slow.html`, goal: 'Select a flight.', fixtures: {} }))
      assert.ok(seen[0].some(t => t.includes('] Select flight')), JSON.stringify(seen))
    } finally { stub.restore() }
  }))
