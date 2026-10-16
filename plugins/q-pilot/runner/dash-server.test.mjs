// The q-pilot Dashboard server against real loopback servers on free ports: the checks every request passes, a session's
// life from register to end, commands to the runner, Ask and Save through the mod's marks, and the descriptor.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { spawn, spawnSync } from 'node:child_process'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDash } from './dash-server.mjs'

const RUN = '20261016-101010-abcd'
const ID = `${RUN}:flow-a`
const GATE = `${RUN}:gate-flow`

/** A running dashboard on a temp root, a page `api` caller and a runner `rpc` caller; cleaned up after `fn`. */
async function withDash(opts, fn) {
  const root = mkdtempSync(join(tmpdir(), 'qp-dash-'))
  const logs = []
  const d = await startDash({ root, port: 0, log: l => logs.push(l), env: { Q_PILOT_HEADLESS: '1' }, ...opts })
  const call = (path, init, headers) => fetch(new URL(path, d.url), { ...init, headers: { 'content-type': 'application/json', ...headers, ...(init?.headers ?? {}) } })
  const api = (path, body, headers) => call(path, { method: 'POST', body: JSON.stringify(body) }, { 'x-pilot-token': d.pageToken, ...headers })
  const get = path => fetch(new URL(`${path}${path.includes('?') ? '&' : '?'}t=${d.pageToken}`, d.url))
  const rpc = (path, body, init = {}) => call(`/rpc/${path}`, { method: 'POST', body: typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body), ...init }, { 'x-q-runner': d.runnerToken, ...(init.headers ?? {}) })
  const register = async (extra = {}, id = ID) => {
    const runDir = join(root, '.q-pilot', 'runs', id.split(':')[0])
    mkdirSync(runDir, { recursive: true })
    return rpc('sessions', { id, kind: 'task', name: 'flow a', runDir, goal: 'Find flights', startedAt: Date.now(), target: { kind: 'chromium', label: 'Chromium 1.64' }, ...extra })
  }
  try {
    return await fn({ d, root, logs, call, api, get, rpc, register })
  } finally {
    await d.close()
    rmSync(root, { recursive: true, force: true })
  }
}

/** Reads a server-sent event stream: events() lists what arrived so far, until(pred) waits for a match. */
async function events(url) {
  const res = await fetch(url)
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const seen = []
  let buf = ''
  const waiters = []
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        for (let k; (k = buf.indexOf('\n\n')) >= 0; ) {
          const block = buf.slice(0, k)
          buf = buf.slice(k + 2)
          const ev = /^event: (.*)$/m.exec(block)?.[1]
          const data = /^data: (.*)$/m.exec(block)?.[1]
          if (data === undefined) continue
          const e = { event: ev ?? 'message', data: JSON.parse(data) }
          seen.push(e)
          for (const w of waiters.splice(0)) w()
        }
      }
    } catch {}
  })()
  return {
    seen,
    close: () => reader.cancel().catch(() => {}),
    async until(pred, ms = 3000) {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const hit = seen.find(pred)
        if (hit) return hit
        await new Promise(r => { waiters.push(r); setTimeout(r, 50) })
      }
      throw new Error(`no matching event; saw ${JSON.stringify(seen.map(e => e.event))}`)
    },
  }
}

/** The runner's command stream of a session; `next(type)` waits for a command of that type. */
async function commands(d, id) {
  const res = await fetch(new URL(`/rpc/sessions/${encodeURIComponent(id)}/commands`, d.url), { headers: { 'x-q-runner': d.runnerToken } })
  const reader = res.body.getReader()
  const dec = new TextDecoder()
  const got = []
  let buf = ''
  ;(async () => {
    try {
      for (;;) {
        const { value, done } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        for (let k; (k = buf.indexOf('\n\n')) >= 0; ) {
          got.push(JSON.parse(buf.slice(0, k).replace(/^data: /, '')))
          buf = buf.slice(k + 2)
        }
      }
    } catch {}
  })()
  return {
    got,
    close: () => reader.cancel().catch(() => {}),
    async next(type, ms = 3000) {
      for (const end = Date.now() + ms; Date.now() < end; ) {
        const c = got.find(x => x.type === type && !x.seen)
        if (c) return Object.assign(c, { seen: true })
        await new Promise(r => setTimeout(r, 20))
      }
      throw new Error(`no ${type} command`)
    },
  }
}

/** 413, or the connection cut while the oversized body was still going out (the server destroys it). */
const capped = p => p.then(r => r.status, e => (['EPIPE', 'ECONNRESET', 'UND_ERR_SOCKET'].includes(e.cause?.code) ? 413 : Promise.reject(e)))

const rawStatus = (d, path, headers, method = 'GET') =>
  new Promise((resolve, reject) => httpRequest(new URL(path, d.url), { method, headers }, r => (r.resume(), resolve(r.statusCode))).on('error', reject).end())

