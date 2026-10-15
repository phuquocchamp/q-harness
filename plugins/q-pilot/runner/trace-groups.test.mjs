// Trace groups: every executed step is named in the Playwright trace by target and source, never by a typed value.
import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { pilot } from './record.mjs'
import { replay } from './replay.mjs'
import { createJev } from './jev.mjs'
import { DEMO, stubJev } from './testkit.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser
before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

const tracer = () => {
  const titles = []
  return { titles, group: async t => { titles.push(t) }, groupEnd: async () => { titles.push('end') } }
}
const SECRET = 'hunter2@x.test'
const PAGE = '<input aria-label="Email"><button onclick="document.body.insertAdjacentHTML(\'beforeend\', \'<p>Sent</p>\')">Send</button>'
const flow = { id: 't', start: '/', goal: 'g', budget: { steps: 6 } }

test('the Jev loop groups each step as "Step n · op role name · p · source" and DONE too, with no typed value', async () => {
  const page = await browser.newPage()
  const stub = stubJev(({ state }) => (state.page.text.includes('Sent') ? { op: 'DONE' } : state.elements.find(e => e.label === 'Email')?.value ? { op: 'CLICK', label: 'Send' } : { op: 'TYPE_TEXT', label: 'Email', fixture: 'email' }))
  const t = tracer()
  try {
    await page.setContent(PAGE)
    const r = await pilot(page, { flow, fixtures: { email: SECRET }, secrets: [SECRET], jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 10000, tracer: t })
    assert.equal(r.end, 'done')
    assert.equal(t.titles.length, 6)
    assert.match(t.titles[0], /^Step 1 · fill textbox "Email" · p \d\.\d\d · jev$/)
    assert.equal(t.titles[1], 'end')
    assert.match(t.titles[2], /^Step 2 · click button "Send" · p \d\.\d\d · jev$/)
    assert.match(t.titles[4], /^Step 3 · DONE · p \d\.\d\d · jev$/)
    assert.ok(!t.titles.join('\n').includes(SECRET))
  } finally {
    stub.restore()
    await page.close()
  }
})

test('replay groups steps as "replay" and a re-picked one as "healed p"; fill values never appear', async () => {
  const page = await browser.newPage()
  const t = tracer()
  const trace = { steps: [
    { op: 'fill', role: 'textbox', name: 'Email', fixture: 'email' },
    { op: 'click', role: 'button', name: 'Submit' },
  ] }
  const stub = stubJev(() => ({ op: 'CLICK', label: 'Send' }))
  try {
    await page.setContent(PAGE)
    const r = await replay(page, { flow, trace, fixtures: { email: SECRET }, secrets: [SECRET], jev: createJev({ apiKey: 'k' }), deadline: Date.now() + 10000, tracer: t })
    assert.equal(r.end, 'done')
    assert.equal(t.titles.length, 4)
    assert.equal(t.titles[0], 'Step 1 · fill textbox "Email" · replay')
    assert.match(t.titles[2], /^Step 2 · click button "Send" · healed p \d\.\d\d$/)
    assert.ok(!t.titles.join('\n').includes(SECRET))
  } finally {
    stub.restore()
    await page.close()
  }
})
