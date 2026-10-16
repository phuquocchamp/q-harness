// The session core without any server: frames, the gate, secrets, and the file it leaves in the run dir.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createSession, summaryOf } from './session.mjs'

const page = { screenshot: async () => Buffer.from('jpeg') }
const snap = (n, label, url = `http://x/${n}`) => ({ url, title: `T${n}`, marker: [0, 0, 0, 0, 800, 600], actions: [{ node: n, kind: 'click', role: 'button', name: label, rect: { x: 1, y: 2, w: 3, h: 4 } }] })
const tick = () => new Promise(r => setTimeout(r, 10))

/** A session whose transport records what it is handed. */
function make(opts = {}) {
  const log = { pushes: 0, frames: [], ends: [] }
  const s = createSession({
    ...opts,
    transport: { push: () => log.pushes++, frame: f => log.frames.push({ ...f }), viewers: () => log.viewers ?? 0, end: p => log.ends.push(p) },
  })
  return { s, log }
}

test('frames: each observation is a frame, decisions and Claude steps update it, the transport sees every change', async () => {
  const { s, log } = make({ sessionModel: 'claude-opus-5-5' })
  log.viewers = 1
  s.start({ name: 't', goal: 'g' })
  await s.observed(page, snap(1, 'Search'), 1)
  assert.equal(s.state.screenshot, Buffer.from('jpeg').toString('base64'))
  s.decided({ operation: 'CLICK', elements: [{ index: '1' }], vision: { used: true } }, 'click button "Search"', 0.9)
  s.acted({ step: 1, action: 'click', by: 'claude' })
  await s.observed(page, snap(2, 'Back'), 2)
  s.helping('loop')
  assert.deepEqual(s.state.frames.map(f => [f.i, f.step, f.label, f.help, f.by, f.shot, f.vision]), [[1, 1, 'click button "Search"', null, 'claude', true, true], [2, 2, null, 'loop', null, true, false]])
  assert.deepEqual([s.state.history[0].model, s.state.history[0].frame], ['claude-opus-5-5', 1], 'Claude steps carry the session model')
  assert.equal(s.frame(1).decision.label, 'click button "Search"')
  assert.deepEqual(log.frames.map(f => f.i), [1, 1, 1, 2, 2])
  assert.ok(log.pushes >= 5)
  assert.deepEqual(s.state.boxes, [{ i: '1', rect: { x: 1, y: 2, w: 3, h: 4 } }])
})

test('no screenshot without a viewer, and none ever for a secret run', async () => {
  let shots = 0
  const p = { screenshot: async () => (shots++, Buffer.from('x')) }
  const { s, log } = make()
  s.start({ name: 't', goal: 'g' })
  await s.observed(p, snap(1, 'A'), 1)
  assert.equal(shots, 0)
  log.viewers = 1
  await s.observed(p, snap(2, 'B'), 2)
  assert.equal(shots, 1)
  const secret = make()
  secret.log.viewers = 1
  secret.s.start({ name: 't', goal: 'g', secrets: ['hunter22'] })
  await secret.s.observed(p, snap(1, 'A'), 1)
  assert.equal(shots, 1)
  assert.equal(secret.s.state.screenshots, false)
  assert.equal(secret.s.state.secret, true)
  assert.equal(secret.s.frame(1).screenshot, null)
})

test('the gate: pause holds, choose and execute release at their own point, run releases for good, stop ends', async () => {
  const { s } = make({ mode: 'pause' })
  s.start({ name: 't', goal: 'g' })
  let r
  const held = s.gate('predict').then(x => (r = x))
  await tick()
  assert.equal(s.state.status, 'paused')
  assert.equal(s.control('execute'), false, 'execute does not release a predict hold')
  assert.equal(s.control('choose'), true)
  await held
  assert.deepEqual(r, { waited: true })
  const held2 = s.gate('execute')
  await tick()
  assert.equal(s.state.status, 'held')
  s.control('execute')
  assert.deepEqual(await held2, { waited: true })
  const held3 = s.gate('predict')
  await tick()
  s.control('run')
  assert.deepEqual(await held3, { waited: true })
  assert.deepEqual(await s.gate('predict'), {}, 'in run mode the gate is open')
  s.control('pause')
  const held4 = s.gate('predict')
  await tick()
  s.control('stop')
  assert.deepEqual(await held4, { waited: true, stop: 'stopped from the dashboard' })
  assert.deepEqual(await s.gate('predict'), { stop: 'stopped from the dashboard' })
  assert.equal(s.control('bogus'), false)
})

test('take control holds like pause and shows its own status; release returns to a normal hold', async () => {
  const { s } = make()
  s.start({ name: 't', goal: 'g' })
  s.control('control')
  assert.equal(s.state.mode, 'pause')
  const held = s.gate('predict')
  await tick()
  assert.equal(s.state.status, 'control')
  s.person('click at (3, 4)')
  assert.deepEqual([s.state.history[0].by, s.state.history[0].action, s.state.status], ['person', 'click at (3, 4)', 'control'], 'a person row does not change the status')
  s.control('choose')
  await held
  assert.equal(s.state.taking, false)
})