test('every request: Host, tokens (and their separation), Origin on POST and body caps are checked', () =>
  withDash({}, async ({ d, call, api, get, rpc, register }) => {
    assert.equal(await rawStatus(d, '/rpc/health', { host: 'evil.example', 'x-q-runner': d.runnerToken }), 403)
    assert.equal(await rawStatus(d, '/', { host: 'evil.example' }), 403)
    assert.equal((await call('/rpc/health')).status, 403, 'no runner token')
    assert.equal((await call('/rpc/health', {}, { 'x-q-runner': 'nope' })).status, 403)
    assert.equal((await call('/rpc/health', {}, { 'x-q-runner': d.pageToken })).status, 403, 'the page token is not a runner token')
    assert.equal((await call('/rpc/health', {}, { 'x-pilot-token': d.pageToken })).status, 403)
    assert.equal((await fetch(new URL(`/api/sessions?t=${d.runnerToken}`, d.url))).status, 403, 'the runner token is not a page token')
    assert.equal((await call('/api/sessions', {}, { 'x-q-runner': d.runnerToken })).status, 403)
    assert.equal((await fetch(new URL('/api/sessions?t=nope', d.url))).status, 403)
    assert.equal((await api('/api/control', { s: ID, action: 'run' }, { 'x-pilot-token': 'nope' })).status, 403)
    assert.equal((await api('/api/control', { s: ID, action: 'run' }, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await rpc('sessions', {}, { headers: { origin: 'http://evil.example' } })).status, 403)
    assert.equal((await get('/api/sessions')).status, 200)
    assert.equal((await (await call('/rpc/health', {}, { 'x-q-runner': d.runnerToken })).json()).ok, true)
    // Body caps: the declared length is refused before the body is read.
    assert.equal(await capped(rpc('sessions', 'x'.repeat(17 * 1024))), 413)
    assert.equal((await register()).status, 201)
    assert.equal(await capped(rpc(`sessions/${encodeURIComponent(ID)}/state`, Buffer.alloc(1024 * 1024 + 1, 97))), 413)
    assert.equal(await capped(api('/api/input', { s: ID, ev: { type: 'text', text: 'x'.repeat(5000) } })), 413)
    assert.equal(await capped(rpc(`sessions/${encodeURIComponent(ID)}/live`, Buffer.alloc(1024 * 1024 + 1, 1), { headers: { 'content-type': 'image/jpeg' } })), 413)
  }))

test('a session keeps its prompt group; a malformed one is dropped', () =>
  withDash({}, async ({ get, register }) => {
    assert.equal((await register({ open: false, group: 'pmgx1abcd' })).status, 201)
    assert.equal((await register({ open: false, group: 'no spaces' }, '20261016-101010-abcd:flow-b')).status, 201)
    const { sessions } = await (await get('/api/sessions')).json()
    assert.deepEqual(Object.fromEntries(sessions.map(x => [x.flowId, x.group])), { 'flow-a': 'pmgx1abcd', 'flow-b': null })
  }))

test('register, state, frames and end: the page sees the session, its frames and its end', () =>
  withDash({}, async ({ d, root, get, rpc, register }) => {
    const page = await events(`${d.url}api/events?t=${d.pageToken}&s=${encodeURIComponent(ID)}`)
    assert.deepEqual((await page.until(e => e.event === 'sessions')).data.sessions, [])
    const res = await register({ open: false })
    assert.equal(res.status, 201)
    assert.deepEqual(await res.json(), { id: ID, url: `${d.url}#s=${ID}` })
    assert.equal((await register()).status, 409, 'a live id is taken')
    assert.equal((await register({}, 'bad-id')).status, 400)
    assert.equal((await register({ runDir: '/etc' })).status, 400, 'the run dir must be under .q-pilot/runs')
    assert.equal((await register({ kind: 'weird' })).status, 400)
    const live = await page.until(e => e.event === 'sessions' && e.data.sessions[0]?.id === ID)
    assert.deepEqual([live.data.sessions[0].status, live.data.sessions[0].kind, live.data.sessions[0].source, live.data.sessions[0].secret, live.data.sessions[0].controls], ['live', 'task', 'live', false, true])
    assert.equal(live.data.sessions[0].group, null, 'no prompt group without one')

    const base = `sessions/${encodeURIComponent(ID)}`
    assert.equal((await rpc(`${base}/frames`, { i: 1, step: 1, url: 'http://x/1', title: 'T', view: { w: 8, h: 6 }, boxes: [], screenshot: 'anBlZw==', elements: [], decision: null })).status, 204)
    assert.equal((await rpc(`${base}/frames`, { i: 1, step: 1, url: 'http://x/1', title: 'T', view: null, boxes: [], screenshot: 'anBlZw==', elements: [{ index: '1' }], decision: { label: 'click x', p: 0.9 } })).status, 204)
    const state = { id: ID, status: 'observing', mode: 'run', name: 'flow a', goal: 'Find flights', startedAt: Date.now(), history: [{ step: 1, action: 'click x' }], frames: [{ i: 1, step: 1 }], screenshot: 'SHOULD-NOT-SURVIVE', files: {} }
    assert.equal((await rpc(`${base}/state`, state)).status, 204)
    const st = await page.until(e => e.event === 'state' && e.data.history?.length === 1)
    assert.equal(st.data.screenshot, null, 'no pixels in the state')
    assert.equal(st.data.ask.default, 'haiku')
    assert.equal(st.data.settings.canSave, true)
    const f = await (await get(`/api/frame?s=${encodeURIComponent(ID)}&i=1`)).json()
    assert.deepEqual([f.s, f.screenshot, f.decision.label, f.elements.length], [ID, 'anBlZw==', 'click x', 1], 're-posting a frame replaces it')
    assert.equal((await get(`/api/frame?s=${encodeURIComponent(ID)}&i=9`)).status, 404)

    const trace = join(root, '.q-pilot', 'runs', RUN, 'flow-a.trace.zip')
    writeFileSync(trace, 'PK')
    assert.equal((await rpc(`${base}/end`, { outcome: 'done', error: null, checks: [], files: { trace, decisions: '/etc/passwd' } })).status, 204)
    const ended = await page.until(e => e.event === 'sessions' && e.data.sessions[0]?.status === 'ended')
    assert.deepEqual([ended.data.sessions[0].outcome, ended.data.sessions[0].red, ended.data.sessions[0].controls], ['done', false, false])
    assert.equal(await (await get(`/api/file?s=${encodeURIComponent(ID)}&kind=trace`)).text(), 'PK')
    assert.equal((await get(`/api/file?s=${encodeURIComponent(ID)}&kind=decisions`)).status, 404, 'a path outside the run dir is dropped')
    assert.equal((await get(`/api/frame?s=${encodeURIComponent(ID)}&i=1`)).status, 200, 'an ended session keeps its frames')
    await page.close()
  }))

test('/api/file: only files inside the session run dir are served, never a secret run\'s screenshot', () =>
  withDash({}, async ({ d, root, get, rpc, register }) => {
    await register({ secret: true })
    const dir = join(root, '.q-pilot', 'runs', RUN)
    const shot = join(dir, 'flow-a.png')
    writeFileSync(shot, 'PNG')
    const other = join(root, 'outside.zip')
    writeFileSync(other, 'PK')
    const base = `sessions/${encodeURIComponent(ID)}`
    await rpc(`${base}/end`, { outcome: 'done', files: { screenshot: shot, trace: other } })
    assert.equal((await get(`/api/file?s=${encodeURIComponent(ID)}&kind=trace`)).status, 404)
    assert.equal((await get(`/api/file?s=${encodeURIComponent(ID)}&kind=screenshot`)).status, 404, 'secret run')
    assert.equal((await get(`/api/file?s=${encodeURIComponent(ID)}&kind=__proto__`)).status, 404)
    assert.ok(d)
  }))

test('control is forwarded to the runner and its reply completes the page request; 504 when it never answers', () =>
  withDash({ replyMs: 300 }, async ({ d, api, register }) => {
    await register()
    const cmds = await commands(d, ID)
    assert.deepEqual((await cmds.next('viewers')).n, 0)
    const pending = api('/api/control', { s: ID, action: 'pause' })
    const c = await cmds.next('control')
    assert.equal(c.action, 'pause')
    await fetch(new URL(`/rpc/sessions/${encodeURIComponent(ID)}/reply`, d.url), { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify({ cid: c.cid, ok: true }) })
    assert.equal((await pending).status, 200)
    // The runner refuses.
    const refused = api('/api/control', { s: ID, action: 'execute' })
    const c2 = await cmds.next('control')
    await fetch(new URL(`/rpc/sessions/${encodeURIComponent(ID)}/reply`, d.url), { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify({ cid: c2.cid, ok: false }) })
    assert.equal((await refused).status, 409)
    // Silence.
    assert.equal((await api('/api/control', { s: ID, action: 'run' })).status, 504)
    assert.equal((await api('/api/control', { s: ID, action: 'bogus' })).status, 400)
    await cmds.close()
  }))

test('viewers: the runner learns how many tabs have its session selected', () =>
  withDash({}, async ({ d, register }) => {
    await register()
    const cmds = await commands(d, ID)
    await cmds.next('viewers')
    const a = await events(`${d.url}api/events?t=${d.pageToken}&s=${encodeURIComponent(ID)}`)
    assert.equal((await cmds.next('viewers')).n, 1)
    const b = await events(`${d.url}api/events?t=${d.pageToken}&s=${encodeURIComponent(ID)}`)
    assert.equal((await cmds.next('viewers')).n, 2)
    await a.close()
    await b.close()
    assert.equal((await cmds.next('viewers')).n, 1)
    assert.equal((await cmds.next('viewers')).n, 0)
    await cmds.close()
  }))

test('live frames reach the selected tab only, and a session that types a secret takes none', () =>
  withDash({}, async ({ d, rpc, register }) => {
    await register()
    const SECRET = `${RUN}:flow-s`
    await register({ secret: true }, SECRET)
    const a = await events(`${d.url}api/events?t=${d.pageToken}&s=${encodeURIComponent(ID)}`)
    const b = await events(`${d.url}api/events?t=${d.pageToken}&s=${encodeURIComponent(SECRET)}`)
    const jpeg = { headers: { 'content-type': 'image/jpeg', 'x-q-w': '800', 'x-q-h': '600', 'x-q-ts': '1' } }
    assert.equal((await rpc(`sessions/${encodeURIComponent(ID)}/live`, Buffer.from('JPEG'), jpeg)).status, 204)
    assert.equal((await rpc(`sessions/${encodeURIComponent(SECRET)}/live`, Buffer.from('JPEG'), jpeg)).status, 204)
    const e = await a.until(x => x.event === 'live')
    assert.deepEqual([e.data.s, e.data.w, e.data.h, e.data.jpeg], [ID, 800, 600, Buffer.from('JPEG').toString('base64')])
    await new Promise(r => setTimeout(r, 150))
    assert.equal(b.seen.some(x => x.event === 'live'), false)
    await a.close()
    await b.close()
  }))

test('pause, stop and input are refused for gate and flow sessions; input needs a held, non-secret task', () =>
  withDash({ replyMs: 200 }, async ({ d, api, rpc, register }) => {
    await register({ kind: 'gate' }, GATE)
    for (const action of ['pause', 'stop', 'control']) assert.equal((await api('/api/control', { s: GATE, action })).status, 409, action)
    assert.equal((await api('/api/input', { s: GATE, ev: { type: 'key', key: 'Enter' } })).status, 409)
    await register()
    const base = `sessions/${encodeURIComponent(ID)}`
    // Running: no input.
    await rpc(`${base}/state`, { status: 'observing', history: [], frames: [] })
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'key', key: 'Enter' } })).status, 409)
    // Held: forwarded.
    await rpc(`${base}/state`, { status: 'paused', history: [], frames: [] })
    const cmds = await commands(d, ID)
    const pending = api('/api/input', { s: ID, ev: { type: 'click', x: 0.5, y: 0.5 } })
    const c = await cmds.next('input')
    assert.deepEqual(c.ev, { type: 'click', x: 0.5, y: 0.5 })
    await fetch(new URL(`/rpc/sessions/${encodeURIComponent(ID)}/reply`, d.url), { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify({ cid: c.cid, ok: true }) })
    assert.equal((await pending).status, 200)
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'teleport' } })).status, 400)
    // Secret: never.
    await rpc(`${base}/state`, { status: 'paused', secret: true, history: [], frames: [] })
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'key', key: 'Enter' } })).status, 409)
    await cmds.close()
  }))

