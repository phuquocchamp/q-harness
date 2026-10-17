// The runner's client against a real dash-server: what it pushes, what it does when the dashboard dies, and the
// screencast rules (never for a secret run, only while someone watches, snapshots when the browser sends nothing).
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { startDash } from './dash-server.mjs'
import { connectSession, readDash } from './dash-client.mjs'

const RUN = '20261016-101010-abcd'
const ID = `${RUN}:flow-a`
const snap = (n, label) => ({ url: `http://x/${n}`, title: `T${n}`, marker: [0, 0, 0, 0, 800, 600], actions: [{ node: n, kind: 'click', role: 'button', name: label, rect: { x: 1, y: 2, w: 3, h: 4 } }] })
const wait = async (pred, ms = 3000) => {
  for (const end = Date.now() + ms; Date.now() < end; ) {
    if (await pred()) return true
    await new Promise(r => setTimeout(r, 20))
  }
  throw new Error('timed out waiting')
}
const fakePage = () => {
  const p = { shots: 0, screenshot: async () => (p.shots++, Buffer.from('jpeg')) }
  return p
}

async function withDash(fn, dashOpts = {}) {
  const root = mkdtempSync(join(tmpdir(), 'qp-cli-'))
  const d = await startDash({ root, port: 0, log: () => {}, env: { Q_PILOT_HEADLESS: '1' }, ...dashOpts })
  const desc = { v: 1, pid: process.pid, port: d.port, url: d.url, runnerToken: d.runnerToken, root }
  const runDir = join(root, '.q-pilot', 'runs', RUN)
  mkdirSync(runDir, { recursive: true })
  const meta = (extra = {}) => ({ id: ID, runId: RUN, flowId: 'flow-a', kind: 'task', name: 'flow a', runDir, target: { kind: 'chromium', label: 'Chromium' }, startedAt: Date.now(), mode: 'run', ...extra })
  const list = async () => (await (await fetch(new URL(`/api/sessions?t=${d.pageToken}`, d.url))).json()).sessions
  const api = (path, body) => fetch(new URL(path, d.url), { method: 'POST', headers: { 'content-type': 'application/json', 'x-pilot-token': d.pageToken }, body: JSON.stringify(body) })
  /** A tab with this session selected: the runner sees one viewer. */
  const watch = async () => {
    const ac = new AbortController()
    const res = await fetch(new URL(`/api/events?t=${d.pageToken}&s=${encodeURIComponent(ID)}`, d.url), { signal: ac.signal })
    const seen = []
    ;(async () => {
      const dec = new TextDecoder()
      let buf = ''
      try {
        for await (const c of res.body) {
          buf += dec.decode(c, { stream: true })
          for (let k; (k = buf.indexOf('\n\n')) >= 0; ) {
            const block = buf.slice(0, k)
            buf = buf.slice(k + 2)
            const ev = /^event: (.*)$/m.exec(block)?.[1], data = /^data: (.*)$/m.exec(block)?.[1]
            if (data) seen.push({ event: ev, data: JSON.parse(data) })
          }
        }
      } catch {}
    })()
    return { seen, close: async () => ac.abort() }
  }
  try {
    return await fn({ d, desc, root, runDir, meta, list, api, watch })
  } finally {
    await d.close()
    rmSync(root, { recursive: true, force: true })
  }
}

