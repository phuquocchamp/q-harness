// Run with: node --test viewer/server.test.mjs
import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs'
import { request } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { after, before, test } from 'node:test'
import { fileURLToPath } from 'node:url'

const here = dirname(fileURLToPath(import.meta.url))
const base = mkdtempSync(join(tmpdir(), 'q-graph-servertest-'))
const projects = join(base, 'projects')
const session = join(projects, 'proj', 'sess.jsonl')
const SUBAGENTS = 300
const at = s => `2026-10-14T10:00:${String(s % 60).padStart(2, '0')}.000Z`
const rec = r => `${JSON.stringify(r)}\n`
const call = (id, s) =>
  rec({ type: 'assistant', timestamp: at(s), message: { id: `m${id}`, model: 'claude-x', content: [{ type: 'tool_use', id, name: 'Bash', input: { command: `echo ${id}` } }] } })

let child
let info
let staleDir
let staleSeen
let ownedDir
let freshDir
let keptSeen

/** GET with an explicit Host header (fetch cannot set one). */
const get = (path, { host = `127.0.0.1:${info.port}`, token = info.token } = {}) =>
  new Promise((resolve, reject) => {
    const q = token === null ? '' : `${path.includes('?') ? '&' : '?'}k=${token}`
    const req = request({ host: '127.0.0.1', port: info.port, path: path + q, headers: { host } }, res => {
      let body = ''
      res.on('data', d => (body += d))
      res.on('end', () => resolve({ status: res.statusCode, headers: res.headers, body }))
    })
    req.on('error', reject)
    req.end()
  })

