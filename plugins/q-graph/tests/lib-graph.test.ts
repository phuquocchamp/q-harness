import { expect, test } from 'claude-code/testing'

import {
  LOST_MS,
  MAIN,
  agentUses,
  describeAgents,
  emptyGraph,
  formatElapsed,
  formatTokens,
  harnessFrom,
  harnessLines,
  hasLiveAgents,
  messageSent,
  needsYou,
  resolveRecipient,
  rosterAgents,
  ruleLoaded,
  spawnAgent,
  syncAgents,
  toolFinished,
  toolStarted,
  toolSummary,
  turnEnded,
  phaseKnown,
  phaseTitles,
  upsertRun,
  useKey,
  workflowName,
} from '../hooks/lib/graph'

const withExplore = () =>
  spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', model: 'claude-haiku', description: 'find verifyToken' }, 1000)

test('a spawned subagent hangs under main and runs', () => {
  const g = withExplore()
  expect(g.order).toEqual([MAIN, 'a1'])
  expect(g.agents.a1).toMatchObject({ parentId: MAIN, kind: 'subagent', label: 'Explore', status: 'running', startedAt: 1000 })
  expect(hasLiveAgents(g)).toBe(true)
})

test('an unknown parent falls back to main; a teammate is labelled by its address', () => {
  const g = spawnAgent(emptyGraph(), { id: 't1', parentId: 'nobody', isTeammate: true, type: 'teammate', name: 'backend', teammateId: 'backend@auth', description: '' }, 0)
  expect(g.agents.t1).toMatchObject({ parentId: MAIN, kind: 'teammate', label: 'backend@auth' })
})

test('tool calls are counted per tool and the current one is shown while it runs', () => {
  let g = toolStarted(withExplore(), 'a1', 'Grep')
  expect(g.agents.a1).toMatchObject({ toolCalls: 1, currentTool: 'Grep', tools: { Grep: 1 } })
  // Grep is still open while Read runs and ends: it is the current tool again.
  g = toolFinished(toolStarted(g, 'a1', 'Read'), 'a1', 'Read')
  expect(g.agents.a1).toMatchObject({ toolCalls: 2, currentTool: 'Grep', tools: { Grep: 1, Read: 1 } })
  g = toolFinished(g, 'a1', 'Grep')
  expect(g.agents.a1).toMatchObject({ currentTool: null })
  // toolFinished never adds an agent.
  expect(toolFinished(g, 'ghost', 'Bash')).toBe(g)
})

test('a subagent turn finishes it; the reason decides how', () => {
  const done = turnEnded(withExplore(), 'a1', { tokens: 9200, reason: 'answer' }, 39_000)
  expect(done.agents.a1).toMatchObject({ status: 'completed', tokens: 9200, endedAt: 39_000 })
  expect(hasLiveAgents(done)).toBe(false)
  expect(turnEnded(withExplore(), 'a1', { tokens: 0, reason: 'error' }, 1).agents.a1?.status).toBe('failed')
  expect(turnEnded(withExplore(), 'a1', { tokens: 0, reason: 'aborted' }, 1).agents.a1?.status).toBe('killed')
  expect(turnEnded(withExplore(), MAIN, { tokens: 10, reason: 'answer' }, 1).agents.main?.status).toBe('idle')
})

test('sync reports a subagent that starts waiting, and keeps a finished one finished', () => {
  const g = withExplore()
  const row = { id: 'a1', status: 'waiting' as const, type: 'Explore', description: 'find verifyToken' }
  const { graph, transitions } = syncAgents(g, [row], 5000)
  expect(transitions).toEqual([{ id: 'a1', from: 'running', to: 'waiting' }])
  // Held on its own background work: waiting, but not on the person.
  expect(needsYou(graph.agents.a1!)).toBe(false)

  const done = turnEnded(g, 'a1', { tokens: 1, reason: 'answer' }, 6000)
  expect(syncAgents(done, [{ ...row, status: 'running' }], 7000).transitions).toEqual([])
})