test('Ask Claude writes the request, prints the mark and shows the runner-redacted answer; a secret run is asked only while live', async () => {
  const seen = []
  await withDash({ askTransport: async req => (seen.push(req), { text: `Use [1] with sk-123 (${req.model})` }) }, async ({ d, api, rpc, register, logs }) => {
    await register({ secret: true })
    const base = `sessions/${encodeURIComponent(ID)}`
    await rpc(`${base}/frames`, { i: 1, step: 1, url: 'http://x', title: 'T', view: null, boxes: [], screenshot: null, elements: [{ index: '1', role: 'button', label: 'Search', operations: ['CLICK'] }], decision: { label: 'click Search', p: 0.9 } })
    await rpc(`${base}/state`, { status: 'decided', goal: 'Find flights', history: [{ action: 'click x' }], frames: [] })
    const cmds = await commands(d, ID)
    const asked = api('/api/ask', { s: ID, question: 'What next?', model: 'sonnet', frame: 1 })
    const c = await cmds.next('redact')
    assert.equal(c.texts[0], 'Use [1] with sk-123 (sonnet)')
    await fetch(new URL(`/rpc/sessions/${encodeURIComponent(ID)}/reply`, d.url), { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify({ cid: c.cid, ok: true, value: ['Use [1] with [redacted] (sonnet)', ''] }) })
    const r = await (await asked).json()
    assert.equal(r.answer, 'Use [1] with [redacted] (sonnet)')
    assert.equal(r.model, 'claude-sonnet-5-5')
    assert.match(seen[0].prompt, /Goal: Find flights/)
    assert.match(seen[0].prompt, /Question: What next\?/)
    assert.equal((await api('/api/ask', { s: ID, question: '' })).status, 400)
    // Ended with a secret: off.
    await rpc(`${base}/end`, { outcome: 'done' })
    assert.equal((await api('/api/ask', { s: ID, question: 'again?' })).status, 409)
    await cmds.close()
    assert.ok(logs.length)
  })
})