test('extend moves the deadline and a held run past its deadline stops', async () => {
  const { s } = make({ mode: 'pause' })
  const deadline = Date.now() + 40
  s.start({ name: 't', goal: 'g', deadline })
  s.extend(1000)
  assert.equal(s.state.deadline, deadline + 1000)
  s.start({ name: 't', goal: 'g', deadline: Date.now() + 30 })
  assert.deepEqual(await s.gate('predict'), { waited: true, stop: 'time budget exceeded while paused' })
  assert.ok(s.state.pausedMs > 0)
})

test('detach lets go of a hold and leaves the run in run mode', async () => {
  const { s } = make({ mode: 'pause' })
  s.start({ name: 't', goal: 'g' })
  const held = s.gate('predict')
  await tick()
  s.detach()
  assert.deepEqual(await held, {})
  assert.deepEqual(await s.gate('execute'), {})
})

test('a secret run locks vision off whatever is asked, and applyVision cannot undo it', () => {
  const vision = { mode: 'always', model: 'jev-1.13.0', box: true }
  const { s } = make({ vision })
  s.start({ name: 't', goal: 'g', secrets: ['hunter22'] })
  assert.deepEqual([vision.mode, vision.box, s.state.vision.mode, typeof s.state.vision.blocked], ['off', false, 'off', 'string'])
  assert.equal(s.applyVision({ mode: 'always' }), false)
  assert.equal(s.applyVision({ box: true }), false)
  assert.equal(vision.mode, 'off')
  assert.equal(s.applyVision({ mode: 'off', box: false }), true)
})

test('applyVision updates the run\'s shared vision object and marks what changed against the sources', () => {
  const vision = { mode: 'gated', model: 'jev-1.13.0', box: false }
  const sources = { vision: { value: 'gated', scope: 'project', overridden: [] }, box: { value: false, scope: 'default', overridden: [] } }
  const { s } = make({ vision, settings: { sources, canSave: true } })
  assert.equal(s.state.settings.canSave, true)
  s.applyVision({ mode: 'always', box: true })
  assert.deepEqual([vision.mode, vision.box, s.state.settings.changed], ['always', true, ['vision', 'box']])
  assert.equal(make().s.applyVision({ mode: 'off' }), false, 'a run without vision settings')
})

test('writeSessionFile at the end: no pixels and no secret anywhere, even one planted in the goal, url and error', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-sess-'))
  try {
    const SECRET = 'hunter22-planted'
    const { s, log } = make({ meta: { id: '20261016-101010-abcd:flow-a', runId: '20261016-101010-abcd', flowId: 'flow-a', kind: 'task', runDir: dir, target: { kind: 'chromium', label: 'Chromium' } }, vision: { mode: 'gated', model: 'jev-1.13.0', box: false } })
    log.viewers = 1
    s.start({ name: 'flow a', goal: `Log in with ${SECRET}`, secrets: [SECRET] })
    await s.observed(page, snap(1, 'Go', `http://x/?pw=${SECRET}`), 1)
    s.acted({ step: 1, action: `fill textbox = ${SECRET}`, by: 'jev' })
    s.end({ outcome: 'blocked', error: `failed with ${SECRET}`, checks: [{ name: `saw ${SECRET}`, ok: false }] })
    const text = readFileSync(join(dir, 'flow-a.session.json'), 'utf8')
    assert.equal(text.includes(SECRET), false)
    assert.equal(/"screenshot"/.test(text), false)
    const j = JSON.parse(text)
    assert.deepEqual([j.v, j.id, j.kind, j.secret, j.outcome, j.frames.length, j.history.length], [1, '20261016-101010-abcd:flow-a', 'task', true, 'blocked', 1, 1])
    assert.equal(j.goal, 'Log in with [redacted]')
    assert.deepEqual(Object.keys(j.vision).sort(), ['box', 'mode', 'model', 'stats'])
    assert.equal(log.ends[0].outcome, 'blocked')
    assert.equal(log.ends[0].error.includes(SECRET), false)
    s.end({ outcome: 'later' })
    assert.equal(log.ends.length, 1, 'a second end is ignored')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('without a run dir nothing is written, and summaryOf gives the sidebar chip', () => {
  const { s } = make({ meta: { id: 'local' } })
  assert.equal(s.writeSessionFile(), null)
  const meta = { id: '20261016-101010-abcd:f', runId: '20261016-101010-abcd', flowId: 'f', kind: 'gate', name: 'f', target: { kind: 'electron', label: 'Electron' } }
  const state = { status: 'ended', outcome: 'drift', history: [1, 2, 3], startedAt: 0, name: 'f' }
  const sum = summaryOf(meta, state, { endedAt: 61000 })
  assert.deepEqual([sum.status, sum.red, sum.controls, sum.subline, sum.source, sum.target.kind], ['ended', true, false, 'gate · 3 steps · 1:01 · drift', 'live', 'electron'])
  assert.equal(sum.group, null)
  assert.equal(summaryOf({ ...meta, group: 'pmgx1abcd' }, state).group, 'pmgx1abcd')
  assert.deepEqual([summaryOf(meta, { status: 'held', history: [] }).status, summaryOf(meta, { status: 'helping', history: [] }).status, summaryOf(meta, { status: 'observing', history: [] }).status], ['paused', 'helping', 'live'])
})
