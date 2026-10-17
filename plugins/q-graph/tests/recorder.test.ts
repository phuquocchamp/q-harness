import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { emptyGraph, harnessFrom, messageSent, ruleLoaded, setHarness, spawnAgent, syncAgents, toolFinished, toolStarted, turnEnded, useKey } from '../hooks/lib/graph'
import { endTurn, fakeHost, run, spawn, start } from './host'

test('the harness is read at session start: settings hooks, memory files, skills and MCP servers', async ($, on) => {
  fakeHost(on)
  await start($)
  expect((await run($, 'status')).text).toMatch(/^harness · rules 1: CLAUDE\.md · hooks 1: PreToolUse 1 · skills 12 · mcp 1: context7 · agents 0$/m)
})

test('a spawn is recorded with its type, model and task, and its turn finishes it', async ($, on) => {
  fakeHost(on)
  await start($)
  expect((await run($, 'status')).text).toMatch(/No subagents/)

  const r = await spawn($, 'Explore', 'find verifyToken')
  expect(r).toMatchObject({ agentId: 'a1' })
  expect((await run($, 'status')).text).toMatch(/^ {2}Explore · haiku · running · .* · find verifyToken$/m)

  await endTurn($, 'a1', 9200)
  expect((await run($, 'status')).text).toMatch(/Explore · haiku · ✓ done · .* · 9\.2k tok/)
})

test('a failed subagent raises a toast and a notification; waiting on its own work raises nothing', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await spawn($, 'Plan', 'draft migration')
  host.agents.push({ id: 'a1', description: 'draft migration', type: 'Plan', status: 'waiting' })
  await host.clock.advance(1000)
  await host.clock.advance(1000)
  expect(host.toasts).toEqual([])
  expect((await run($, 'status')).text).toMatch(/Plan · haiku · ⏸ waiting/)

  host.agents[0] = { ...host.agents[0]!, status: 'failed' }
  await host.clock.advance(1000)
  expect(host.toasts).toEqual(['q-graph: Plan failed'])
  expect(host.notes).toEqual(['Plan failed: draft migration'])
})

test('the token count leaves cache reads out', async ($, on) => {
  fakeHost(on)
  await start($)
  await spawn($, 'Explore', 'scan')
  await $.turn.complete({
    answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer',
    usage: { input_tokens: 1000, output_tokens: 500, cache_read_input_tokens: 900_000, cache_creation_input_tokens: 2000, model: 'claude-haiku' },
  } as Parameters<typeof $.turn.complete>[0])
  expect((await run($, 'status')).text).toMatch(/ 3\.5k tok/)
})

test('notify off keeps the toast and drops the notification', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'notify off')).text).toBe('notify off.')
  expect(host.store.get('settings')).toEqual({ band: true, notify: false })
  await spawn($, 'Explore', 'scan')
  await endTurn($, 'a1', 0, 'error')
  expect(host.toasts).toEqual(['q-graph: Explore failed'])
  expect(host.notes).toEqual([])
})

test('the band shows each live agent and hides when there is none', async ($, on) => {
  fakeHost(on)
  // The engine's own band, drawn when q-graph hands the band on.
  on('ui.render', { component: 'AbovePrompt' }, (hook$, e) => {
    const { Text } = hook$.ui.resolve(e)
    return h(Text, {}, 'engine band') as never
  })
  await start($)
  const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 100 }
  const empty = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'AbovePrompt', props } as Parameters<typeof $.ui.mount>[0])
  expect(await empty.find({ type: 'Text', text: /Explore/ })).toBeUndefined()
  expect(await empty.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await empty.unmount()

  await spawn($, 'Explore', 'scan')
  const band = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'AbovePrompt', props } as Parameters<typeof $.ui.mount>[0])
  expect(await band.find({ type: 'Text', text: /^Explore$/ })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'open-graph' })).toBeDefined()
  await band.unmount()
})

