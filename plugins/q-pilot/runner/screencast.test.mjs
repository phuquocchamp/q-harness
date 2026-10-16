// The live view and take-control input against a fake CDP session and page; no browser needed.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { sendInput, startLive, targetOf, toPoint } from './screencast.mjs'
import { createServer } from 'node:http'

const fakeCdp = ({ failStart = false } = {}) => {
  const sent = [], handlers = {}
  const cdp = {
    sent, handlers, detached: 0,
    on: (e, h) => (handlers[e] = h),
    send: async (m, p) => {
      sent.push([m, p])
      if (failStart && m === 'Page.startScreencast') throw new Error('no screencast here')
    },
    detach: async () => { cdp.detached++ },
  }
  return cdp
}
const pageOf = cdp => ({ context: () => ({ newCDPSession: async () => cdp }) })
const frame = (cdp, sessionId, metadata = { deviceWidth: 1000, deviceHeight: 500 }) => cdp.handlers['Page.screencastFrame']({ data: Buffer.from('jpg').toString('base64'), metadata, sessionId })
const acks = cdp => cdp.sent.filter(([m]) => m === 'Page.screencastFrameAck').map(([, p]) => p.sessionId)

test('every frame is acked, delivery is throttled to fps, and a pending delivery holds the next frames', async () => {
  const cdp = fakeCdp()
  const got = []
  const live = await startLive(pageOf(cdp), (buf, m) => got.push([buf.toString(), m.deviceWidth]), { fps: 10 })
  assert.deepEqual(cdp.sent[0], ['Page.startScreencast', { format: 'jpeg', quality: 55, maxWidth: 1280, maxHeight: 900, everyNthFrame: 1 }])
  frame(cdp, 1)
  frame(cdp, 2)
  frame(cdp, 3)
  assert.deepEqual(acks(cdp), [1, 2, 3], 'dropped frames are acked too')
  assert.deepEqual(got, [['jpg', 1000]])
  await new Promise(r => setTimeout(r, 120))
  frame(cdp, 4)
  assert.equal(got.length, 2)

  let release
  const slow = fakeCdp()
  const seen = []
  await startLive(pageOf(slow), () => { seen.push(1); return new Promise(r => (release = r)) }, { fps: 1000 })
  frame(slow, 1)
  await new Promise(r => setTimeout(r, 10))
  frame(slow, 2)
  assert.equal(seen.length, 1, 'one delivery in flight at a time')
  release()
  await new Promise(r => setTimeout(r, 10))
  frame(slow, 3)
  assert.equal(seen.length, 2)
  assert.deepEqual(acks(slow), [1, 2, 3])
  await live.stop()
})

test('stop is idempotent, detaches once and drops later frames (still acked)', async () => {
  const cdp = fakeCdp()
  const got = []
  const live = await startLive(pageOf(cdp), b => got.push(b))
  await live.stop()
  await live.stop()
  assert.equal(cdp.sent.filter(([m]) => m === 'Page.stopScreencast').length, 1)
  assert.equal(cdp.detached, 1)
  frame(cdp, 9)
  assert.deepEqual([got.length, acks(cdp)], [0, [9]])
})

test('startLive throws when the screencast cannot start, after detaching', async () => {
  const cdp = fakeCdp({ failStart: true })
  await assert.rejects(startLive(pageOf(cdp), () => {}), /no screencast here/)
  assert.equal(cdp.detached, 1)
  await assert.rejects(startLive({ context: () => ({ newCDPSession: async () => { throw new Error('no cdp') } }) }, () => {}), /no cdp/)
})

test('fractions map to CSS px with offsetTop and pageScaleFactor; bad fractions are refused', () => {
  assert.deepEqual(toPoint({ x: 0.5, y: 0.5 }, { deviceWidth: 1000, deviceHeight: 500 }), { x: 500, y: 250 })
  assert.deepEqual(toPoint({ x: 0.5, y: 1 }, { deviceWidth: 1000, deviceHeight: 500, offsetTop: 50 }), { x: 500, y: 450 })
  assert.deepEqual(toPoint({ x: 0.5, y: 0.5 }, { deviceWidth: 1000, deviceHeight: 500, pageScaleFactor: 2 }), { x: 250, y: 125 })
  assert.deepEqual(toPoint({ x: 1, y: 0 }, null, { width: 1280, height: 720 }), { x: 1280, y: 0 })
  for (const ev of [{ x: 1.1, y: 0 }, { x: 0, y: -0.1 }, { x: '0', y: 0 }, {}, { x: NaN, y: 0 }]) assert.throws(() => toPoint(ev, { deviceWidth: 1, deviceHeight: 1 }), /fractions/, JSON.stringify(ev))
  assert.throws(() => toPoint({ x: 0, y: 0 }, null, null), /unknown/)
})