test('Ask Claude through the mod: ask-1.json is written under the dashboard requests dir and the mark is logged', () =>
  withDash({}, async ({ d, root, api, register, logs }) => {
    await register()
    const asked = api('/api/ask', { s: ID, question: 'What now?', model: 'haiku' })
    const file = join(d.requestsDir, 'ask-1.json')
    for (let i = 0; i < 40 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 25))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).model, 'haiku')
    assert.ok(logs.some(l => l.startsWith('[q-pilot] ask {"n":1,"file":')))
    writeFileSync(join(d.requestsDir, 'ask-1.answer.json'), JSON.stringify({ text: 'Click it.' }))
    const r = await (await asked).json()
    assert.equal(r.answer, 'Click it.')
    assert.ok(d)
  }))

test('Ask Claude on an ended run without secrets asks directly, from the stored frame', async () => {
  const seen = []
  await withDash({ askTransport: async req => (seen.push(req), { text: 'ok' }) }, async ({ api, rpc, register }) => {
    await register()
    const base = `sessions/${encodeURIComponent(ID)}`
    await rpc(`${base}/frames`, { i: 1, step: 4, url: 'http://x/4', title: 'T', view: null, boxes: [], screenshot: null, elements: [], decision: null })
    await rpc(`${base}/end`, { outcome: 'done' })
    const r = await api('/api/ask', { s: ID, question: 'Why?', frame: 1 })
    assert.equal(r.status, 200)
    assert.match(seen[0].prompt, /Step 4 · http:\/\/x\/4/)
  })
})

test('Save as default writes settings-save-1.json, prints the mark, and the answer file sets the session save status', () =>
  withDash({}, async ({ d, root, api, rpc, register, logs }) => {
    await register()
    const post = body => api('/api/settings/save', { s: ID, ...body })
    assert.equal((await post({ keys: { vision: 'off' }, scope: 'cli' })).status, 400)
    assert.equal((await post({ keys: {}, scope: 'user' })).status, 400)
    assert.equal((await post({ keys: { node: 'node' }, scope: 'user' })).status, 400)
    assert.equal((await post({ keys: { vision: 'sometimes' }, scope: 'user' })).status, 400)
    assert.equal(logs.filter(l => l.includes('settings-save')).length, 0)
    const page = await events(`${d.url}api/events?t=${d.pageToken}&s=${encodeURIComponent(ID)}`)
    assert.equal((await post({ keys: { vision: 'always', box: true }, scope: 'project' })).status, 200)
    const dir = d.requestsDir
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'settings-save-1.json'), 'utf8')), { n: 1, keys: { vision: 'always', box: true }, scope: 'project' })
    assert.match(logs.find(l => l.includes('settings-save')), /^\[q-pilot\] settings-save \{"n":1,"file":".*settings-save-1\.json"\}$/)
    assert.equal((await page.until(e => e.event === 'state' && e.data.settings?.save?.status === 'pending')).data.settings.save.scope, 'project')
    writeFileSync(join(dir, 'settings-save-1.answer.json'), JSON.stringify({ ok: true, message: 'saved to project' }))
    const saved = await page.until(e => e.event === 'state' && e.data.settings?.save?.status === 'saved', 5000)
    assert.equal(saved.data.settings.save.message, 'saved to project')
    // Allowed after the end too.
    await rpc(`sessions/${encodeURIComponent(ID)}/end`, { outcome: 'done' })
    assert.equal((await post({ keys: { box: false }, scope: 'user' })).status, 200)
    await page.close()
  }))