test('the band folds what does not fit into a +N more button that lists every agent when pressed', async ($, on) => {
  fakeHost(on)
  await start($)
  for (const t of ['Explore', 'Plan', 'general-purpose', 'code-reviewer', 'test-runner']) await spawn($, t, 'work')
  const props = { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 60 }
  const band = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'AbovePrompt', props } as Parameters<typeof $.ui.mount>[0])
  expect(await band.find({ type: 'Text', text: /^test-runner$/ })).toBeUndefined()
  expect(await band.find({ type: 'Button', key: 'band-all' })).toBeDefined()
  await band.press({ key: 'band-all' })
  for (const t of ['Explore', 'Plan', 'general-purpose', 'code-reviewer', 'test-runner']) expect(await band.find({ type: 'Text', text: new RegExp(`^${t}$`) })).toBeDefined()
  expect(await band.find({ type: 'Button', key: 'band-all' })).toBeUndefined()
  await band.press({ key: 'band-fold' })
  expect(await band.find({ type: 'Button', key: 'band-all' })).toBeDefined()
  await band.unmount()
})

test('the pane draws a Raster in the terminal and text elsewhere', async ($, on) => {
  fakeHost(on)
  await start($)
  await spawn($, 'Explore', 'scan')
  const pane = { title: 'q-graph', isFocused: false, bodyColumns: 100, placement: 'dock' }

  const term = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'Pane', requestId: 'q-graph', props: pane } as Parameters<typeof $.ui.mount>[0])
  expect(await term.find({ type: 'Raster', key: 'graph-0' })).toBeDefined()
  expect(await term.find({ type: 'Text', text: /1 agents · 1 running/ })).toBeDefined()
  await term.unmount()

  const desk = await $.ui.mount({ plugin: 'q-graph', surface: 'desktop', component: 'Pane', requestId: 'q-graph', props: pane } as Parameters<typeof $.ui.mount>[0])
  expect(await desk.find({ type: 'Raster' })).toBeUndefined()
  expect(await desk.find({ type: 'Text', text: /Explore · haiku · running/ })).toBeDefined()
  await desk.unmount()
})

test('/q-graph validates its toggles and answers help', async ($, on) => {
  fakeHost(on)
  expect(await run($, 'band maybe')).toMatchObject({ exitCode: 2 })
  expect(await run($, 'frobnicate')).toMatchObject({ exitCode: 2 })
  expect((await run($, 'help')).text).toMatch(/band on\|off/)
  await run($, 'band off')
  expect((await run($, 'config')).text).toMatch(/band\s+off/)
})

test('the engine takes every glyph the pane draws, for every status and at every dot frame', async ($, on) => {
  let g = emptyGraph(0)
  const add = (id: string, type: string, extra: Partial<Parameters<typeof spawnAgent>[1]> = {}) => {
    g = spawnAgent(g, { id, type, model: 'claude-haiku', description: type, ...extra }, 0)
  }
  add('run', 'Explore')
  add('ask', 'Plan')
  add('done', 'Explore')
  add('fail', 'Explore')
  add('kill', 'Explore')
  add('held', 'general-purpose')
  add('nest', 'Explore', { parentId: 'run' })
  add('t1', 'teammate', { isTeammate: true, teammateId: 'backend@auth' })
  add('t2', 'teammate', { isTeammate: true, teammateId: 'tests@auth' })
  g = toolStarted(g, 'run', 'Grep', 0)
  // Every kind of use, more than fit under one card, and the harness card.
  for (const t of ['Read', 'Glob', 'Bash', 'Edit']) g = toolFinished(toolStarted(g, 'run', t, 0), 'run', t, 0)
  g = toolStarted(g, 'nest', 'Skill', 0, useKey('Skill', { skill: 'commit' }))
  g = toolStarted(g, 'nest', 'mcp__context7__query-docs', 0, useKey('mcp__context7__query-docs'))
  g = ruleLoaded(g, 'nest', '/repo/.claude/rules/conventions.md', 0)
  g = toolStarted(g, 'run', 'Grep', 0)
  g = setHarness(g, harnessFrom({ hooks: { PreToolUse: [{ hooks: [{}] }] } }, { memoryFiles: [{ path: '/repo/CLAUDE.md' }], mcpTools: [{ serverName: 'context7' }], skills: { totalSkills: 3 } }))
  g = toolStarted(g, 'ask', 'AskUserQuestion', 0)
  g = turnEnded(g, 'done', { tokens: 9200, reason: 'answer' }, 1000)
  g = turnEnded(g, 'fail', { tokens: 10, reason: 'error' }, 1000)
  g = turnEnded(g, 'kill', { tokens: 10, reason: 'aborted' }, 1000)
  g = syncAgents(g, [{ id: 'held', status: 'waiting', type: 'general-purpose', description: '' }, { id: 't2', status: 'idle', type: 'teammate', description: '' }], 1000).graph
  g = messageSent(messageSent(g, 't1', 't2'), 't2', 't1')
  // Answer the plugin's reads of its graph with every status at once (the test's $ has no state noun).
  const seeded = g
  on('state.get', (_$, e, next) => (e.plugin === 'q-graph' && e.key === 'graph' ? ({ value: { value: seeded, version: 1 } } as never) : next(e)))
  const host = fakeHost(on)
  await start($)

  const pane = { title: 'q-graph', isFocused: false, bodyColumns: 120, placement: 'dock' }
  for (let frame = 0; frame < 18; frame++) {
    const ui = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'Pane', requestId: 'q-graph', props: pane } as Parameters<typeof $.ui.mount>[0])
    expect(await ui.find({ type: 'Raster', key: 'graph-0' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /9 agents · 4 running · 1 need you/ })).toBeDefined()
    await ui.unmount()
    await host.clock.advance(150)
  }
})