test('readDash: the descriptor named by Q_PILOT_DASH_FILE, or null', () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-rd-'))
  try {
    const file = join(dir, 'server.json')
    const desc = { v: 1, pid: 1, port: 8767, url: 'http://127.0.0.1:8767/', runnerToken: 't', root: '/r' }
    assert.equal(readDash({}), null)
    assert.equal(readDash({ Q_PILOT_DASH_FILE: file }), null, 'missing')
    writeFileSync(file, '{nope')
    assert.equal(readDash({ Q_PILOT_DASH_FILE: file }), null, 'unparsable')
    writeFileSync(file, JSON.stringify(desc))
    assert.deepEqual(readDash({ Q_PILOT_DASH_FILE: file }), desc)
    assert.equal(readDash({ Q_PILOT_DASH_FILE: file }, '/other'), null, 'another root')
    assert.deepEqual(readDash({ Q_PILOT_DASH_FILE: file }, '/r'), desc)
    writeFileSync(file, JSON.stringify({ ...desc, runnerToken: undefined }))
    assert.equal(readDash({ Q_PILOT_DASH_FILE: file }), null)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('a session reports its state, frames and end to the dashboard; close() sends the end even when files come after it', () =>
  withDash(async ({ desc, meta, list, d, runDir }) => {
    const f = await connectSession(desc, meta(), {})
    assert.equal(f.url, `${d.url}#s=${ID}`)
    assert.equal((await f.lingering()), 'closed')
    assert.equal(await f.waitForClient(10), true)
    f.start({ name: 'flow a', goal: 'Find flights', deadline: Date.now() + 60000 })
    await f.observed(fakePage(), snap(1, 'Search'), 1)
    f.decided({ operation: 'CLICK', elements: [{ index: '1' }] }, 'click button "Search"', 0.9)
    f.acted({ step: 1, action: 'click button "Search"', by: 'jev', p: 0.9 })
    await wait(async () => (await list())[0]?.subline?.includes('1 steps'))
    const frame = await (await fetch(new URL(`/api/frame?t=${d.pageToken}&s=${encodeURIComponent(ID)}&i=1`, d.url))).json()
    assert.equal(frame.decision.label, 'click button "Search"')
    assert.equal(frame.screenshot, null, 'nobody watched: no pixels taken')
    const trace = join(runDir, 'flow-a.trace.zip')
    writeFileSync(trace, 'PK')
    f.end({ outcome: 'done', checks: [] })
    f.files({ trace })
    await f.close()
    const [s] = await list()
    assert.deepEqual([s.status, s.outcome], ['ended', 'done'])
    const dl = await fetch(new URL(`/api/file?t=${d.pageToken}&s=${encodeURIComponent(ID)}&kind=trace`, d.url))
    assert.equal(await dl.text(), 'PK')
    assert.equal(JSON.parse(await (await import('node:fs/promises')).readFile(join(runDir, 'flow-a.session.json'), 'utf8')).outcome, 'done')
  }))

test('a screenshot is taken only while a tab watches the session', () =>
  withDash(async ({ desc, meta, watch }) => {
    const f = await connectSession(desc, meta(), {})
    const p = fakePage()
    f.start({ name: 'a', goal: 'g' })
    await f.observed(p, snap(1, 'A'), 1)
    assert.equal(p.shots, 0)
    const tab = await watch()
    await wait(() => f.clients === 1)
    await f.observed(p, snap(2, 'B'), 2)
    assert.equal(p.shots, 1)
    assert.equal(f.frame(2).screenshot, Buffer.from('jpeg').toString('base64'))
    await tab.close()
    await wait(() => f.clients === 0)
    await f.observed(p, snap(3, 'C'), 3)
    assert.equal(p.shots, 1)
    await f.close()
  }))

test('the dashboard dies mid-run: later pushes do not throw, the client detaches and a pending gate resolves {} within 2 s', () =>
  withDash(async ({ desc, meta, d }) => {
    const f = await connectSession(desc, meta({ mode: 'pause' }), {})
    f.start({ name: 'a', goal: 'g' })
    await f.observed(fakePage(), snap(1, 'A'), 1)
    const gate = f.gate('predict')
    await new Promise(r => setTimeout(r, 50))
    assert.equal(f.state.status, 'paused')
    const t0 = Date.now()
    await d.close()
    assert.deepEqual(await gate, {})
    assert.ok(Date.now() - t0 < 2000)
    assert.equal(f.detached, true)
    f.acted({ step: 1, action: 'x', by: 'jev' })
    await f.observed(fakePage(), snap(2, 'B'), 2)
    assert.deepEqual(await f.gate('predict'), {}, 'detached: the run is not held again')
    f.end({ outcome: 'done' })
    await f.close()
  }))

test('registration gives up within 1.6 s when the dashboard accepts but never answers, and at once when nothing listens', async () => {
  const hang = createServer(() => {})
  await new Promise(r => hang.listen(0, '127.0.0.1', r))
  const port = hang.address().port
  const meta = { id: ID, runId: RUN, flowId: 'flow-a', kind: 'task', name: 'a', runDir: '/x' }
  try {
    const t0 = Date.now()
    assert.equal(await connectSession({ url: `http://127.0.0.1:${port}/`, runnerToken: 't', port, v: 1 }, meta, {}), null)
    assert.ok(Date.now() - t0 < 1600, `took ${Date.now() - t0} ms`)
  } finally {
    hang.closeAllConnections()
    hang.close()
  }
  assert.equal(await connectSession({ url: `http://127.0.0.1:${port}/`, runnerToken: 't', port, v: 1 }, meta, {}), null)
})

test('a dashboard that refuses the session (wrong runner token) gives null, not an error', () =>
  withDash(async ({ desc, meta }) => {
    assert.equal(await connectSession({ ...desc, runnerToken: 'wrong' }, meta(), {}), null)
  }))

test('no startLive call for a secret run, however many watch; its live mode says why', () =>
  withDash(async ({ desc, meta, watch }) => {
    let calls = 0
    const screencast = { startLive: async () => (calls++, { page: null, stop: async () => {} }), sendInput: async () => null }
    const f = await connectSession(desc, meta({ secret: true }), { screencast })
    const tab = await watch()
    await wait(() => f.clients === 1)
    f.start({ name: 'a', goal: 'g', secrets: ['hunter22'] })
    const p = fakePage()
    await f.observed(p, snap(1, 'A'), 1)
    await new Promise(r => setTimeout(r, 100))
    assert.equal(calls, 0)
    assert.equal(p.shots, 0)
    assert.equal(f.state.live.mode, 'off')
    await tab.close()
    await f.close()
  }))

test('the screencast runs only while watched, follows the page, forwards frames and stops at the end', () =>
  withDash(async ({ desc, meta, watch }) => {
    const started = [], stopped = []
    let onFrame
    const screencast = {
      startLive: async (page, cb) => {
        started.push(page)
        onFrame = cb
        return { page, stop: async () => stopped.push(page) }
      },
      sendInput: async () => null,
    }
    const f = await connectSession(desc, meta(), { screencast, fallbackMs: 5000 })
    const a = fakePage(), b = fakePage()
    f.start({ name: 'a', goal: 'g' })
    await f.observed(a, snap(1, 'A'), 1)
    assert.equal(started.length, 0, 'nobody watches')
    const tab = await watch()
    await wait(() => f.clients === 1)
    await f.observed(a, snap(2, 'B'), 2)
    await wait(() => started.length === 1)
    assert.equal(started[0], a)
    onFrame(Buffer.from('LIVE1'), { deviceWidth: 800, deviceHeight: 600 })
    await wait(() => tab.seen.some(e => e.event === 'live' && e.data.jpeg === Buffer.from('LIVE1').toString('base64')))
    assert.deepEqual([tab.seen.find(e => e.event === 'live').data.w, f.state.live.mode], [800, 'screencast'])
    // With a live stream the frame takes the live image, not a new screenshot.
    await f.observed(a, snap(3, 'C'), 3)
    assert.equal(a.shots, 1)
    assert.equal(f.frame(3).screenshot, Buffer.from('LIVE1').toString('base64'))
    // The run moved to another tab.
    await f.observed(b, snap(4, 'D'), 4)
    await wait(() => started.length === 2)
    assert.deepEqual([stopped[0], started[1]], [a, b])
    await tab.close()
    await wait(() => stopped.length === 2)
    assert.equal(f.state.live.mode, 'off')
    const tab2 = await watch()
    await wait(() => started.length === 3)
    f.end({ outcome: 'done' })
    await wait(() => stopped.length === 3)
    await tab2.close()
    await f.close()
  }))

test('snapshots take over when startLive throws or the browser sends no frame within the fallback time', () =>
  withDash(async ({ desc, meta, watch }) => {
    const tab = await watch()
    const broken = await connectSession(desc, meta(), { screencast: { startLive: async () => { throw new Error('no CDP') } } })
    await wait(() => broken.clients === 1)
    const p = fakePage()
    broken.start({ name: 'a', goal: 'g' })
    await broken.observed(p, snap(1, 'A'), 1)
    await wait(() => broken.state.live?.mode === 'snapshots')
    assert.match(broken.state.live.reason, /no CDP/)
    await broken.observed(p, snap(2, 'B'), 2)
    assert.equal(p.shots, 2, 'a snapshot per observation')
    await broken.close()
    await tab.close()
  }))

test('no live frame within the fallback time: snapshots, and the stream takes over again when frames arrive', () =>
  withDash(async ({ desc, meta, watch }) => {
    let onFrame
    const screencast = { startLive: async (page, cb) => ((onFrame = cb), { page, stop: async () => {} }), sendInput: async () => null }
    const tab = await watch()
    const f = await connectSession(desc, meta(), { screencast, fallbackMs: 80 })
    await wait(() => f.clients === 1)
    const p = fakePage()
    f.start({ name: 'a', goal: 'g' })
    await f.observed(p, snap(1, 'A'), 1)
    await wait(() => f.state.live?.mode === 'snapshots')
    await f.observed(p, snap(2, 'B'), 2)
    assert.equal(p.shots, 2)
    onFrame(Buffer.from('LATE'), { deviceWidth: 10, deviceHeight: 10 })
    assert.equal(f.state.live.mode, 'screencast')
    await f.close()
    await tab.close()
  }))

test('commands: control and settings are applied, redact uses the run\'s secrets, input needs a hold and goes through the screencast module', () =>
  withDash(async ({ desc, meta, api, watch, list }) => {
    const inputs = []
    const screencast = { startLive: async (page, cb) => ({ page, stop: async () => {} }), sendInput: async (page, ev, m) => (inputs.push([page, ev]), ev.type === 'click' ? 'click at (4, 5)' : null) }
    const vision = { mode: 'gated', model: 'jev-1.13.0', box: false }
    const f = await connectSession(desc, meta(), { vision, screencast })
    const tab = await watch()
    await wait(() => f.clients === 1)
    const page = fakePage()
    f.start({ name: 'a', goal: 'g', secrets: [] })
    await f.observed(page, snap(1, 'A'), 1)
    await wait(async () => (await list())[0]?.name === 'a') // the first state push has arrived
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'click', x: 0.5, y: 0.5 } })).status, 409, 'not held')
    assert.equal((await api('/api/settings', { s: ID, mode: 'always', box: true })).status, 200)
    assert.deepEqual([vision.mode, vision.box], ['always', true])
    assert.equal((await api('/api/control', { s: ID, action: 'pause' })).status, 200)
    assert.equal(f.state.mode, 'pause')
    const held = f.gate('predict')
    await wait(() => f.state.status === 'paused')
    await wait(async () => (await list())[0]?.status === 'paused')
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'click', x: 0.5, y: 0.5 } })).status, 200)
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'move', x: 0.1, y: 0.1 } })).status, 200)
    assert.equal(inputs.length, 2)
    assert.equal(inputs[0][0], page)
    assert.deepEqual(f.state.history.map(h => [h.by, h.action]), [['person', 'click at (4, 5)']], 'moves are not trail rows')
    assert.equal((await api('/api/control', { s: ID, action: 'control' })).status, 200)
    assert.equal(f.state.status, 'control')
    assert.equal((await api('/api/control', { s: ID, action: 'run' })).status, 200)
    assert.deepEqual(await held, { waited: true })
    await tab.close()
    await f.close()
  }))

