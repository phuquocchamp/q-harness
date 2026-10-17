import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { createRequire } from 'node:module'
import { DEMO } from './testkit.mjs'
import { observe } from './snapshot.mjs'
import { perform, trackNetwork } from './act.mjs'

const { chromium } = createRequire(`${DEMO}/package.json`)('playwright')
let browser, server, base

before(async () => {
  // `/b?d=<ms>` answers after a delay, like a slow remote page.
  server = createServer((req, res) => {
    const d = Number(new URL(req.url, 'http://x').searchParams.get('d') ?? 0)
    setTimeout(() => {
      res.setHeader('content-type', 'text/html; charset=utf-8')
      res.end(req.url.startsWith('/b') ? '<h1>Page B</h1>' : `<h1>Page A</h1><a href="/b?d=${new URL(req.url, 'http://x').searchParams.get('next') ?? 0}">Next</a>`)
    }, d)
  })
  await new Promise(r => server.listen(0, '127.0.0.1', r))
  base = `http://127.0.0.1:${server.address().port}`
  browser = await chromium.launch()
})

after(async () => {
  await browser?.close()
  server?.close()
})

async function clickNext(delayMs) {
  const page = await (await browser.newContext()).newPage()
  trackNetwork(page)
  await page.goto(`${base}/?next=${delayMs}`)
  const next = (await observe(page)).actions.find(a => a.name === 'Next')
  await perform(page, next)
  return page
}

test('perform returns on the new page after a fast navigation', async () => {
  const page = await clickNext(0)
  assert.match(page.url(), /\/b\?d=0$/)
  assert.equal(await page.textContent('h1'), 'Page B')
})

test('a click whose page load outlasts the 2 s click timeout is not a failure, and perform waits for the load', async () => {
  const page = await clickNext(2500)
  assert.match(page.url(), /\/b\?d=2500$/)
  assert.equal(await page.textContent('h1'), 'Page B')
})