const READY = { ready: true, port: 4321, file: '/tmp/q-graph-test/snapshot.json', token: 'tok' }

/** A tool.call engine whose calls stay open until the test releases them by tool-use id. */
const heldCalls = (on: On) => {
  const gates = new Map<string, () => void>()
  on('tool.call', async (_$, e) => {
    await new Promise<void>(resolve => gates.set(e.tool_use_id ?? '', resolve))
    return { result: 'ok', text: 'ok' } as never
  })
  return {
    call: ($: Engine, agentId: string, tool: string, id: string) => $.tool.call({ tool, tool_use_id: id, agentId } as never),
    release: (id: string) => gates.get(id)?.(),
  }
}
const statusOf = async ($: Engine, label: string) => (await run($, 'status')).text.split('\n').find(l => l.trim().startsWith(label)) ?? ''

test('two concurrent /q-graph web calls start one viewer', async ($, on) => {
  const argvs: string[][] = []
  let open: () => void = () => {}
  const gate = new Promise<void>(resolve => (open = resolve))
  on('process.spawn', async function* (_$, e) {
    argvs.push([...e.argv])
    await gate
    yield { stream: 'stdout' as const, text: `${JSON.stringify(READY)}\n` }
    await new Promise<void>(() => {})
    return { value: { code: 0, signal: null } }
  })
  on('fs.write', () => ({ value: undefined }))
  fakeHost(on)
  await start($)
  const both = Promise.all([run($, 'web'), run($, 'web')])
  await Promise.resolve()
  open()
  const [a, b] = await both
  expect(argvs).toHaveLength(1)
  expect(a.text).toBe('q-graph live viewer: http://127.0.0.1:4321/?k=tok')
  expect(b.text).toBe(a.text)
})

test('a viewer that exits before printing its address is reported as that, and the next runtime is tried', async ($, on) => {
  const argvs: string[] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push(e.argv[0]!)
    return { value: { code: 1, signal: null } }
  })
  fakeHost(on)
  await start($)
  const r = await run($, 'web')
  expect(argvs).toEqual(['node', 'bun'])
  expect(r).toMatchObject({ exitCode: 1 })
  expect(r.text).toMatch(/node: exited before printing its address; bun: exited before printing its address/)
})

test('subcommands are case-insensitive; an unknown subcommand or argument prints usage with exit code 2 and starts nothing', async ($, on) => {
  const spawned: string[] = []
  on('process.spawn', async function* (_$, e) {
    spawned.push(e.argv[0]!)
    return { value: { code: 0, signal: null } }
  })
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'BAND Off')).text).toBe('band off.')
  expect(host.store.get('settings')).toEqual({ band: false, notify: true })
  for (const args of ['web --stop', 'web stop now', 'open --bogus', 'status --verbose', 'close x', 'config x', 'help me', 'band on now']) {
    const r = await run($, args)
    expect(r.exitCode, args).toBe(2)
    expect(r.text, args).toMatch(/Usage: \/q-graph/)
  }
  expect(spawned).toEqual([])
  expect((await run($, 'web stop')).text).toBe('q-graph live viewer stopped.')
})