test('vision settings: validated, refused after the end and for secret runs, forwarded to the runner', () =>
  withDash({ replyMs: 300 }, async ({ d, api, rpc, register }) => {
    await register()
    const base = `sessions/${encodeURIComponent(ID)}`
    assert.equal((await api('/api/settings', { s: ID, mode: 'always' })).status, 409, 'no vision block in the state yet')
    await rpc(`${base}/state`, { status: 'observing', history: [], frames: [], vision: { mode: 'gated', model: 'jev-1.13.0', box: false, blocked: null } })
    const cmds = await commands(d, ID)
    assert.equal((await api('/api/settings', { s: ID, mode: 'sometimes' })).status, 400)
    assert.equal((await api('/api/settings', { s: ID, model: 'jev-9' })).status, 400)
    const pending = api('/api/settings', { s: ID, mode: 'always', box: true })
    const c = await cmds.next('settings')
    assert.deepEqual([c.mode, c.box], ['always', true])
    await fetch(new URL(`/rpc/sessions/${encodeURIComponent(ID)}/reply`, d.url), { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify({ cid: c.cid, ok: true }) })
    assert.equal((await pending).status, 200)
    await rpc(`${base}/state`, { status: 'observing', secret: true, history: [], frames: [], vision: { mode: 'off', model: 'jev-1.13.0', box: false, blocked: 'Vision is off' } })
    assert.equal((await api('/api/settings', { s: ID, mode: 'always' })).status, 409)
    await rpc(`${base}/end`, { outcome: 'done' })
    assert.equal((await api('/api/settings', { s: ID, mode: 'off' })).status, 409)
    await cmds.close()
  }))

test('a session that types a secret keeps no pixels, whatever the runner sends', () =>
  withDash({}, async ({ get, rpc, register }) => {
    await register({ secret: true })
    const base = `sessions/${encodeURIComponent(ID)}`
    await rpc(`${base}/frames`, { i: 1, step: 1, url: 'http://x', title: 'T', view: null, boxes: [], screenshot: 'c2VjcmV0', elements: [], decision: null })
    const f = await (await get(`/api/frame?s=${encodeURIComponent(ID)}&i=1`)).json()
    assert.equal(f.screenshot, null)
  }))

test('a runner that disappears without ending leaves an incomplete session', () =>
  withDash({}, async ({ d, register }) => {
    await register()
    const page = await events(`${d.url}api/events?t=${d.pageToken}`)
    const cmds = await commands(d, ID)
    await cmds.next('viewers')
    await cmds.close()
    const e = await page.until(x => x.event === 'sessions' && x.data.sessions[0]?.status === 'incomplete')
    assert.equal(e.data.sessions[0].source, 'memory')
    await page.close()
  }))

test('the tab: opened for the first task that asks, focused (not reopened) when a tab is already connected, never for a gate', async () => {
  const opened = []
  await withDash({ openUrl: u => opened.push(u), env: {} }, async ({ d, register }) => {
    await register({ open: true })
    assert.equal(opened.length, 1)
    assert.equal(opened[0], `${d.url}#s=${encodeURIComponent(ID)}`)
    await register({ open: true, kind: 'gate' }, GATE)
    assert.equal(opened.length, 1, 'a gate never opens a tab')
    const page = await events(`${d.url}api/events?t=${d.pageToken}`)
    const T2 = `${RUN}:flow-b`
    await register({ open: true }, T2)
    assert.equal((await page.until(e => e.event === 'sessions' && e.data.focus)).data.focus, T2)
    assert.equal(opened.length, 1)
    await page.close()
  })
})

test('/rpc/open: opens the tab at once (even a gate-only dashboard), focuses a connected tab instead, needs the runner token', async () => {
  const opened = []
  await withDash({ openUrl: u => opened.push(u), env: {} }, async ({ d, rpc, call }) => {
    assert.equal((await call('/rpc/open', { method: 'POST', body: '{}' })).status, 403)
    assert.equal((await call('/rpc/open', { method: 'POST', body: '{}' }, { 'x-pilot-token': d.pageToken })).status, 403)
    const r = await rpc('open', {})
    assert.deepEqual(await r.json(), { url: d.url, opened: true })
    await rpc('open', {})
    assert.deepEqual(opened, [d.url, d.url], 'not throttled')
    const page = await events(`${d.url}api/events?t=${d.pageToken}`)
    assert.equal((await (await rpc('open', {})).json()).opened, false)
    assert.equal(opened.length, 2, 'a connected tab is not duplicated')
    await page.close()
  })
})

