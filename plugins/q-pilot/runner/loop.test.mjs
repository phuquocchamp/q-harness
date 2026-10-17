// The pilot loop's guards on real-site failure shapes: cycles, refills, stale ends, bot walls, typing that waits for
// a suggestion list, and the per-field fixture question.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pilot, findCycle } from './record.mjs'
import { perform, trackNetwork } from './act.mjs'
import { observe } from './snapshot.mjs'
import { chooseAction, createJev } from './jev.mjs'
import { DEMO, stubJev } from './testkit.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

const run = (page, over = {}) =>
  pilot(page, { flow: { id: 't', start: '/', goal: over.goal ?? 'g', budget: { steps: over.steps ?? 30 } }, fixtures: over.fixtures ?? {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, helper: over.helper ?? null })

test('findCycle names a repeated tail of two or more different actions, never one action repeated', () => {
  assert.deepEqual(findCycle(['a', 'b', 'c', 'a', 'b', 'c']), ['a', 'b', 'c'])
  assert.deepEqual(findCycle(['x', 'a', 'b', 'a', 'b']), ['a', 'b'])
  assert.equal(findCycle(['a', 'a', 'a', 'a']), null)
  assert.equal(findCycle(['a', 'b', 'c', 'a', 'b']), null)
})

// Traveloka's shape: type the destination, search (which shows results), go back to the form, again and again.
const CYCLE = `<div id=form><input aria-label="Where"><button id=s>Search</button></div><div id=res hidden>Results <a href="#" id=back>Back</a></div>
<script>
  s.onclick = () => { form.hidden = true; res.hidden = false }
  back.onclick = e => { e.preventDefault(); form.hidden = false; res.hidden = true; document.querySelector('input').value = '' }
</script>`

test('a fill → search → back cycle that changes the page every step ends as a loop, not at the step budget', async () => {
  const page = await browser.newPage()
  const stub = stubJev(({ state, questions }) => {
    if (state.elements.some(e => e.label === 'Back')) return { op: 'CLICK', label: 'Back' }
    const where = state.elements.find(e => e.label === 'Where')
    return where?.value ? { op: 'CLICK', label: 'Search' } : { op: 'TYPE_TEXT', label: 'Where', fixture: 'to' }
  })
  try {
    await page.setContent(CYCLE)
    const r = await run(page, { fixtures: { to: 'Da Nang' } })
    assert.equal(r.end, 'blocked')
    assert.match(r.error, /^loop: the same 3 actions ran twice in a row: fill textbox "Where" → click button "Search" → click link "Back"/)
    assert.equal(r.steps.length, 6)
  } finally {
    stub.restore()
    await page.close()
  }
})

test('one fixture typed twice into a field is refused the third time, even while other fixtures could still go there', async () => {
  const page = await browser.newPage()
  // Each input event changes the page, so the refill is never "idle": only the fill cap stops it.
  const stub = stubJev(({ questions }) => (questions.operation.criteria.TYPE_TEXT ? { op: 'TYPE_TEXT', label: 'Where', fixture: 'to' } : { op: 'BLOCKED' }))
  try {
    await page.setContent('<input aria-label="Where" oninput="n.textContent = +n.textContent + 1"><p id=n>0</p>')
    const r = await run(page, { fixtures: { from: 'Saigon', to: 'Da Nang', date: '20/10/2026' } })
    assert.equal(r.steps.filter(s => s.op === 'fill').length, 2)
    assert.ok(r.decisions.some(d => /"to" already typed into this field 2 times/.test(d.refused ?? '')))
    assert.equal(r.end, 'blocked')
  } finally {
    stub.restore()
    await page.close()
  }
})

test('a DONE decided on a page that changed before it was accepted is asked again (twice at most)', async () => {
  const page = await browser.newPage()
  const stub = stubJev(() => ({ op: 'DONE' }), { delayMs: 40 })
  try {
    // The text changes every 10 ms: every DONE is stale by the time it is checked.
    await page.setContent('<button>Ok</button><p id=t>0</p><script>setInterval(() => t.textContent = Date.now(), 10)</script>')
    const r = await run(page)
    assert.equal(r.end, 'done')
    assert.equal(r.decisions.filter(d => d.stale).length, 2)
    assert.equal(stub.requests.length, 3)
  } finally {
    stub.restore()
    await page.close()
  }
})

test('a CAPTCHA iframe is a bot wall: blocked with its name, without asking Jev', async () => {
  const page = await browser.newPage()
  const stub = stubJev(() => assert.fail('jev must not be asked on a bot wall'))
  try {
    await page.setContent('<button>Search</button><iframe src="https://geo.captcha-delivery.com/captcha/?x=1" width=400 height=400></iframe>')
    const r = await run(page)
    assert.equal(r.end, 'blocked')
    assert.match(r.error, /^bot wall \(datadome\)/)
    assert.equal((await observe(page)).wall, 'datadome')
    // A CAPTCHA drawn in the page (AWS WAF's custom element on Traveloka), and a hidden one that is no wall.
    await page.setContent('<button>Search</button><awswaf-captcha style="display:block;width:320px;height:400px"></awswaf-captcha>')
    assert.equal((await observe(page)).wall, 'aws-waf')
    await page.setContent('<button>Search</button><div class="g-captcha" style="width:320px;height:400px;display:none"></div>')
    assert.equal((await observe(page)).wall, null)
  } finally {
    stub.restore()
    await page.close()
  }
})

test('typing waits for a suggestion list made of plain divs, and a field nothing reacts to costs no wait', async () => {
  const page = await browser.newPage()
  try {
    await page.setContent(`<p>Popular: Hà Nội</p><input aria-label="Where" autocomplete="off" oninput="clearTimeout(window.t); window.t = setTimeout(() => sugg.innerHTML = '<div>Sân bay Da Nang DAD</div>', 400)"><div id=sugg></div><input aria-label="Email">`)
    let snap = await observe(page)
    const where = snap.actions.find(a => a.label === 'Where' && a.kind === 'fill')
    let t0 = Date.now()
    const r = await perform(page, where, 'Đà Nẵng')
    assert.equal(r.suggested, true)
    assert.ok((await observe(page)).text.includes('Sân bay Da Nang DAD'), 'the suggestion is in the next observation')
    snap = await observe(page)
    const email = snap.actions.find(a => a.label === 'Email' && a.kind === 'fill')
    t0 = Date.now()
    assert.equal((await perform(page, email, 'a@b.test')).suggested, false)
    assert.ok(Date.now() - t0 < 1000, `a field with no suggestions returns quickly (${Date.now() - t0} ms)`)
    assert.equal(await page.getByLabel('Email').inputValue(), 'a@b.test')
  } finally {
    await page.close()
  }
})

test('with several fixtures, the fixture is asked for the chosen field in a second request', async () => {
  const stub = stubJev(() => ({ op: 'TYPE_TEXT', label: 'To', fixture: 'to' }))
  try {
    const snap = {
      url: 'http://x/', title: 'T', text: '',
      actions: [
        { id: 'e1', node: 1, kind: 'fill', role: 'textbox', name: 'From', label: 'From', value: '' },
        { id: 'e2', node: 2, kind: 'fill', role: 'textbox', name: 'To', label: 'To', value: 'Bangkok (BKK)' },
      ],
    }
    const d = await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap, history: [], fixtureKeys: ['from', 'to'], fixtures: { from: 'Saigon', to: 'Da Nang' }, secrets: [] })
    assert.equal(stub.requests.length, 2)
    assert.equal(stub.requests[0].body.questions.fixture, undefined, 'not asked blind in the first request')
    assert.match(stub.requests[1].body.questions.fixture.instructions.field, /\[2\] To \(role textbox, current value "Bangkok \(BKK\)"\)/)
    assert.equal(d.fixture, 'to')
  } finally {
    stub.restore()
  }
})

