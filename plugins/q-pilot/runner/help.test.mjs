// Help requests: the pilot loop hands the run to Claude (through files in the run dir) where Jev is stuck, and goes
// on with Claude's answer. An "answerer" here plays the mod: it waits for help-<n>.json and writes the answer.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pilot } from './record.mjs'
import { createJev } from './jev.mjs'
import { createHelper, parseAnswer } from './help.mjs'
import { main } from './pilot.mjs'
import { coffeePolicy, DEMO, ENV, makeApp, stubJev } from './testkit.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

/** Answers help requests in `dir` with `answers[n-1]` (a function of the request, or an object). Returns the requests seen. */
function answerer(dir, answers) {
  const seen = []
  let stop = false
  const loop = (async () => {
    for (let n = 1; !stop && n <= answers.length; ) {
      const file = join(dir(), `help-${n}.json`)
      if (dir() && existsSync(file)) {
        const req = JSON.parse(readFileSync(file, 'utf8'))
        seen.push(req)
        const a = answers[n - 1]
        writeFileSync(join(dir(), `help-${n}.answer.json`), JSON.stringify(typeof a === 'function' ? a(req) : a))
        n++
      } else await new Promise(r => setTimeout(r, 20))
    }
  })()
  return { seen, done: () => ((stop = true), loop) }
}

const CYCLE = `<div id=form><input aria-label="Where"><button id=s>Search</button></div><div id=res hidden>Results <a href="#" id=back>Back</a></div>
<script>
  s.onclick = () => { form.hidden = true; res.hidden = false }
  back.onclick = e => { e.preventDefault(); form.hidden = false; res.hidden = true; document.querySelector('input').value = '' }
</script>`
const cyclePolicy = ({ state }) => {
  if (state.elements.some(e => e.label === 'Back')) return { op: 'CLICK', label: 'Back' }
  const where = state.elements.find(e => e.label === 'Where')
  return where?.value ? { op: 'CLICK', label: 'Search' } : { op: 'TYPE_TEXT', label: 'Where', fixture: 'to' }
}

test('parseAnswer accepts the documented shape and refuses anything else', () => {
  assert.deepEqual(parseAnswer('{"actions":[{"op":"click","index":2}],"then":"resume"}'), { actions: [{ op: 'click', index: 2 }], then: 'resume', note: undefined })
  assert.equal(parseAnswer('{}').then, 'observe')
  for (const bad of ['nope', '{"then":"maybe"}', '{"actions":[{"op":"hover","index":1}]}', '{"actions":[{"op":"click"}]}', '{"actions":[{"op":"fill","index":1}]}', '{"actions":[{"op":"press","key":"F5"}]}']) {
    assert.ok('error' in parseAnswer(bad), bad)
  }
})