test('Ask Claude on a live secret run: the answer is redacted by the runner with the run\'s secrets, and input is refused', () =>
  withDash(async ({ desc, meta, api, watch, list }) => {
    const f = await connectSession(desc, meta(), {})
    const tab = await watch()
    await wait(() => f.clients === 1)
    f.start({ name: 'a', goal: 'g', secrets: ['hunter22'] })
    await f.observed(fakePage(), snap(1, 'A'), 1)
    await wait(async () => (await list())[0]?.secret === true)
    const r = await (await api('/api/ask', { s: ID, question: 'What now?' })).json()
    assert.equal(r.answer, 'Type [redacted] now')
    assert.equal((await api('/api/input', { s: ID, ev: { type: 'key', key: 'a' } })).status, 409)
    await tab.close()
    await f.close()
  }, { askTransport: async () => ({ text: 'Type hunter22 now' }) }))

test('files() after end() still reach the dashboard: the closed command stream is not a failure once the end was sent', () =>
  withDash(async ({ desc, meta, runDir, list, d }) => {
    const f = await connectSession(desc, meta(), {})
    f.start({ name: 'a', goal: 'g' })
    await f.observed(fakePage(), snap(1, 'A'), 1)
    f.end({ outcome: 'fail' })
    await wait(async () => (await list())[0]?.status === 'ended')
    await new Promise(r => setTimeout(r, 100))
    assert.equal(f.detached, false)
    const trace = join(runDir, 'flow-a.trace.zip')
    writeFileSync(trace, 'PK')
    f.files({ trace })
    await f.close()
    const dl = await fetch(new URL(`/api/file?t=${d.pageToken}&s=${encodeURIComponent(ID)}&kind=trace`, d.url))
    assert.equal(await dl.text(), 'PK')
  }))

test('refusals (4xx) never detach the client, and a descriptor must point at 127.0.0.1', () =>
  withDash(async ({ desc, meta, runDir }) => {
    const f = await connectSession(desc, meta(), {})
    f.start({ name: 'a', goal: 'g' })
    // Frames over the dashboard's 2 MB cap are refused (413) again and again: not a dead dashboard.
    const page = fakePage()
    for (let n = 1; n <= 5; n++) {
      await f.observed({ screenshot: async () => Buffer.alloc(3 * 1024 * 1024, 1) }, snap(n, 'A'), n)
      await new Promise(r => setTimeout(r, 120))
    }
    assert.equal(f.detached, false)
    assert.ok(page)
    await f.close()
    const dir = mkdtempSync(join(tmpdir(), 'qp-rd-'))
    try {
      const file = join(dir, 'server.json')
      writeFileSync(file, JSON.stringify({ ...desc, url: 'http://evil.example:8767/' }))
      assert.equal(readDash({ Q_PILOT_DASH_FILE: file }), null)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
    assert.ok(runDir)
  }))