test('a click waits for the data request it started, so the next look sees the loaded values, not placeholders', async () => {
  const page = await browser.newPage()
  try {
    trackNetwork(page)
    // Google Flights' date grid shape: placeholders until the prices arrive by fetch.
    await page.route('https://data.test/**', async r => {
      await new Promise(res => setTimeout(res, 700))
      await r.fulfill({ body: '₫847,181', headers: { 'access-control-allow-origin': '*' } })
    })
    await page.setContent(`<button onclick="fetch('https://data.test/p').then(r => r.text()).then(t => out.textContent = t)">Date grid</button><p id=out>0000</p>`)
    const snap = await observe(page)
    await perform(page, snap.actions.find(a => a.label === 'Date grid'))
    assert.equal(await page.locator('#out').textContent(), '₫847,181')
  } finally {
    await page.close()
  }
})

test('with checksMet, a run ends as done by checks once they are green, though Jev never chose DONE', async () => {
  const page = await browser.newPage()
  // Jev keeps clicking: the grid is finished after the first click, but it never says DONE.
  const stub = stubJev(() => ({ op: 'CLICK', label: 'Show total' }))
  try {
    await page.setContent('<button onclick="t.textContent = \'€12.00\'; n.textContent = +n.textContent + 1">Show total</button><p id=t></p><p id=n>0</p>')
    const checksMet = async p => (await p.locator('#t').textContent()) === '€12.00'
    const r = await pilot(page, { flow: { id: 't', start: '/', goal: 'g', budget: { steps: 10 } }, fixtures: {}, jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 20000, checksMet })
    assert.equal(r.end, 'done')
    assert.equal(r.by, 'checks')
    assert.equal(r.steps.length, 1)
  } finally {
    stub.restore()
    await page.close()
  }
})