test('an agent needs you while it runs AskUserQuestion or ExitPlanMode, and main never does', () => {
  const asking = toolStarted(withExplore(), 'a1', 'AskUserQuestion', 7000)
  expect(needsYou(asking.agents.a1!)).toBe(true)
  expect(asking.agents.a1?.waitingSince).toBe(7000)
  const answered = toolFinished(asking, 'a1', 'AskUserQuestion')
  expect(needsYou(answered.agents.a1!)).toBe(false)
  expect(answered.agents.a1?.waitingSince).toBeNull()
  // The engine marks it waiting while the question is open; the question stays.
  const held = syncAgents(asking, [{ id: 'a1', status: 'waiting', type: 'Explore', description: '' }], 8000).graph
  expect(needsYou(held.agents.a1!)).toBe(true)
  expect(needsYou(toolStarted(emptyGraph(), 'main', 'AskUserQuestion').agents.main!)).toBe(false)
})

test('sync adds an agent no spawn hook saw', () => {
  const { graph, transitions } = syncAgents(emptyGraph(), [{ id: 'f1', status: 'running', type: 'fork', description: 'skill' }], 1)
  expect(graph.order).toContain('f1')
  expect(transitions).toEqual([])
})

test('messages resolve a teammate by address or bare name and count per direction', () => {
  let g = spawnAgent(emptyGraph(), { id: 't1', isTeammate: true, type: 'teammate', teammateId: 'backend@auth', description: '' }, 0)
  g = spawnAgent(g, { id: 't2', isTeammate: true, type: 'teammate', teammateId: 'tests@auth', description: '' }, 0)
  expect(resolveRecipient(g, 'backend@auth')).toBe('t1')
  expect(resolveRecipient(g, 'tests')).toBe('t2')
  expect(resolveRecipient(g, 'nobody')).toBeNull()
  g = messageSent(messageSent(g, 't1', 't2'), 't1', 't2')
  expect(g.messages).toEqual([{ from: 't1', to: 't2', count: 2 }])
})

test('the roster keeps finished agents for 30 seconds', () => {
  const done = turnEnded(withExplore(), 'a1', { tokens: 1, reason: 'answer' }, 10_000)
  expect(rosterAgents(done, 20_000).map(a => a.id)).toEqual(['a1'])
  expect(rosterAgents(done, 41_000)).toEqual([])
})

test('formatting and the status lines', () => {
  expect(formatElapsed(38_000)).toBe('38s')
  expect(formatElapsed(62_000)).toBe('1m02')
  expect(formatElapsed(3_900_000)).toBe('1h05')
  expect(formatTokens(950)).toBe('950')
  expect(formatTokens(14_200)).toBe('14.2k')
  const lines = describeAgents(toolStarted(withExplore(), 'a1', 'Grep'), 39_000)
  expect(lines[1]).toBe('  Explore · haiku · running Grep · 38s · 0 tok · 1 tools (Grep×1) · find verifyToken')
})

test('each agent keeps its own uses, in first-use order, lit while a call runs or just ended', () => {
  let g = spawnAgent(withExplore(), { id: 'a2', type: 'Plan', description: '' }, 0)
  g = toolStarted(g, MAIN, 'Bash', 100)
  g = toolStarted(g, 'a1', 'Grep', 1000)
  g = toolFinished(g, 'a1', 'Grep', 1100)
  g = toolStarted(g, 'a2', 'Read', 1200)
  g = toolStarted(g, 'a1', 'Read', 1300)
  const at = (id: string, now: number) => agentUses(g.agents[id]!, now).map(u => `${u.label}:${u.calls}:${u.isActive ? 'on' : 'off'}`)
  // Two agents reading are two uses, one under each card, not one shared node.
  expect(at('a1', 1500)).toEqual(['Grep:1:on', 'Read:1:on'])
  expect(at('a2', 1500)).toEqual(['Read:1:on'])
  expect(at(MAIN, 1500)).toEqual(['Bash:1:on'])
  // Grep finished at 1100 and glows for 1.2 s; Read is still running.
  expect(at('a1', 2400)).toEqual(['Grep:1:off', 'Read:1:on'])
})