test('CLI: --port 0 binds a free port; --open reaches the running dashboard and fails cleanly without one', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qp-dash-cli-'))
  const script = new URL('./dash-server.mjs', import.meta.url).pathname
  const none = spawnSync(process.execPath, [script, '--open', '--root', root], { encoding: 'utf8' })
  assert.equal(none.status, 1)
  assert.match(none.stderr, /no dashboard is running/)
  const child = spawn(process.execPath, [script, '--root', root, '--port', '0'], { stdio: ['ignore', 'ignore', 'pipe'], env: { ...process.env, PATH: '/nonexistent' } }) // no `open`/`xdg-open` on the PATH: the test never opens a real browser
  try {
    let err = ''
    const mark = await new Promise((res, rej) => {
      child.stderr.on('data', c => {
        err += c
        const m = /\[q-pilot\] dash (\{.*\})/.exec(err)
        if (m) res(JSON.parse(m[1]))
      })
      child.once('exit', () => rej(new Error(`exited: ${err}`)))
    })
    const port = Number(new URL(mark.url).port)
    assert.ok(port > 0)
    assert.equal(JSON.parse(readFileSync(mark.file, 'utf8')).port, port)
    const open = spawnSync(process.execPath, [script, '--open', '--root', root], { encoding: 'utf8', env: process.env })
    assert.equal(open.status, 0)
    assert.equal(open.stdout.trim(), mark.url)
  } finally {
    child.kill()
    rmSync(root, { recursive: true, force: true })
  }
})

test('the descriptor: 0600 file in a git-ignored folder; a second dashboard for the root is reused; a dead pid is overwritten', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qp-dash-'))
  const logs = []
  const a = await startDash({ root, port: 0, log: l => logs.push(l) })
  const file = join(root, '.q-pilot', 'dashboard', 'server.json')
  try {
    assert.equal(a.file, file)
    const desc = JSON.parse(readFileSync(file, 'utf8'))
    assert.deepEqual([desc.v, desc.pid, desc.port, desc.url, desc.root], [1, process.pid, a.port, a.url, root])
    assert.equal(desc.runnerToken, a.runnerToken)
    assert.equal(JSON.stringify(desc).includes(a.pageToken), false, 'the page token is not in the file')
    assert.equal((await import('node:fs')).statSync(file).mode & 0o777, 0o600)
    assert.equal(readFileSync(join(root, '.q-pilot', 'dashboard', '.gitignore'), 'utf8').trim(), '*')
    assert.match(logs[0], /^\[q-pilot\] dash \{"url":"http:\/\/127\.0\.0\.1:\d+\/","file":".*server\.json","reused":false\}$/)
    const b = await startDash({ root, port: 0, log: l => logs.push(l) })
    assert.equal(b.reused, true)
    assert.equal(b.url, a.url)
    assert.match(logs[1], /"reused":true\}$/)
    await a.close()
    assert.equal(existsSync(file), false, 'the descriptor goes with its dashboard')
    // A stale file: a pid that is gone.
    writeFileSync(file, JSON.stringify({ ...desc, pid: 2 ** 22 + 12345, port: 1 }))
    const c = await startDash({ root, port: 0, log: l => logs.push(l) })
    assert.equal(c.reused, false)
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).pid, process.pid)
    await c.close()
  } finally {
    await a.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('idle shutdown: with no live session and no tab the dashboard exits and removes its descriptor', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qp-dash-'))
  let idle = false
  const d = await startDash({ root, port: 0, log: () => {}, idleMs: 80, onIdle: () => (idle = true) })
  try {
    for (let i = 0; i < 60 && !idle; i++) await new Promise(r => setTimeout(r, 25))
    assert.equal(idle, true)
    assert.equal(existsSync(d.file), false)
  } finally {
    await d.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('a connected tab keeps the dashboard alive', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qp-dash-'))
  let idle = false
  const d = await startDash({ root, port: 0, log: () => {}, idleMs: 80, onIdle: () => (idle = true) })
  const page = await events(`${d.url}api/events?t=${d.pageToken}`)
  try {
    await new Promise(r => setTimeout(r, 300))
    assert.equal(idle, false)
  } finally {
    await page.close()
    await d.close()
    rmSync(root, { recursive: true, force: true })
  }
})

test('past runs from .q-pilot/runs are listed as history, and a live session of the same id replaces its history row', () =>
  withDash({}, async ({ d, root, get, register }) => {
    const dir = join(root, '.q-pilot', 'runs', '20261015-090000-aaaa')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'result.json'), JSON.stringify({ command: 'explore', runId: '20261015-090000-aaaa', startedAt: '2026-10-15T09:00:00.000Z', durationMs: 5000, flows: [{ id: 'old-flow', outcome: 'pass', steps: [], trace: join(dir, 'old-flow.trace.zip') }] }))
    const list = (await (await get('/api/sessions')).json()).sessions
    assert.deepEqual(list.map(s => [s.id, s.source, s.kind, s.status]), [['20261015-090000-aaaa:old-flow', 'history', 'test', 'ended']])
    await register()
    const again = (await (await get('/api/sessions')).json()).sessions
    assert.deepEqual(again.map(s => s.source), ['live', 'history'])
    assert.ok(d)
  }))

test('open streams get a comment ping, so a quiet command stream never reaches the client\'s body timeout', () =>
  withDash({ pingMs: 40 }, async ({ d, register }) => {
    await register()
    const read = async url => {
      const ac = new AbortController()
      const res = await fetch(url, { signal: ac.signal, headers: url.includes('/rpc/') ? { 'x-q-runner': d.runnerToken } : {} })
      const reader = res.body.getReader()
      let text = ''
      const end = Date.now() + 1500
      while (Date.now() < end && !text.includes(': ping')) text += new TextDecoder().decode((await reader.read()).value)
      ac.abort()
      return text
    }
    assert.match(await read(`${d.url}rpc/sessions/${encodeURIComponent(ID)}/commands`), /: ping\n\n/)
    assert.match(await read(`${d.url}api/events?t=${d.pageToken}`), /: ping\n\n/)
  }))