const fakePage = () => {
  const calls = []
  const rec = name => (...a) => { calls.push([name, ...a]) }
  return { calls, viewportSize: () => ({ width: 800, height: 600 }), mouse: { click: rec('click'), dblclick: rec('dblclick'), move: rec('move'), wheel: rec('wheel') }, keyboard: { press: rec('press'), type: rec('type') } }
}

test('input events drive Playwright; the trail text never holds typed text', async () => {
  const p = fakePage()
  assert.equal(await sendInput(p, { type: 'click', x: 0.5, y: 0.25 }), 'click at (400, 150)')
  assert.equal(await sendInput(p, { type: 'dblclick', x: 0, y: 0, button: 'right' }), 'double click at (0, 0)')
  assert.equal(await sendInput(p, { type: 'move', x: 1, y: 1 }), null)
  assert.equal(await sendInput(p, { type: 'wheel', dy: 99999, dx: 'x' }), null)
  assert.equal(await sendInput(p, { type: 'key', key: 'Enter' }), 'press Enter')
  assert.equal(await sendInput(p, { type: 'key', key: 'Control+a' }), 'press Control+a')
  assert.equal(await sendInput(p, { type: 'key', key: 'x' }), 'typed 1 chars', 'a single character is typed text, not a key name')
  assert.equal(await sendInput(p, { type: 'text', text: 'hunter2' }), 'typed 7 chars')
  assert.deepEqual(p.calls, [
    ['click', 400, 150, { button: 'left' }], ['dblclick', 0, 0, { button: 'right' }], ['move', 800, 600], ['wheel', 0, 2000],
    ['press', 'Enter'], ['press', 'Control+a'], ['press', 'x'], ['type', 'hunter2'],
  ])
})

test('input is validated: the key allowlist, text length, button and event type', async () => {
  const p = fakePage()
  for (const ev of [{ type: 'key', key: 'a;b' }, { type: 'key', key: '' }, { type: 'key', key: 'x'.repeat(33) }, { type: 'key' }, { type: 'text', text: '' }, { type: 'text', text: 'x'.repeat(201) }, { type: 'text', text: 5 },
    { type: 'click', x: 0, y: 0, button: 'back' }, { type: 'click', x: 2, y: 0 }, { type: 'drag' }, null, 'click']) {
    await assert.rejects(sendInput(p, ev), Error, JSON.stringify(ev))
  }
  assert.deepEqual(p.calls, [], 'nothing reached the page')
})

test('targetOf: launched is chromium; an attached browser is Electron by its User-Agent, else Chrome (CDP); never throws', async () => {
  assert.deepEqual(await targetOf({ version: () => '130.0.6723.31' }, {}), { kind: 'chromium', label: 'Chromium 130' })
  assert.deepEqual(await targetOf({}, {}), { kind: 'chromium', label: 'Chromium' })
  const serve = ua => new Promise(r => {
    const s = createServer((req, res) => res.end(JSON.stringify({ 'User-Agent': ua }))).listen(0, '127.0.0.1', () => r(s))
  })
  for (const [ua, want] of [['Mozilla/5.0 Chrome/130 Electron/33.2.0 Safari', { kind: 'electron', label: 'Electron 33' }], ['Mozilla/5.0 Chrome/130 Safari', { kind: 'chrome-cdp', label: 'Chrome (CDP)' }]]) {
    const s = await serve(ua)
    try {
      assert.deepEqual(await targetOf({}, { Q_PILOT_CDP_URL: `http://127.0.0.1:${s.address().port}` }), want)
    } finally { s.close() }
  }
  assert.deepEqual(await targetOf({}, { Q_PILOT_CDP_URL: 'http://127.0.0.1:1' }), { kind: 'chrome-cdp', label: 'Chrome (CDP)' })
})