test('a skill, an MCP server and a loaded rule are uses of their own kind; a spawn is not a use', () => {
  expect(useKey('Skill', { skill: 'commit' })).toBe('skill:commit')
  expect(useKey('mcp__context7__query-docs')).toBe('mcp:context7')
  expect(useKey('Agent')).toBeNull()
  expect(useKey('Bash')).toBe('Bash')
  let g = toolStarted(withExplore(), 'a1', 'Skill', 1000, useKey('Skill', { skill: 'commit' }))
  g = toolFinished(g, 'a1', 'Skill', 1100, 'skill:commit')
  g = toolStarted(g, 'a1', 'mcp__context7__query-docs', 1200, 'mcp:context7')
  g = toolFinished(g, 'a1', 'mcp__context7__query-docs', 1300, 'mcp:context7')
  g = toolStarted(g, 'a1', 'mcp__context7__resolve-library-id', 1400, 'mcp:context7')
  g = toolStarted(g, 'a1', 'Agent', 1500, null)
  g = ruleLoaded(g, 'a1', '/repo/.claude/rules/conventions.md', 1600)
  expect(agentUses(g.agents.a1!, 9000).map(u => `${u.kind}:${u.label}:${u.calls}`)).toEqual(['skill:commit:1', 'mcp:context7:2', 'rule:conventions.md:1'])
  expect(g.agents.a1).toMatchObject({ toolCalls: 4, currentTool: 'Agent', currentUse: null })
  expect(toolSummary(g.agents.a1!)).toBe('mcp context7×2 skill commit×1 rule conventions.md×1')
})

