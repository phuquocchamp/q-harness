// Past runs rebuilt from .q-pilot/runs: a finished run, a run that never wrote result.json, session.json, and bad names.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { listRuns, loadFrame, loadRun } from './history.mjs'

function withRoot(fn) {
  const root = mkdtempSync(join(tmpdir(), 'qp-hist-'))
  const run = id => {
    const dir = join(root, '.q-pilot', 'runs', id)
    mkdirSync(dir, { recursive: true })
    return dir
  }
  const put = (dir, name, obj) => writeFileSync(join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj))
  try {
    return fn({ root, run, put })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

const ROW = { step: 1, url: 'http://x/1', chose: 'click button "Go"', p: 0.9, latencyMs: 300, jevModel: 'jev-1.13.0', elements: [{ index: '1', role: 'button', label: 'Go' }], operations: { CLICK: 1 } }

test('a finished run: one session per flow with outcome, files, trail and frames from decisions.json', () =>
  withRoot(({ root, run, put }) => {
    const id = '20261016-045325-c4a0'
    const dir = run(id)
    put(dir, 'result.json', { command: 'task', runId: id, startedAt: '2026-10-16T04:53:25.672Z', durationMs: 46000, playwright: { version: '1.64.1' }, flows: [{ id: 'task-1', outcome: 'blocked', error: 'stuck', steps: [{ op: 'click', by: 'claude' }], trace: join(dir, 'task-1.trace.zip'), decisions: join(dir, 'task-1.decisions.json'), screenshot: join(dir, 'task-1.png'), checks: [] }] })
    put(dir, 'task-1.decisions.json', [ROW])
    put(dir, 'task-1.trace.zip', 'PK')
    put(dir, 'task-1.decisions.json', [ROW])
    const [s, ...rest] = loadRun(root, id)
    assert.equal(rest.length, 0)
    assert.deepEqual([s.id, s.kind, s.status, s.outcome, s.red, s.source, s.controls], [`${id}:task-1`, 'task', 'ended', 'blocked', true, 'history', false])
    assert.equal(s.target.label, 'Chromium 1.64')
    assert.equal(s.endedAt - s.startedAt, 46000)
    assert.equal(s.secret, false, 'a kept trace means no secret fixture')
    assert.deepEqual(Object.keys(s.files).sort(), ['decisions', 'trace'], 'the missing screenshot is dropped')
    assert.deepEqual([s.trail[0].action, s.trail[0].by, s.trail[0].model], ['click button "Go"', 'claude', 'jev-1.13.0'])
    assert.equal(s.goal, null)
    assert.match(s.subline, /^task · 1 steps · 0:46 · blocked$/)
    const f = loadFrame(s, 1)
    assert.deepEqual([f.step, f.screenshot, f.elements.length, f.decision.label, f.decision.operations], [1, null, 1, 'click button "Go"', { CLICK: 1 }])
    assert.equal(loadFrame(s, 7), null)
  }))

test('a run with no trace that typed through a task is treated as secret; paths outside the run dir are dropped', () =>
  withRoot(({ root, run, put }) => {
    const id = '20261016-050000-aaaa'
    const dir = run(id)
    put(dir, 'result.json', { command: 'task', startedAt: '2026-10-16T05:00:00.000Z', durationMs: 1, flows: [{ id: 'f', outcome: 'done', steps: [], trace: null, decisions: '/etc/passwd', screenshot: null }] })
    const [s] = loadRun(root, id)
    assert.equal(s.secret, true)
    assert.deepEqual(s.files, {})
  }))

test('without result.json the run is incomplete', () =>
  withRoot(({ root, run, put }) => {
    const id = '20261016-060000-bbbb'
    put(run(id), 'solo.decisions.json', [ROW])
    const [s] = loadRun(root, id)
    assert.deepEqual([s.id, s.status, s.outcome, s.kind, s.steps], [`${id}:solo`, 'incomplete', null, 'flow', 1])
    assert.equal(s.startedAt, Date.parse('2026-10-16T06:00:00Z'))
  }))

test('session.json brings goal, kind, secret, frames and trail', () =>
  withRoot(({ root, run, put }) => {
    const id = '20261016-070000-cccc'
    const dir = run(id)
    put(dir, 'result.json', { command: 'explore', startedAt: '2026-10-16T07:00:00.000Z', durationMs: 9000, flows: [{ id: 'g1', outcome: 'pass', steps: [] }] })
    put(dir, 'g1.session.json', { v: 1, id: `${id}:g1`, kind: 'gate', name: 'g1', goal: 'Open the page', target: { kind: 'electron', label: 'Electron' }, secret: true, startedAt: 1, endedAt: 2, outcome: 'pass', history: [{ step: 1, action: 'click x', by: 'jev' }], frames: [{ i: 1, step: 1, url: 'u', title: 't', label: 'click x', p: 1, help: null, by: 'jev', shot: false, vision: false, box: false }] })
    const [s] = loadRun(root, id)
    assert.deepEqual([s.kind, s.goal, s.secret, s.target.kind, s.trail.length, s.frames.length, s.endedAt], ['gate', 'Open the page', true, 'electron', 1, 1, 2])
  }))

test('session.json brings the prompt group; a bad or missing one is null', () =>
  withRoot(({ root, run, put }) => {
    const id = '20261016-070100-dddd'
    const dir = run(id)
    put(dir, 'result.json', { command: 'task', startedAt: '2026-10-16T07:01:00.000Z', durationMs: 1000, flows: [{ id: 'a', outcome: 'done', steps: [] }, { id: 'b', outcome: 'done', steps: [] }, { id: 'c', outcome: 'done', steps: [] }] })
    put(dir, 'a.session.json', { v: 1, kind: 'task', group: 'pmgx1abcd' })
    put(dir, 'b.session.json', { v: 1, kind: 'task', group: 'bad group!' })
    assert.deepEqual(loadRun(root, id).map(s => s.group), ['pmgx1abcd', null, null])
  }))

test('invalid run dir names are ignored', () =>
  withRoot(({ root, run, put }) => {
    put(run('not-a-run'), 'result.json', { flows: [{ id: 'f', outcome: 'pass', steps: [] }] })
    put(run('20261016-080000-dddd'), 'result.json', { command: 'run', startedAt: '2026-10-16T08:00:00.000Z', durationMs: 1, flows: [{ id: 'f', outcome: 'pass', steps: [] }] })
    assert.deepEqual(listRuns(root).map(s => s.id), ['20261016-080000-dddd:f'])
    assert.deepEqual(loadRun(root, '../../etc'), [])
    assert.deepEqual(loadRun(root, 'not-a-run'), [])
    assert.deepEqual(listRuns(join(root, 'nowhere')), [])
  }))

test('a gate run with two flows gives two sessions with the right ids; listRuns is newest first and can page', () =>
  withRoot(({ root, run, put }) => {
    const a = '20261016-090000-eeee', b = '20261016-100000-ffff'
    put(run(a), 'result.json', { command: 'run', startedAt: '2026-10-16T09:00:00.000Z', durationMs: 1, flows: [{ id: 'one', outcome: 'pass', steps: [] }, { id: 'two', outcome: 'drift', steps: [] }] })
    put(run(b), 'result.json', { command: 'run', startedAt: '2026-10-16T10:00:00.000Z', durationMs: 1, flows: [{ id: 'three', outcome: 'pass', steps: [] }] })
    assert.deepEqual(loadRun(root, a).map(s => [s.id, s.red]), [[`${a}:one`, false], [`${a}:two`, true]])
    assert.deepEqual(listRuns(root).map(s => s.flowId), ['three', 'one', 'two'])
    assert.deepEqual(listRuns(root, { limit: 1 }).map(s => s.flowId), ['three'])
    assert.deepEqual(listRuns(root, { before: b }).map(s => s.flowId), ['one', 'two'])
  }))

test('the cache follows the run dir: a session.json written later shows up', () =>
  withRoot(({ root, run, put }) => {
    const id = '20261016-110000-1234'
    const dir = run(id)
    put(dir, 'result.json', { command: 'task', startedAt: '2026-10-16T11:00:00.000Z', durationMs: 1, flows: [{ id: 'f', outcome: 'done', steps: [], trace: join(dir, 'f.trace.zip') }] })
    assert.equal(loadRun(root, id)[0].goal, null)
    put(dir, 'f.session.json', { v: 1, goal: 'late', kind: 'task' })
    assert.equal(loadRun(root, id)[0].goal, 'late')
  }))