test('a loop is handed to Claude with the elements and a screenshot; Claude fixes the field and hands back, then confirms DONE', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-pilot-help-'))
  const page = await browser.newPage()
  let calls = 0
  const stub = stubJev(s => (++calls > 6 ? { op: 'DONE' } : cyclePolicy(s)))
  const answers = answerer(() => dir, [
    req => {
      const where = req.elements.find(e => e.name === 'Where')
      return { actions: [{ op: 'fill', index: where.index, text: 'Da Nang (DAD)' }], then: 'resume' }
    },
    { actions: [], then: 'done' },
  ])
  try {
    await page.setContent(CYCLE)
    const helper = createHelper({ runDir: dir, runId: 'r1', fixtureKeys: ['to'], confirmDone: true, log: () => {} })
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 30 } }, fixtures: { to: 'Da Nang' }, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, helper })
    await answers.done()
    const [loop, confirm] = answers.seen
    assert.equal(loop.reason, 'loop')
    assert.match(loop.info.why, /fill textbox "Where" → click button "Search" → click link "Back"/)
    assert.ok(loop.elements.some(e => e.name === 'Where' && e.ops.includes('fill')))
    assert.ok(existsSync(loop.screenshot), 'a screenshot goes with the request')
    assert.equal(confirm.reason, 'confirm_done')
    assert.equal(r.end, 'done')
    assert.equal(r.by, 'claude')
    const mine = r.steps.filter(s => s.by === 'claude')
    assert.deepEqual(mine.map(s => [s.op, s.name]), [['fill', 'Where']])
    assert.equal(helper.used(), 2)
  } finally {
    stub.restore()
    await page.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a bot wall asks for a person; Claude stops the run with a note', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-pilot-help-'))
  const page = await browser.newPage()
  const stub = stubJev(() => assert.fail('jev must not be asked on a bot wall'))
  const answers = answerer(() => dir, [{ then: 'stop', note: 'the user did not solve the CAPTCHA' }])
  try {
    await page.setContent('<button>Search</button><awswaf-captcha style="display:block;width:320px;height:400px"></awswaf-captcha>')
    const helper = createHelper({ runDir: dir, runId: 'r1', log: () => {} })
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 5 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, helper })
    await answers.done()
    assert.equal(answers.seen[0].reason, 'human_needed')
    assert.equal(answers.seen[0].info.wall, 'aws-waf')
    assert.ok(answers.seen[0].wait_ms > 240000, 'a person gets longer than Claude')
    assert.deepEqual([r.end, r.error], ['blocked', 'stopped by Claude: the user did not solve the CAPTCHA'])
  } finally {
    stub.restore()
    await page.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('observe keeps the turn with Claude: its action results come back in the next request, a bad index is reported', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-pilot-help-'))
  const page = await browser.newPage()
  const stub = stubJev(() => ({ op: 'BLOCKED' }))
  const answers = answerer(() => dir, [
    req => ({ actions: [{ op: 'click', index: req.elements.find(e => e.name === 'Search').index }, { op: 'click', index: 99 }], then: 'observe' }),
    { then: 'stop' },
  ])
  try {
    await page.setContent('<button onclick="this.textContent=\'Searched\'">Search</button>')
    const helper = createHelper({ runDir: dir, runId: 'r1', log: () => {} })
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 5 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, helper })
    await answers.done()
    assert.equal(answers.seen[0].reason, 'jev_blocked')
    const next = answers.seen[1]
    assert.equal(next.reason, 'observe')
    assert.deepEqual(next.info.results.map(x => x.ok), [true, false])
    assert.match(next.info.results[1].error, /no click on element 99/)
    assert.ok(next.elements.some(e => e.name === 'Searched'))
    assert.equal(r.end, 'blocked')
  } finally {
    stub.restore()
    await page.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no answer in time ends the run blocked and names the request', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'q-pilot-help-'))
  const page = await browser.newPage()
  const stub = stubJev(() => ({ op: 'BLOCKED' }))
  try {
    await page.setContent('<button>Search</button>')
    let waited = 0
    const helper = createHelper({ runDir: dir, runId: 'r1', waitMs: 300, onWait: ms => (waited += ms), log: () => {} })
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 5 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, helper })
    assert.deepEqual([r.end, r.error], ['blocked', 'no answer from Claude to help request (jev_blocked)'])
    assert.ok(waited >= 300, 'the wait is reported so deadlines move')
  } finally {
    stub.restore()
    await page.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('task --help: the runner announces the request on stderr, Claude confirms DONE, the result says so', async () => {
  const app = await makeApp()
  const stub = stubJev(coffeePolicy())
  const lines = []
  const err = console.error
  console.error = (...a) => lines.push(a.join(' '))
  const runs = join(app.root, '.q-pilot', 'runs')
  const dir = () => (existsSync(runs) ? readdirSync(runs).map(d => join(runs, d))[0] ?? '' : '')
  const answers = answerer(dir, [{ then: 'done' }])
  try {
    const spec = { name: 'coffee', url: `http://localhost:${app.port}/`, goal: 'Buy coffee and place the order.', fixtures: { email: 'buyer@example.test' } }
    const r = await main(['task', '--root', app.root, '--spec-json', JSON.stringify(spec), '--budget-ms', '60000', '--help'], ENV)
    await answers.done()
    const f = r.flows[0]
    assert.equal(f.outcome, 'done')
    assert.equal(f.doneBy, 'claude')
    assert.equal(f.helpRequests, 1)
    assert.equal(answers.seen[0].reason, 'confirm_done')
    const mark = lines.find(l => l.startsWith('[q-pilot] help '))
    assert.ok(mark, 'announced on stderr')
    assert.equal(JSON.parse(mark.slice('[q-pilot] help '.length)).n, 1)
  } finally {
    console.error = err
    stub.restore()
    app.cleanup()
  }
})

test('task --help with checks: a DONE with a red check goes to Claude as checks_red before the run ends', async () => {
  const app = await makeApp()
  const stub = stubJev(coffeePolicy())
  const err = console.error
  console.error = () => {}
  const runs = join(app.root, '.q-pilot', 'runs')
  const dir = () => (existsSync(runs) ? readdirSync(runs).map(d => join(runs, d))[0] ?? '' : '')
  const answers = answerer(dir, [{ then: 'stop', note: 'the total is wrong' }])
  try {
    const spec = { name: 'coffee', url: `http://localhost:${app.port}/`, goal: 'Buy coffee and place the order.', fixtures: { email: 'buyer@example.test' }, checks: [{ testid: 'total', text: '€99.00' }] }
    const r = await main(['task', '--root', app.root, '--spec-json', JSON.stringify(spec), '--budget-ms', '60000', '--help'], ENV)
    await answers.done()
    const req = answers.seen[0]
    assert.equal(req.reason, 'checks_red')
    assert.deepEqual(req.info.red.map(c => c.check), [{ testid: 'total', text: '€99.00' }])
    assert.equal(req.info.red[0].actual, '€12.00')
    const f = r.flows[0]
    assert.equal(f.outcome, 'blocked')
    assert.equal(f.error, 'stopped by Claude: the total is wrong')
  } finally {
    console.error = err
    stub.restore()
    app.cleanup()
  }
})