test('the harness card counts settings hooks per event, memory files, skills, MCP servers and agents', () => {
  const h = harnessFrom(
    { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command' }, { type: 'command' }] }], Stop: [{ hooks: [{ type: 'command' }] }], Bad: 'x' } },
    { memoryFiles: [{ path: '/home/me/.claude/CLAUDE.md' }, { path: '/repo/.claude/rules/docs.md' }], mcpTools: [{ serverName: 'context7' }, { serverName: 'context7' }, { serverName: 'linear' }], agents: [{}], skills: { totalSkills: 12 } },
  )
  expect(h).toEqual({ rules: ['/home/me/.claude/CLAUDE.md', '/repo/.claude/rules/docs.md'], hooks: { PreToolUse: 2, Stop: 1 }, skills: 12, mcpServers: ['context7', 'linear'], agents: 1 })
  expect(harnessLines(h)).toEqual(['rules 2: CLAUDE.md, docs.md', 'hooks 3: PreToolUse 2, Stop 1', 'skills 12', 'mcp 2: context7, linear', 'agents 1'])
  expect(harnessFrom({})).toEqual({ rules: [], hooks: {}, skills: 0, mcpServers: [], agents: 0 })
})

test('a finished subagent stays finished on a late tool call; a failed teammate runs again', () => {
  const done = turnEnded(withExplore(), 'a1', { tokens: 1, reason: 'answer' }, 5000)
  const late = toolStarted(done, 'a1', 'Read', 6000)
  expect(late.agents.a1).toMatchObject({ status: 'completed', endedAt: 5000, toolCalls: 1 })
  expect(hasLiveAgents(late)).toBe(false)
  for (const reason of ['error', 'aborted'] as const) expect(toolStarted(turnEnded(withExplore(), 'a1', { tokens: 0, reason }, 1), 'a1', 'Read', 2).agents.a1?.status).not.toBe('running')
  const team = spawnAgent(emptyGraph(), { id: 't1', isTeammate: true, type: 'teammate', teammateId: 'b@x', description: '' }, 0)
  const failed = turnEnded(team, 't1', { tokens: 0, reason: 'error' }, 1)
  expect(failed.agents.t1?.status).toBe('failed')
  expect(toolStarted(failed, 't1', 'Read', 2).agents.t1).toMatchObject({ status: 'running', endedAt: null })
  expect(turnEnded(team, 't1', { tokens: 0, reason: 'answer' }, 1).agents.t1?.status).toBe('idle')
})

test('calls in flight are tracked per agent: needs-you holds while any ask runs, the current tool is the latest open call', () => {
  let g = toolStarted(withExplore(), 'a1', 'AskUserQuestion', 100, null, 'u1')
  g = toolStarted(g, 'a1', 'Read', 200, 'Read', 'u2')
  g = toolStarted(g, 'a1', 'Grep', 300, 'Grep', 'u3')
  expect(g.agents.a1).toMatchObject({ currentTool: 'Grep', currentUse: 'Grep', waitingSince: 100 })
  expect(needsYou(g.agents.a1!)).toBe(true)
  // The latest call ends: the one before it is current again; the ask is still open.
  g = toolFinished(g, 'a1', 'Grep', 400, 'Grep', 'u3')
  expect(g.agents.a1).toMatchObject({ currentTool: 'Read', currentUse: 'Read' })
  g = toolFinished(g, 'a1', 'AskUserQuestion', 500, null, 'u1')
  expect(needsYou(g.agents.a1!)).toBe(false)
  expect(g.agents.a1).toMatchObject({ currentTool: 'Read', waitingSince: null })
  g = toolFinished(g, 'a1', 'Read', 600, 'Read', 'u2')
  expect(g.agents.a1).toMatchObject({ currentTool: null, currentUse: null, inFlight: [] })
})

test('without a tool-use id, calls of one tool are counted: each finish closes one', () => {
  let g = toolStarted(toolStarted(withExplore(), 'a1', 'Bash'), 'a1', 'Bash')
  g = toolFinished(g, 'a1', 'Bash')
  expect(g.agents.a1).toMatchObject({ currentTool: 'Bash' })
  g = toolFinished(g, 'a1', 'Bash')
  expect(g.agents.a1?.currentTool).toBeNull()
  // A finish with nothing open changes nothing.
  expect(toolFinished(g, 'a1', 'Bash').agents.a1?.inFlight).toEqual([])
})

test('a hook for an agent no spawn recorded makes a stub that the spawn merges into', () => {
  let g = toolStarted(emptyGraph(0), 'a9', 'Read', 500, 'Read', 'u1')
  expect(g.order).toEqual([MAIN, 'a9'])
  expect(g.agents.a9).toMatchObject({ parentId: MAIN, kind: 'subagent', type: 'unknown', status: 'running', toolCalls: 1, tools: { Read: 1 } })
  g = spawnAgent(g, { id: 'a9', parentId: MAIN, type: 'Explore', model: 'claude-haiku', description: 'scan' }, 900)
  expect(g.order).toEqual([MAIN, 'a9'])
  expect(g.agents.a9).toMatchObject({ type: 'Explore', label: 'Explore', description: 'scan', startedAt: 500, toolCalls: 1, tools: { Read: 1 }, status: 'running' })

  // A turn.complete that beat the spawn: the stub finished, and the spawn does not run it again.
  let late = turnEnded(emptyGraph(0), 'a8', { tokens: 70, reason: 'answer' }, 800)
  expect(late.agents.a8).toMatchObject({ type: 'unknown', status: 'completed', tokens: 70, endedAt: 800 })
  late = spawnAgent(late, { id: 'a8', type: 'Plan', description: 'x' }, 900)
  expect(late.agents.a8).toMatchObject({ type: 'Plan', status: 'completed', endedAt: 800, tokens: 70 })
})

test('an agent the engine no longer lists and no hook named for LOST_MS is lost, and any hook event brings it back', () => {
  const other = { id: 'other', status: 'running' as const, type: 'Explore', description: '' }
  const g = withExplore() // last event at 1000
  // Listed ones are never lost; an empty list says nothing; a quiet agent is not lost before the timeout.
  expect(syncAgents(g, [], 1000 + LOST_MS + 1).graph.agents.a1?.status).toBe('running')
  expect(syncAgents(g, [other], 1000 + LOST_MS - 1).graph.agents.a1?.status).toBe('running')
  expect(syncAgents(g, [{ ...other, id: 'a1' }], 1000 + LOST_MS + 1).graph.agents.a1?.status).toBe('running')

  const lost = syncAgents(g, [other], 1000 + LOST_MS).graph
  expect(lost.agents.a1).toMatchObject({ status: 'lost', endedAt: 1000 + LOST_MS })
  // Lost is not live, so the poll and the frames can stop.
  expect(hasLiveAgents(syncAgents(g, [{ ...other, status: 'idle' }], 1000 + LOST_MS).graph)).toBe(false)
  expect(describeAgents(lost, 1000 + LOST_MS)[1]).toMatch(/Explore · haiku · \? lost/)
  expect(rosterAgents(lost, 1000 + LOST_MS + 1).map(a => a.id)).toContain('a1')
  expect(rosterAgents(lost, 1000 + LOST_MS + 31_000).map(a => a.id)).not.toContain('a1')

  // Each hook event revives it; only turn.complete finishes it.
  expect(toolStarted(lost, 'a1', 'Read', 99_000).agents.a1).toMatchObject({ status: 'running', endedAt: null })
  expect(toolFinished(lost, 'a1', 'Read', 99_000).agents.a1?.status).toBe('running')
  expect(ruleLoaded(lost, 'a1', '/r/x.md', 99_000).agents.a1?.status).toBe('running')
  expect(turnEnded(lost, 'a1', { tokens: 0, reason: 'answer' }, 99_000).agents.a1?.status).toBe('completed')
  expect(turnEnded(lost, 'a1', { tokens: 0, reason: 'error' }, 99_000).agents.a1?.status).toBe('failed')
  // The revived agent is quiet for LOST_MS again before the next loss.
  const back = toolStarted(lost, 'a1', 'Read', 99_000)
  expect(syncAgents(toolFinished(back, 'a1', 'Read', 99_000), [other], 99_000 + LOST_MS - 1).graph.agents.a1?.status).toBe('running')
})

test('a call still in flight keeps a silent unlisted agent from being lost; a finished or main one never is', () => {
  const other = { id: 'other', status: 'running' as const, type: 'Explore', description: '' }
  const busy = toolStarted(withExplore(), 'a1', 'Bash', 1000, 'Bash', 'u1')
  expect(syncAgents(busy, [other], 500_000).graph.agents.a1?.status).toBe('running')
  const done = turnEnded(withExplore(), 'a1', { tokens: 0, reason: 'answer' }, 2000)
  expect(syncAgents(done, [other], 500_000).graph.agents.a1?.status).toBe('completed')
  expect(syncAgents(emptyGraph(0), [other], 500_000).graph.agents.main?.status).toBe('idle')
})

test('a parent that would make a cycle falls back to main, and the status lines still draw', () => {
  let g = withExplore()
  g = spawnAgent(g, { id: 'b1', parentId: 'a1', type: 'Explore', description: '' }, 0)
  g = spawnAgent(g, { id: 'a1', parentId: 'b1', type: 'Explore', description: '' }, 0)
  expect(g.agents.a1?.parentId).toBe(MAIN) // b1 sits under a1
  expect(g.agents.b1?.parentId).toBe('a1')
  g = spawnAgent(g, { id: 'b1', parentId: 'b1', type: 'Explore', description: '' }, 0)
  expect(g.agents.b1?.parentId).toBe(MAIN) // its own parent
  expect(describeAgents(g, 0)).toHaveLength(3)
})

// ---- Workflow runs ------------------------------------------------------------------------------

const wfAgent = (g: ReturnType<typeof emptyGraph>, id: string, i: number, now: number) =>
  spawnAgent(g, { id, parentId: 'wf_run1', type: 'workflow-subagent', description: `task ${i}`, runId: 'wf_run1', agentIndex: i }, now)

test('a workflow agent hangs under its run card, named by the label its script gave it', () => {
  let g = upsertRun(emptyGraph(0), { runId: 'wf_run1', parentId: MAIN, name: 'deep-research' }, 10)
  g = wfAgent(g, 'w1', 1, 11)
  g = wfAgent(g, 'w2', 2, 12)
  expect(g.agents.wf_run1).toMatchObject({ kind: 'workflow', parentId: MAIN, label: 'deep-research', status: 'running', progress: '0/2 agents' })
  expect(g.agents.w1).toMatchObject({ parentId: 'wf_run1', runId: 'wf_run1', agentIndex: 1, label: 'task 1', description: 'task 1' })
  expect(describeAgents(g, 20).slice(1)).toEqual([
    expect.stringMatching(/^ {2}deep-research · running 0\/2 agents · .* · workflow wf_run1$/),
    expect.stringMatching(/^ {4}task 1 · running · .* · task 1$/),
    expect.stringMatching(/^ {4}task 2 · running · .* · task 2$/),
  ])
})

test('a run finishes when its last agent does, with their tokens and calls summed', () => {
  let g = upsertRun(emptyGraph(0), { runId: 'wf_run1', name: 'deep-research' }, 10)
  g = wfAgent(g, 'w1', 1, 11)
  g = wfAgent(g, 'w2', 2, 12)
  g = toolStarted(g, 'w1', 'WebSearch', 13)
  g = turnEnded(g, 'w1', { tokens: 100, reason: 'answer' }, 20)
  expect(g.agents.wf_run1).toMatchObject({ status: 'running', progress: '1/2 agents', tokens: 100, toolCalls: 1 })
  expect(hasLiveAgents(g)).toBe(true)
  g = turnEnded(g, 'w2', { tokens: 50, reason: 'error' }, 30)
  expect(g.agents.wf_run1).toMatchObject({ status: 'completed', progress: '2/2 agents', tokens: 150, endedAt: 30 })
  expect(hasLiveAgents(g)).toBe(false)
})

test('a run whose every agent failed is failed', () => {
  let g = wfAgent(upsertRun(emptyGraph(0), { runId: 'wf_run1' }, 10), 'w1', 1, 11)
  g = turnEnded(g, 'w1', { tokens: 0, reason: 'error' }, 20)
  expect(g.agents.wf_run1).toMatchObject({ status: 'failed', label: 'wf_run1' })
})

test('a later name names a run that started without one; an existing run is not moved', () => {
  let g = upsertRun(emptyGraph(0), { runId: 'wf_run1', parentId: MAIN }, 10)
  g = upsertRun(g, { runId: 'wf_run1', parentId: 'elsewhere', name: 'audit' }, 11)
  expect(g.agents.wf_run1).toMatchObject({ label: 'audit', parentId: MAIN })
  expect(g.order.filter(id => id === 'wf_run1')).toHaveLength(1)
})

test('workflow agents and runs are never lost: the agent list does not carry them', () => {
  let g = wfAgent(upsertRun(emptyGraph(0), { runId: 'wf_run1' }, 0), 'w1', 1, 0)
  g = spawnAgent(g, { id: 'a1', type: 'Explore', description: 'x' }, 0)
  const { graph } = syncAgents(g, [{ id: 'a1', status: 'running', type: 'Explore', description: 'x' }], LOST_MS + 10_000)
  expect(graph.agents.w1!.status).toBe('running')
  expect(graph.agents.wf_run1!.status).toBe('running')
})

test('a Workflow call is not listed as a use; its name comes from name, the script meta or the script path', () => {
  expect(useKey('Workflow')).toBeNull()
  expect(workflowName({ name: 'deep-research' })).toBe('deep-research')
  expect(workflowName({ script: "export const meta = {\n  name: 'review-changes',\n  description: 'x' }" })).toBe('review-changes')
  expect(workflowName({ scriptPath: '/s/workflows/scripts/audit-wf_1.js' })).toBe('audit-wf_1')
  expect(workflowName({})).toBeUndefined()
})

test('the phases of a script are read in order, quoted keys or not', () => {
  const script = `export const meta = {
  name: 'rebase',
  phases: [{ title: 'Prep' }, {"title":"Resolve","detail":"6 [parallel] agents"}, { title: "Verify" }, { title: 'Review' }],
}
phase('x')`
  expect(phaseTitles(script)).toEqual(['Prep', 'Resolve', 'Verify', 'Review'])
  expect(phaseTitles("export const meta = { name: 'x' }")).toEqual([])
  expect(phaseTitles(undefined)).toEqual([])
})

test('agents move under their phase card; the run names the phase that runs, phases not reached are not started', () => {
  let g = upsertRun(emptyGraph(0), { runId: 'wf_run1', name: 'rebase-esaca-397', phases: ['Prep', 'Resolve', 'Verify'] }, 0)
  expect(describeAgents(g, 1).slice(1)).toEqual([
    expect.stringMatching(/^ {2}rebase-esaca-397 · running 0 agents/),
    expect.stringMatching(/^ {4}Prep · · not started/),
    expect.stringMatching(/^ {4}Resolve · · not started/),
    expect.stringMatching(/^ {4}Verify · · not started/),
  ])
  g = phaseKnown(wfAgent(g, 'p1', 1, 1), 'p1', 'Prep', 1)
  g = turnEnded(g, 'p1', { tokens: 10, reason: 'answer' }, 5)
  g = phaseKnown(wfAgent(g, 'r1', 2, 6), 'r1', 'Resolve', 6)
  g = phaseKnown(wfAgent(g, 'r2', 3, 6), 'r2', 'Resolve', 6)
  g = turnEnded(g, 'r1', { tokens: 20, reason: 'answer' }, 9)
  expect(g.agents.r1!.parentId).toBe('wf_run1.Resolve')
  expect(g.agents['wf_run1.Prep']).toMatchObject({ status: 'completed', progress: '1/1', tokens: 10 })
  expect(g.agents['wf_run1.Resolve']).toMatchObject({ status: 'running', progress: '1/2', tokens: 20 })
  expect(g.agents['wf_run1.Verify']).toMatchObject({ status: 'idle' })
  expect(g.agents.wf_run1).toMatchObject({ status: 'running', progress: '2/3 agents · Resolve', tokens: 30 })
  g = turnEnded(g, 'r2', { tokens: 5, reason: 'answer' }, 12)
  expect(g.agents['wf_run1.Resolve']).toMatchObject({ status: 'completed', progress: '2/2' })
  expect(g.agents.wf_run1).toMatchObject({ status: 'completed', progress: '3/3 agents' })
  expect(hasLiveAgents(g)).toBe(false)
})

test('a phase the script did not declare gets its card when an agent names it', () => {
  let g = wfAgent(upsertRun(emptyGraph(0), { runId: 'wf_run1' }, 0), 'w1', 1, 1)
  g = phaseKnown(g, 'w1', 'Ad hoc', 2)
  expect(g.agents['wf_run1.Ad_hoc']).toMatchObject({ kind: 'workflow', type: 'phase', label: 'Ad hoc', parentId: 'wf_run1', status: 'running', progress: '0/1' })
  expect(phaseKnown(g, 'nope', 'X', 3)).toBe(g)
})