test('ask and save answers are per process: a restart on the same root never reads an old answer file', async () => {
  const root = mkdtempSync(join(tmpdir(), 'qp-dash-'))
  try {
    const a = await startDash({ root, port: 0, log: () => {} })
    writeFileSync(join(a.requestsDir, 'ask-1.answer.json'), JSON.stringify({ text: 'OLD' }))
    writeFileSync(join(a.requestsDir, 'settings-save-1.answer.json'), JSON.stringify({ ok: true, message: 'OLD' }))
    await a.close()
    const logs = []
    const b = await startDash({ root, port: 0, log: l => logs.push(l), env: { Q_PILOT_HEADLESS: '1' } })
    assert.notEqual(b.requestsDir, a.requestsDir)
    const runDir = join(root, '.q-pilot', 'runs', RUN)
    mkdirSync(runDir, { recursive: true })
    await fetch(new URL('/rpc/sessions', b.url), { method: 'POST', headers: { 'x-q-runner': b.runnerToken, 'content-type': 'application/json' }, body: JSON.stringify({ id: ID, kind: 'task', runDir }) })
    const asked = fetch(new URL('/api/ask', b.url), { method: 'POST', headers: { 'x-pilot-token': b.pageToken, 'content-type': 'application/json' }, body: JSON.stringify({ s: ID, question: 'new?' }) })
    const file = join(b.requestsDir, 'ask-1.json')
    for (let i = 0; i < 40 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 25))
    assert.equal(JSON.parse(readFileSync(file, 'utf8')).n, 1)
    await new Promise(r => setTimeout(r, 400))
    assert.equal(logs.some(l => l.includes('"n":1')), true, 'the new request waits for its own answer')
    writeFileSync(join(b.requestsDir, 'ask-1.answer.json'), JSON.stringify({ text: 'NEW' }))
    assert.equal((await (await asked).json()).answer, 'NEW')
    assert.match(logs.find(l => l.includes('ask {')), /requests\/\d+-\d+\/ask-1\.json/)
    await b.close()
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
})

