import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { DEMO, stubJev } from './testkit.mjs'
import { datePattern, formatDate, formsOf, isIsoDate, variantsOf } from './typed.mjs'
import { resolveFixtures, validateTask } from './flow.mjs'
import { chooseAction, createJev } from './jev.mjs'
import { observe } from './snapshot.mjs'
import { perform, trackNetwork } from './act.mjs'

test('datePattern reads a native date input, a placeholder or a label; formatDate writes the ISO value in it', () => {
  assert.equal(datePattern({ type: 'date' }), 'iso')
  assert.equal(datePattern({ placeholder: 'DD/MM/YYYY' }), 'DD/MM/YYYY')
  assert.equal(datePattern({ placeholder: 'Search', label: 'Departure (mm-dd-yyyy)' }), 'MM-DD-YYYY')
  assert.equal(datePattern({ placeholder: 'yyyy.mm.dd' }), 'YYYY.MM.DD')
  assert.equal(datePattern({ placeholder: 'When?' }), null)
  assert.equal(formatDate('2026-10-20', 'DD/MM/YYYY'), '20/10/2026')
  assert.equal(formatDate('2026-10-20', 'MM-DD-YY'), '10-20-26')
  assert.equal(formatDate('2026-10-20', 'iso'), '2026-10-20')
  assert.equal(formatDate('2026-10-20', null), '2026-10-20')
})

test('isIsoDate rejects dates that are not on the calendar', () => {
  assert.equal(isIsoDate('2026-10-20'), true)
  assert.equal(isIsoDate('2026-02-30'), false)
  assert.equal(isIsoDate('20/10/2026'), false)
})

test('variantsOf lists the value, its date formats and its aliases; formsOf keeps only typed fixtures', () => {
  assert.deepEqual(variantsOf('Da Nang', { aliases: ['DAD'] }), ['Da Nang', 'DAD'])
  const dates = variantsOf('2026-10-20', { type: 'date' })
  for (const d of ['20/10/2026', '10/20/2026', 'October 20, 2026', '20 Oct 2026']) assert.ok(dates.includes(d), d)
  assert.deepEqual(variantsOf('x', undefined), ['x'])
  assert.deepEqual(formsOf({ q: 'plain', to: { value: 'Da Nang', aliases: ['DAD'] }, d: { value: '2026-10-20', type: 'date' } }), { to: { aliases: ['DAD'] }, d: { type: 'date' } })
})

test('a typed fixture is validated, and resolves to its value plus its form; a secret stays a plain string', () => {
  const ok = validateTask({ url: 'https://example.com/', goal: 'g', fixtures: { to: { value: 'Da Nang', aliases: ['DAD'] }, date: { value: '2026-10-20', type: 'date' }, pw: '$env:E2E_PW' } }, null, {})
  const r = resolveFixtures(ok, { E2E_PW: 's3cret' })
  assert.deepEqual(r.values, { to: 'Da Nang', date: '2026-10-20', pw: 's3cret' })
  assert.deepEqual(r.forms, { to: { aliases: ['DAD'] }, date: { type: 'date' } })
  assert.deepEqual(r.secrets, ['s3cret'])
  const bad = fixtures => assert.throws(() => validateTask({ url: 'https://example.com/', goal: 'g', fixtures }, null, {}))
  bad({ d: { value: '20/10/2026', type: 'date' } })
  bad({ d: { value: '2026-10-20', type: 'time' } })
  bad({ d: { value: '$env:E2E_PW' } })
  bad({ d: { value: 'x', aliases: ['a', 'b', 'c', 'd', 'e', 'f'] } })
  bad({ d: { value: 'x', extra: 1 } })
  bad({ d: { value: '' } })
})

test('a field holding a typed fixture in another form is reported as holding it', async () => {
  const stub = stubJev(() => ({ op: 'CLICK' }))
  try {
    const snap = {
      url: 'http://x/', title: 'T', text: '',
      actions: [
        { id: 'e1', node: 1, kind: 'fill', role: 'textbox', name: 'Departure', label: 'Departure', value: '20/10/2026' },
        { id: 'e2', node: 2, kind: 'fill', role: 'combobox', name: 'To', label: 'To', value: 'Danang (DAD)' },
        { id: 'e3', node: 3, kind: 'fill', role: 'combobox', name: 'From', label: 'From', value: 'Dadu' },
        { id: 'e4', node: 4, kind: 'click', role: 'button', name: 'Search', label: 'Search', value: '' },
      ],
    }
    const fixtures = { date: '2026-10-20', to: 'Da Nang', from: 'Hanoi' }
    const forms = { date: { type: 'date' }, to: { aliases: ['DAD'] }, from: { aliases: ['HAN'] } }
    await chooseAction(createJev({ apiKey: 'k' }), { goal: 'g', snap, history: [], fixtureKeys: Object.keys(fixtures), fixtures, forms, secrets: [] })
    const [date, to, from] = stub.requests[0].body.state.elements
    assert.equal(date.holds_fixture, 'date')
    assert.equal(to.holds_fixture, 'to')
    // An alias counts as a whole word ("DAD" in "Danang (DAD)"), never as part of one.
    assert.equal(from.holds_fixture, undefined)
  } finally { stub.restore() }
})

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser

before(async () => { browser = await chromium.launch() })
after(async () => { await browser?.close() })

async function flights() {
  const page = await (await browser.newContext()).newPage()
  trackNetwork(page)
  await page.setContent(readFileSync(`${DEMO}/src/flights.html`, 'utf8'))
  return page
}
const field = async (page, name) => (await observe(page)).actions.find(a => a.kind === 'fill' && a.name === name)

test('a date fixture is typed in the format the field asks for', async () => {
  const page = await flights()
  const r = await perform(page, await field(page, 'Departure date'), '2026-10-20', { type: 'date' })
  assert.equal(r.typed, '20/10/2026')
  assert.equal(await page.inputValue('#date'), '20/10/2026')
})

test('an autocomplete with no suggestion for the value gets the aliases in turn; a list left open elsewhere does not count', async () => {
  const page = await flights()
  // The From list stays open: its option must not pass for a suggestion of the To field.
  await perform(page, await field(page, 'From'), 'Hanoi')
  const r = await perform(page, await field(page, 'To'), 'Da Nang', { aliases: ['Danang', 'DAD'] })
  assert.deepEqual([r.typed, r.suggested], ['Danang', true])
  assert.equal(await page.inputValue('#to'), 'Danang')
})

test('without aliases, an unmatched value stays as typed and is not a suggestion', async () => {
  const page = await flights()
  const r = await perform(page, await field(page, 'To'), 'Da Nang')
  assert.deepEqual([r.typed, r.suggested], ['Da Nang', false])
})