test('a usage block without cache fields counts as zero, not NaN', async ($, on) => {
  fakeHost(on)
  await start($)
  await spawn($, 'Explore', 'scan')
  await $.turn.complete({
    answer: 'ok', durationMs: 1, isAborted: false, turnId: 't', agentId: 'a1', reason: 'answer',
    usage: { input_tokens: 1000, output_tokens: 500, model: 'claude-haiku' },
  } as never)
  expect(await statusOf($, 'Explore')).toMatch(/ 1\.5k tok/)
})

test('an ask and another call in flight at once: the agent needs you until the ask ends, whichever call ends first', async ($, on) => {
  const host = fakeHost(on)
  const held = heldCalls(on)
  await start($)
  await spawn($, 'Explore', 'scan')
  const ask = held.call($, 'a1', 'AskUserQuestion', 'u1')
  const read = held.call($, 'a1', 'Read', 'u2')
  await host.clock.advance(0)
  expect(await statusOf($, 'Explore')).toMatch(/needs you \(AskUserQuestion\)/)
  held.release('u2')
  await read
  expect(await statusOf($, 'Explore')).toMatch(/needs you/)
  held.release('u1')
  await ask
  expect(await statusOf($, 'Explore')).not.toMatch(/needs you/)
})

test('a tool call from an agent before its spawn is recorded is kept and merged into the spawn', async ($, on) => {
  const host = fakeHost(on)
  const held = heldCalls(on)
  await start($)
  const call = held.call($, 'a1', 'Read', 'u1')
  await host.clock.advance(0)
  expect(await statusOf($, 'a1')).toMatch(/^ {2}a1 .*running Read/)
  await spawn($, 'Explore', 'scan')
  expect(await statusOf($, 'Explore')).toMatch(/running Read .*1 tools \(Read×1\) · scan/)
  held.release('u1')
  await call
  await endTurn($, 'a1', 5)
  expect(await statusOf($, 'Explore')).toMatch(/✓ done/)
})

test('an unlisted agent silent past the timeout is lost and shown as such; a tool call brings it back and restarts the poll', async ($, on) => {
  const host = fakeHost(on)
  const held = heldCalls(on)
  await start($)
  await spawn($, 'Explore', 'scan')
  // The engine lists some other agent only: a1 is absent.
  host.agents.push({ id: 'other', description: '', type: 'Plan', status: 'running' })
  await host.clock.advance(44_000)
  expect(await statusOf($, 'Explore')).toMatch(/running/)
  await host.clock.advance(3000)
  expect(await statusOf($, 'Explore')).toMatch(/\? lost/)

  host.agents[0] = { ...host.agents[0]!, status: 'idle' }
  await host.clock.advance(2000) // nothing live: the poll stops
  const call = held.call($, 'a1', 'Read', 'u1')
  await host.clock.advance(0)
  expect(await statusOf($, 'Explore')).toMatch(/running Read/)
  // The restarted poll sees the engine's failure of a1 (it is listed again).
  host.agents.push({ id: 'a1', description: 'scan', type: 'Explore', status: 'failed' })
  await host.clock.advance(1000)
  expect(host.toasts).toContain('q-graph: Explore failed')
  held.release('u1')
  await call
})

test('a failed write of the viewer snapshot is retried; a missing transcript is looked up once per few seconds', async ($, on) => {
  let writes = 0
  let fail = true
  let exists = 0
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify(READY)}\n` }
    await new Promise<void>(() => {})
    return { value: { code: 0, signal: null } }
  })
  on('fs.write', () => {
    writes++
    return fail ? { deny: 'disk full' } : { value: undefined }
  })
  on('fs.exists', () => {
    exists++
    return { value: false }
  })
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.root', () => ({ value: '/repo' }))
  on('session.id', () => ({ value: 'sess-1' }))
  const host = fakeHost(on)
  await start($)
  await run($, 'web')
  await host.clock.advance(900)
  const failedWrites = writes
  expect(failedWrites).toBeGreaterThanOrEqual(3)
  // The same snapshot is written again on every tick until a write succeeds.
  fail = false
  await host.clock.advance(300)
  expect(writes).toBe(failedWrites + 1)
  await host.clock.advance(900)
  expect(writes).toBe(failedWrites + 1)
  expect(exists).toBe(1)
  await host.clock.advance(5000)
  expect(exists).toBe(2)
})