test('a malformed session id in /rpc is a 400, not a 500', () =>
  withDash({}, async ({ d }) => {
    const r = await fetch(new URL('/rpc/sessions/%E0%A4%A/state', d.url), { method: 'POST', headers: { 'x-q-runner': d.runnerToken, 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 400)
  }))

test('memory is bounded: incomplete sessions join the eviction order and old ended sessions lose their screenshots', () =>
  withDash({}, async ({ d, get, rpc, register }) => {
    const ids = Array.from({ length: 7 }, (_, n) => `${RUN}:f${n}`)
    for (const id of ids) {
      await register({}, id)
      await rpc(`sessions/${encodeURIComponent(id)}/frames`, { i: 1, step: 1, url: 'u', title: 't', view: null, boxes: [], screenshot: 'c2hvdA==', elements: [], decision: null })
      await rpc(`sessions/${encodeURIComponent(id)}/end`, { outcome: 'done' })
    }
    const shot = async id => (await (await get(`/api/frame?s=${encodeURIComponent(id)}&i=1`)).json()).screenshot
    assert.equal(await shot(ids[0]), null, 'beyond the newest five')
    assert.equal(await shot(ids[1]), null)
    assert.equal(await shot(ids[2]), 'c2hvdA==')
    assert.equal(await shot(ids[6]), 'c2hvdA==')
    // An incomplete session is evicted like an ended one.
    const lost = `${RUN}:lost`
    await register({}, lost)
    const res = await fetch(new URL(`/rpc/sessions/${encodeURIComponent(lost)}/commands`, d.url), { headers: { 'x-q-runner': d.runnerToken } })
    await res.body.cancel()
    for (let n = 0; n < 21; n++) {
      const id = `${RUN}:g${n}`
      await register({}, id)
      await rpc(`sessions/${encodeURIComponent(id)}/end`, { outcome: 'done' })
    }
    const list = (await (await get('/api/sessions')).json()).sessions
    assert.equal(list.some(s => s.id === lost), false)
  }))

test('window app: the app window opens once with the session url, falls back to the tab opener with one logged reason, and never twice while a window is connected', async () => {
  const wins = [], tabs = []
  await withDash({ window: 'app', openWindow: async u => (wins.push(u), { ok: true, browser: {} }), openUrl: u => tabs.push(u), env: {} }, async ({ d, register }) => {
    await register({ open: true })
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual([wins, tabs], [[`${d.url}#s=${encodeURIComponent(ID)}`], []])
    const T2 = `${RUN}:flow-b`
    await register({ open: true }, T2)
    assert.equal(wins.length, 1, 'not again within the grace period')
    const page = await events(`${d.url}api/events?t=${d.pageToken}`)
    await register({ open: true }, `${RUN}:flow-c`)
    assert.equal(wins.length, 1, 'a connected window is focused instead')
    assert.equal((await page.until(e => e.event === 'sessions' && e.data.focus)).data.focus, `${RUN}:flow-c`)
    await page.close()
  })
  const logs = [], tabs2 = []
  await withDash({ window: 'app', openWindow: async () => ({ ok: false, reason: 'no Chromium-family browser found' }), openUrl: u => tabs2.push(u), env: {}, log: l => logs.push(l) }, async ({ d, rpc }) => {
    const open = () => rpc('open', {})
    assert.equal((await (await open()).json()).opened, true)
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual(tabs2, [d.url])
    assert.equal(logs.filter(l => l.includes('app window unavailable (no Chromium-family browser found)')).length, 1)
  })
})

test('window tab: the default-browser opener only, and a thrown app opener falls back too', async () => {
  const tabs = [], wins = []
  await withDash({ window: 'tab', openWindow: async u => wins.push(u), openUrl: u => tabs.push(u), env: {} }, async ({ d, register }) => {
    await register({ open: true })
    assert.deepEqual([wins.length, tabs.length], [0, 1])
  })
  const tabs2 = []
  await withDash({ window: 'app', openWindow: async () => { throw new Error('boom') }, openUrl: u => tabs2.push(u), env: {}, log: () => {} }, async ({ register }) => {
    await register({ open: true })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(tabs2.length, 1)
  })
})

test('/rpc/open can name the window kind for one open, overriding the dashboard default', async () => {
  const wins = [], tabs = []
  await withDash({ window: 'app', openWindow: async u => (wins.push(u), { ok: true }), openUrl: u => tabs.push(u), env: {} }, async ({ d, rpc }) => {
    assert.equal((await (await rpc('open', { window: 'tab' })).json()).opened, true)
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual([wins.length, tabs], [0, [d.url]])
  })
})

test('/api/config: get and set go through the mod, input is validated, a mod error is a 400, silence is a 504', async () => {
  const seen = []
  const config = async req => {
    seen.push(req)
    if (req.op === 'set' && req.value === 'bad') return { error: 'vision must be off, gated or always', settings: [] }
    return { ok: true, message: 'saved', settings: [{ key: 'dashboardWindow', value: req.value ?? 'app' }], files: { user: '/u', project: '/p', local: '/l' } }
  }
  await withDash({ config }, async ({ d, api, get }) => {
    const r = await get('/api/config')
    assert.equal(r.status, 200)
    assert.deepEqual(seen[0], { op: 'get' })
    assert.equal((await fetch(new URL('/api/config?t=nope', d.url))).status, 403)
    const post = (body, headers) => api('/api/config', body, headers)
    assert.equal((await post({ op: 'wipe', key: 'vision', scope: 'user' })).status, 400)
    assert.equal((await post({ op: 'set', key: 'vi sion', value: 'x', scope: 'user' })).status, 400)
    assert.equal((await post({ op: 'set', key: 'vision', value: 'x', scope: 'cli' })).status, 400)
    assert.equal((await post({ op: 'set', key: 'vision', value: 5, scope: 'user' })).status, 400)
    assert.equal((await post({ op: 'set', key: 'vision', value: 'x'.repeat(501), scope: 'user' })).status, 400)
    assert.equal((await post({ op: 'set', key: 'vision', value: 'off', scope: 'user' }, { origin: 'http://evil.example' })).status, 403)
    assert.equal((await post({ op: 'set', key: 'vision', value: 'x', scope: 'user' }, { 'x-pilot-token': 'nope' })).status, 403)
    assert.equal(seen.length, 1, 'nothing invalid reached the mod')
    const ok = await post({ op: 'set', key: 'vision', value: 'off', scope: 'project' })
    assert.equal(ok.status, 200)
    assert.deepEqual(seen[1], { op: 'set', key: 'vision', value: 'off', scope: 'project' })
    assert.equal((await ok.json()).message, 'saved')
    assert.deepEqual((await (await post({ op: 'unset', key: 'vision', scope: 'local' })).json()).ok, true)
    assert.deepEqual(seen[2], { op: 'unset', key: 'vision', scope: 'local' })
    const bad = await post({ op: 'set', key: 'vision', value: 'bad', scope: 'user' })
    assert.deepEqual([bad.status, (await bad.json()).error], [400, 'vision must be off, gated or always'])
  })
  await withDash({ config: async () => ({ error: 'no answer', timeout: true }) }, async ({ get }) => {
    assert.equal((await get('/api/config')).status, 504)
  })
})

test('/api/config through the real bridge: the request file and mark, then the mod\'s answer file', () =>
  withDash({}, async ({ d, get, logs }) => {
    const pending = get('/api/config')
    const file = join(d.requestsDir, 'config-1.json')
    for (let i = 0; i < 40 && !existsSync(file); i++) await new Promise(r => setTimeout(r, 25))
    assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), { op: 'get' })
    assert.ok(logs.some(l => l.startsWith('[q-pilot] config {"n":1,"file":')))
    writeFileSync(join(d.requestsDir, 'config-1.answer.json'), JSON.stringify({ ok: true, settings: [{ key: 'vision', value: 'gated' }], files: {} }))
    assert.equal((await (await pending).json()).settings[0].key, 'vision')
  }))

test('/api/config is refused with 503 when the dashboard was started without a mod', () =>
  withDash({ config: null }, async ({ api, get }) => {
    assert.equal((await get('/api/config')).status, 503)
    const r = await api('/api/config', { op: 'unset', key: 'vision', scope: 'user' })
    assert.equal(r.status, 503)
    assert.match((await r.json()).error, /started by Claude Code/)
  }))

test('changing dashboardWindow takes effect at once for the next window open', async () => {
  const wins = [], tabs = []
  const config = async req => ({ ok: true, settings: [{ key: 'dashboardWindow', value: req.op === 'unset' ? 'app' : req.value }], files: {} })
  await withDash({ window: 'tab', config, openWindow: async u => (wins.push(u), { ok: true }), openUrl: u => tabs.push(u), env: {} }, async ({ d, api, rpc }) => {
    await rpc('open', {})
    await new Promise(r => setTimeout(r, 30))
    assert.deepEqual([wins.length, tabs], [0, [d.url]])
    assert.equal((await api('/api/config', { op: 'unset', key: 'dashboardWindow', scope: 'user' })).status, 200)
    await rpc('open', { window: undefined })
    await new Promise(r => setTimeout(r, 30))
    assert.equal(wins.length, 0, 'the first open just happened: an app window waits out its grace period')
    assert.equal((await api('/api/config', { op: 'set', key: 'dashboardWindow', value: 'tab', scope: 'user' })).status, 200)
    await rpc('open', {})
    await new Promise(r => setTimeout(r, 30))
    assert.equal(tabs.length, 2)
  })
})
