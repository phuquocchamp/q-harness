import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { request } from 'node:http'
import { startFixture } from './inspector/fixture.mjs'

let fx
before(async () => {
  fx = await startFixture()
})
after(() => fx.close())

const get = (path, init) => fetch(`${fx.url.slice(0, -1)}${path}`, init)
const api = (path, s) => get(`${path}${path.includes('?') ? '&' : '?'}t=${fx.token}${s ? `&s=${encodeURIComponent(s)}` : ''}`)
const post = (path, body, token = fx.token) => get(path, { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': token }, body: JSON.stringify(body) })

test('serves the page assets with the token injected', async () => {
  const html = await (await get('/')).text()
  assert.match(html, new RegExp(`name="pilot-token" content="${fx.token}"`))
  assert.ok(!html.includes('__TOKEN__'))
  for (const [path, type] of [['/app.js', 'javascript'], ['/style.css', 'css'], ['/q-theme.css', 'css'], ['/icon.svg', 'svg']]) {
    const r = await get(path)
    assert.equal(r.status, 200)
    assert.match(r.headers.get('content-type'), new RegExp(type))
  }
})

test('the page is the dashboard, not the old two-column inspector', async () => {
  const html = await (await get('/')).text()
  assert.match(html, /<title>q-pilot Dashboard<\/title>/)
  assert.match(html, /<aside class="sidebar" id="sidebar"/)
  assert.match(html, /id="sessions"/)
  assert.match(html, /<span id="takeover-label">Take control<\/span>/)
  assert.match(html, /id="next"|id="choose"/)
  assert.match(html, /Jev decision/)
  assert.ok(!/Live Inspector/.test(html))
  const css = await (await get('/style.css')).text()
  assert.match(css, /height: var\(--q-header-h\)/)
  assert.match(css, /--q-interactive/)
  const js = await (await get('/app.js')).text()
  assert.match(js, /#s=/)
  assert.match(js, /addEventListener\('bye'/)
  assert.match(js, /action: 'control'|'control'/)
  assert.match(js, /modelCell/)
})

test('the page has a settings view with a theme switch applied before first paint', async () => {
  const html = await (await get('/')).text()
  assert.match(html, /id="settings-view"/)
  assert.match(html, /data-theme-opt="system"[^]*data-theme-opt="light"[^]*data-theme-opt="dark"/)
  assert.match(html, /id="config-rows"/)
  const head = html.slice(0, html.indexOf('</head>'))
  assert.match(head, /<script>[^]*localStorage[^]*dataset\.theme/)
  assert.ok(head.indexOf('dataset.theme') < head.indexOf('q-theme.css'))
  const js = await (await get('/app.js')).text()
  assert.match(js, /\/api\/config/)
  assert.match(js, /delete document\.documentElement\.dataset\.theme/)
})

test('/api/config lists rows, saves and resets, and refuses a bad scope', async () => {
  const get0 = await (await api('/api/config')).json()
  assert.equal(get0.ok, true)
  assert.ok(get0.files.project)
  const row = k => get0.settings.find(r => r.key === k)
  assert.equal(row('vision').source, 'project')
  assert.equal(row('cdpUrl').source, 'env')
  assert.deepEqual(row('helper').scopes, ['user'])
  for (const r of get0.settings) for (const k of ['key', 'help', 'kind', 'scopes', 'group', 'source', 'overridden']) assert.ok(k in r, k)
  const set = await post('/api/config', { op: 'set', key: 'vision', value: 'always', scope: 'local' })
  const a = await set.json()
  assert.equal(set.status, 200)
  assert.match(a.message, /saved vision=always to local/)
  assert.equal(a.settings.find(r => r.key === 'vision').source, 'local')
  assert.equal(a.settings.find(r => r.key === 'vision').overridden[0].scope, 'project')
  const reset = await (await post('/api/config', { op: 'unset', key: 'vision', scope: 'local' })).json()
  assert.equal(reset.settings.find(r => r.key === 'vision').source, 'project')
  assert.equal((await post('/api/config', { op: 'set', key: 'helper', value: 'opus', scope: 'project' })).status, 400)
  assert.equal((await post('/api/config', { op: 'set', key: 'vision', value: 'nope', scope: 'user' })).status, 400)
  assert.equal((await post('/api/config', { op: 'set', key: 'vision', value: 'off', scope: 'user' }, 'bad')).status, 403)
})

test('/api/config answers 503 without a mod', async () => {
  const off = await startFixture({ config: false })
  try {
    const r = await fetch(`${off.url}api/config?t=${off.token}`)
    assert.equal(r.status, 503)
    assert.match((await r.json()).error, /started by Claude Code/)
  } finally {
    await off.close()
  }
})

test('an ended history session has a frozen duration, honest effects and goal text', async () => {
  const list = await (await api('/api/sessions')).json()
  const sum = list.find(x => x.id === fx.ids['cheapest-flight'])
  assert.equal(sum.endedAt - sum.startedAt, 46_000)
  const state = await (await get(`/api/events?t=${fx.token}&s=${encodeURIComponent(sum.id)}`).then(async r => {
    const reader = r.body.getReader()
    let text = ''
    while (!/event: state/.test(text) || !/\n\n$/.test(text)) text += new TextDecoder().decode((await reader.read()).value)
    await reader.cancel()
    return { json: async () => JSON.parse(text.match(/event: state\ndata: (.*)\n\n/)[1]) }
  })).json()
  assert.equal(state.endedAt, null)
  assert.equal(state.goal, null)
  assert.equal(state.decision, null)
  assert.ok(state.history.every(r => r.pageChanged == null))
  const js = await (await get('/app.js')).text()
  assert.match(js, /summary|sessions\.find\(x => x\.id === selected\)\?\.endedAt/)
  assert.match(js, /state && state\.status !== 'ended'\) next\.endedAt/)
  assert.match(js, /r\.pageChanged == null \? \(state\.status === 'ended' \? \['wait', 'unknown'\]/)
  assert.match(js, /Goal not recorded for this run/)
  assert.match(js, /'Run ended'/)
})

test('rejects a wrong host and a wrong token', async () => {
  assert.equal((await get('/api/sessions?t=nope')).status, 403)
  const status = await new Promise(resolve => request({ host: '127.0.0.1', port: fx.port, path: `/api/sessions?t=${fx.token}`, headers: { host: 'evil.test' } }, r => (r.resume(), resolve(r.statusCode))).end())
  assert.equal(status, 403)
  assert.equal((await post('/api/control', { s: fx.ids.live, action: 'pause' }, 'nope')).status, 403)
})

test('lists sessions in the SessionSummary shape', async () => {
  const list = await (await api('/api/sessions')).json()
  assert.equal(list.length, 7)
  const kinds = new Set()
  for (const x of list) {
    assert.match(x.id, /^\d{8}-\d{6}-[0-9a-f]{4}:[a-z0-9-]+$/)
    assert.equal(x.id, `${x.runId}:${x.flowId}`)
    assert.ok(['task', 'test', 'gate', 'flow'].includes(x.kind))
    assert.ok(['chromium', 'chrome-cdp', 'electron'].includes(x.target.kind))
    assert.ok(['live', 'paused', 'helping', 'ended', 'incomplete'].includes(x.status))
    assert.equal(typeof x.name, 'string')
    assert.equal(typeof x.subline, 'string')
    assert.equal(typeof x.red, 'boolean')
    assert.equal(typeof x.secret, 'boolean')
    assert.equal(typeof x.startedAt, 'number')
    kinds.add(x.target.kind)
  }
  assert.equal(kinds.size, 3)
  assert.ok(list.some(x => x.kind === 'gate' && x.red))
  assert.ok(list.some(x => x.secret && x.status === 'ended'))
})

test('the event stream sends sessions, state and live events', async () => {
  const r = await api('/api/events', fx.ids.live)
  assert.match(r.headers.get('content-type'), /text\/event-stream/)
  const reader = r.body.getReader()
  const dec = new TextDecoder()
  let text = ''
  const until = Date.now() + 3000
  while (!/event: live/.test(text) && Date.now() < until) text += dec.decode((await reader.read()).value)
  await reader.cancel()
  const events = [...text.matchAll(/event: (\w+)\ndata: (.*)\n\n/g)].map(m => [m[1], JSON.parse(m[2])])
  const named = Object.fromEntries(events.map(([k, v]) => [k, v]))
  assert.ok(Array.isArray(named.sessions.sessions))
  assert.equal(named.sessions.project, 'q-harness')
  assert.equal(named.state.id, fx.ids.live)
  assert.equal(named.state.live.mode, 'screencast')
  assert.equal(named.state.screenshot, null)
  assert.equal(named.live.s, fx.ids.live)
  assert.equal(typeof named.live.jpeg, 'string')
})

test('frames carry the screenshot, gate sessions refuse controls', async () => {
  const frame = await (await api('/api/frame?i=1', fx.ids.live)).json()
  assert.equal(frame.i, 1)
  assert.ok(frame.screenshot)
  assert.equal((await api('/api/frame?i=1', fx.ids['sign-in-secret'])).status, 200)
  const secret = await (await api('/api/frame?i=1', fx.ids['sign-in-secret'])).json()
  assert.equal(secret.screenshot, null)
  for (const action of ['pause', 'stop', 'control']) assert.equal((await post('/api/control', { s: fx.ids.login, action })).status, 409)
  assert.equal((await post('/api/control', { s: fx.ids.login, action: 'trace' })).status, 200)
  assert.equal((await post('/api/input', { s: fx.ids.login, ev: { type: 'click', x: 0.5, y: 0.5 } })).status, 409)
})

test('take control opens input for a task, never for a secret run', async () => {
  assert.equal((await post('/api/input', { s: fx.ids.live, ev: { type: 'click', x: 0.5, y: 0.5 } })).status, 409)
  assert.equal((await post('/api/control', { s: fx.ids.live, action: 'control' })).status, 200)
  assert.equal((await post('/api/input', { s: fx.ids.live, ev: { type: 'text', text: 'abc' } })).status, 200)
  assert.equal(fx.inputs.length, 1)
  assert.equal((await post('/api/input', { s: fx.ids['sign-in-secret'], ev: { type: 'click', x: 0, y: 0 } })).status, 409)
})

test('ask is refused after an ended secret run', async () => {
  assert.equal((await post('/api/ask', { s: fx.ids['sign-in-secret'], question: 'why?', model: 'sonnet' })).status, 409)
  assert.equal((await post('/api/ask', { s: fx.ids.checkout, question: 'why?', model: 'sonnet' })).status, 200)
})

test('the page is English only', () => {
  const diacritics = /[ăâđêôơưĂÂĐÊÔƠƯàáảãạằắẳẵặầấẩẫậèéẻẽẹềếểễệìíỉĩịòóỏõọồốổỗộờớởỡợùúủũụừứửữựỳýỷỹỵ]/
  for (const f of ['index.html', 'app.js', 'style.css', 'fixture.mjs']) assert.ok(!diacritics.test(readFileSync(new URL(`./inspector/${f}`, import.meta.url), 'utf8')), f)
})