before(async () => {
  mkdirSync(join(projects, 'proj', 'sess', 'subagents'), { recursive: true })
  writeFileSync(session, rec({ type: 'user', timestamp: at(0), message: { role: 'user', content: 'hello' } }) + call('main1', 1))
  for (let i = 0; i < SUBAGENTS; i++) {
    writeFileSync(join(projects, 'proj', 'sess', 'subagents', `agent-a${i}.jsonl`), call(`s${i}`, 2))
  }
  // A stale viewer folder from a crashed run, and a fresh one that must stay.
  staleDir = join(tmpdir(), 'q-graph-Zz9Zz9')
  mkdirSync(staleDir, { recursive: true })
  const old = new Date(Date.now() - 48 * 3600 * 1000)
  utimesSync(staleDir, old, old)
  // An old folder whose owner is alive (this test process) and a fresh folder: both stay.
  ownedDir = join(tmpdir(), 'q-graph-Yy8Yy8')
  mkdirSync(ownedDir, { recursive: true })
  writeFileSync(join(ownedDir, 'owner.pid'), String(process.pid))
  writeFileSync(join(ownedDir, 'snapshot.json'), '{}')
  utimesSync(ownedDir, old, old)
  freshDir = join(tmpdir(), 'q-graph-Xx7Xx7')
  mkdirSync(freshDir, { recursive: true })
  writeFileSync(join(freshDir, 'snapshot.json'), '{}')

  child = spawn(process.execPath, [join(here, 'server.mjs')], {
    env: { ...process.env, Q_GRAPH_PROJECTS_ROOT: projects, Q_GRAPH_TEST: '1' },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  info = await new Promise((resolve, reject) => {
    let buf = ''
    child.stdout.on('data', d => {
      buf += d
      if (buf.includes('\n')) resolve(JSON.parse(buf.split('\n')[0]))
    })
    child.on('exit', code => reject(new Error(`server exited early: ${code}`)))
  })
  staleSeen = existsSync(staleDir)
  keptSeen = existsSync(join(ownedDir, 'snapshot.json')) && existsSync(join(freshDir, 'snapshot.json'))
  writeFileSync(info.file, JSON.stringify({ transcript: session }))
})

after(() => {
  child?.kill('SIGTERM')
  for (const d of [staleDir, ownedDir, freshDir]) rmSync(d, { recursive: true, force: true })
  rmSync(base, { recursive: true, force: true })
})

test('startup sweeps stale viewer folders and creates the snapshot with mode 0600', () => {
  assert.equal(staleSeen, false)
  assert.equal(keptSeen, true)
  assert.ok(existsSync(join(dirname(info.file), 'owner.pid')))
  assert.equal(statSync(info.file).mode & 0o777, 0o600)
})

test('401 without or with a wrong token, 200 with the token', async () => {
  assert.equal((await get('/timeline', { token: null })).status, 401)
  assert.equal((await get('/timeline', { token: 'nope' })).status, 401)
  assert.equal((await get('/timeline', { token: info.token + 'x' })).status, 401)
  assert.equal((await get('/snapshot.json')).status, 200)
  assert.equal((await get('/')).status, 200)
})

test('the theme sheet is served as CSS without a token, and only to a valid Host', async () => {
  const res = await get('/q-theme.css', { token: null })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^text\/css/)
  assert.match(res.body, /--q-bg:/)
  assert.equal((await get('/q-theme.css', { host: 'evil.example', token: null })).status, 403)
})

test('the icon is served as SVG without a token', async () => {
  const res = await get('/icon.svg', { token: null })
  assert.equal(res.status, 200)
  assert.match(res.headers['content-type'], /^image\/svg\+xml/)
  assert.match(res.body, /<svg /)
})

test('403 for a Host other than 127.0.0.1:<port> or localhost:<port>', async () => {
  assert.equal((await get('/snapshot.json', { host: 'evil.example' })).status, 403)
  assert.equal((await get('/snapshot.json', { host: `evil.example:${info.port}` })).status, 403)
  assert.equal((await get('/reactflow-base.css', { host: 'evil.example', token: null })).status, 403)
  assert.equal((await get('/snapshot.json', { host: `localhost:${info.port}` })).status, 200)
})

test('every response carries the security headers; the CSP allows the page CDNs', async () => {
  for (const res of [await get('/'), await get('/timeline'), await get('/timeline', { token: null })]) {
    assert.match(res.headers['content-security-policy'], /default-src 'none'/)
    assert.match(res.headers['content-security-policy'], /script-src [^;]*https:\/\/cdnjs\.cloudflare\.com[^;]*https:\/\/cdn\.jsdelivr\.net/)
    assert.match(res.headers['content-security-policy'], /frame-ancestors 'none'/)
    assert.equal(res.headers['x-content-type-options'], 'nosniff')
    assert.equal(res.headers['referrer-policy'], 'no-referrer')
    assert.equal(res.headers['cache-control'], 'no-store')
  }
})

test('a bad agent id is rejected without echoing paths', async () => {
  const res = await get('/detail?agent=' + encodeURIComponent('../../etc/passwd'))
  const body = JSON.parse(res.body)
  assert.match(body.error, /bad agent id/)
  const missing = JSON.parse((await get('/detail?agent=nosuchagent')).body)
  assert.equal(missing.error, 'transcript not found')
  assert.ok(!JSON.stringify(missing).includes(base))
})

test('/timeline has the lane shape, and many subagent files are parsed once', async () => {
  const stat = async () => JSON.parse((await get('/stats')).body).bytesParsed
  const res = await get('/timeline')
  assert.equal(res.status, 200)
  const tl = JSON.parse(res.body)
  assert.equal(tl.error, undefined)
  assert.equal(tl.lanes.length, SUBAGENTS + 1)
  assert.equal(tl.lanes[0].id, 'main')
  assert.deepEqual(Object.keys(tl.lanes[0].calls[0]).sort(), ['endedAt', 'hint', 'id', 'isError', 'startedAt', 'tool', 'useKey'])
  const first = await stat()
  assert.ok(first > 0)
  for (let i = 0; i < 3; i++) assert.equal(JSON.parse((await get('/timeline')).body).lanes.length, SUBAGENTS + 1)
  assert.equal(await stat(), first, 'repeat polls must not re-parse any file');
})

test('a transcript outside the projects folder or not .jsonl is not served', async () => {
  const outside = join(base, 'outside.jsonl')
  writeFileSync(outside, call('o', 1))
  for (const transcript of [outside, join(base, 'projects', 'proj', 'sess', 'subagents', 'agent-a1.meta.json')]) {
    writeFileSync(info.file, JSON.stringify({ transcript }))
    assert.equal(JSON.parse((await get('/timeline')).body).error, 'no transcript yet')
  }
  writeFileSync(info.file, JSON.stringify({ transcript: session }))
})

test('SSE clients are capped', async () => {
  const open = []
  const status = () =>
    new Promise(resolve => {
      const req = request({ host: '127.0.0.1', port: info.port, path: `/events?k=${info.token}`, headers: { host: `127.0.0.1:${info.port}` } }, res => {
        open.push(req)
        resolve(res.statusCode)
      })
      req.end()
    })
  const codes = []
  for (let i = 0; i < 18; i++) codes.push(await status())
  for (const req of open) req.destroy()
  assert.equal(codes.filter(c => c === 200).length, 16)
  assert.equal(codes.filter(c => c === 503).length, 2)
})
