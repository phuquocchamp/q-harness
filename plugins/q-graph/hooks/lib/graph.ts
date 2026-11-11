// The session graph: one node per agent loop (main, subagents, teammates) and the messages between
// them. Pure reducers, so every hook in register.tsx is a one-line update and everything is testable.

import type { AgentKind, AgentNode, Harness, InFlightCall, NodeStatus, SessionGraph, UseKind } from '../../types'

export const MAIN = 'main'

/** How long a finished agent stays on the band. */
export const RECENT_MS = 30_000

const DONE: ReadonlySet<NodeStatus> = new Set(['completed', 'failed', 'killed'])

export const isDone = (s: NodeStatus) => DONE.has(s)

/** How long a live agent may be absent from the engine's list and silent before it counts as lost. */
export const LOST_MS = 45_000

const LIVE: ReadonlySet<NodeStatus> = new Set(['running', 'waiting', 'pending'])

/** Tools that hold an agent until the person (or the lead, for a teammate's plan) answers. */
export const ASK_TOOLS: ReadonlySet<string> = new Set(['AskUserQuestion', 'ExitPlanMode'])

/**
 * True while an agent other than main waits on an answer. The engine's own `waiting` status is not
 * enough: it also covers an agent held on its background work or on a child agent.
 */
export const needsYou = (a: AgentNode) => a.kind !== 'main' && askingTool(a) !== undefined

/** The ask tool an agent has open (the latest one), or undefined. */
export const askingTool = (a: AgentNode): string | undefined => (a.inFlight ?? []).findLast(c => ASK_TOOLS.has(c.tool))?.tool

const mainNode = (now: number): AgentNode => ({
  id: MAIN,
  parentId: null,
  kind: 'main',
  type: 'main',
  label: 'main',
  model: '',
  description: '',
  status: 'idle',
  startedAt: now,
  endedAt: null,
  waitingSince: null,
  tokens: 0,
  toolCalls: 0,
  tools: {},
  currentTool: null,
  currentUse: null,
  inFlight: [],
  lastEventAt: now,
  toolAt: {},
})

export const emptyGraph = (now = 0): SessionGraph => ({ agents: { [MAIN]: mainNode(now) }, order: [MAIN], messages: [], harness: null })

/** How long a tool's edge stays lit after a call starts or ends, so a fast call is still seen. */
export const TOOL_GLOW_MS = 1200

/** The graph with one agent replaced; an unknown id leaves it as it is. */
const patch = (g: SessionGraph, id: string, fn: (a: AgentNode) => AgentNode): SessionGraph => {
  const a = g.agents[id]
  return a ? { ...g, agents: { ...g.agents, [id]: fn(a) } } : g
}

/**
 * The graph with agent `id` present: one a hook names before `agent.spawn` has recorded it gets a
 * stub (under main, type `unknown`) that the later spawn merges into.
 */
const withAgent = (g: SessionGraph, id: string, now: number): SessionGraph =>
  g.agents[id]
    ? g
    : { ...g, agents: { ...g.agents, [id]: { ...mainNode(now), id, parentId: MAIN, kind: 'subagent', type: 'unknown', label: id, status: 'running' } }, order: [...g.order, id] }

/** A hook named this agent: a lost one runs again, and a finished subagent stays finished. */
const heard = (a: AgentNode, now: number): AgentNode =>
  a.status === 'lost' ? { ...a, status: 'running', endedAt: null, lastEventAt: now } : { ...a, lastEventAt: now }

export type Spawned = {
  id: string
  parentId?: string | null
  isTeammate?: boolean
  type: string
  name?: string
  teammateId?: string
  model?: string
  description: string
  /** Set when a Workflow run's `agent()` started it: the run's card is its parent. */
  runId?: string
  agentIndex?: number
}

export const labelFor = (s: Pick<Spawned, 'type' | 'name' | 'teammateId'>) => s.teammateId ?? s.name ?? s.type

/** True when `id` is `ancestor` or sits somewhere under it. */
const isUnder = (g: SessionGraph, id: string, ancestor: string): boolean => {
  const seen = new Set<string>()
  for (let cur: string | null | undefined = id; cur && !seen.has(cur); cur = g.agents[cur]?.parentId) {
    if (cur === ancestor) return true
    seen.add(cur)
  }
  return false
}

export const spawnAgent = (g: SessionGraph, s: Spawned, now: number): SessionGraph => {
  // A parent that is the agent itself or one of its descendants would make a cycle: main takes it.
  const parentId = s.parentId && g.agents[s.parentId] && !isUnder(g, s.parentId, s.id) ? s.parentId : MAIN
  const kind: AgentKind = s.isTeammate ? 'teammate' : 'subagent'
  const prev = g.agents[s.id]
  const run = s.runId ? { runId: s.runId, ...(s.agentIndex ? { agentIndex: s.agentIndex } : {}) } : {}
  // A stub that already finished (its turn.complete beat this spawn) stays finished.
  const settled = prev && prev.type === 'unknown' && isDone(prev.status)
  const node: AgentNode = {
    ...(prev ?? mainNode(now)),
    id: s.id,
    parentId,
    kind,
    type: s.type,
    label: s.runId ? workflowAgentLabel(s) : labelFor(s),
    model: s.model ?? prev?.model ?? '',
    description: s.description,
    ...run,
    status: settled ? prev.status : 'running',
    startedAt: prev?.startedAt ?? now,
    endedAt: settled ? prev.endedAt : null,
    waitingSince: null,
    lastEventAt: now,
  }
  return settleRuns({ ...g, agents: { ...g.agents, [s.id]: node }, order: prev ? g.order : [...g.order, s.id] }, now)
}

// ---- Workflow runs ---------------------------------------------------------------------------------

/** The tool that starts a Workflow run; its agents hang under the run's own card. */
export const WORKFLOW_TOOL = 'Workflow'

/** A run id as the engine mints it (`wf_…`); anything else is not filed as a run. */
export const RUN_ID = /^wf_[A-Za-z0-9_-]{1,120}$/

/**
 * A workflow agent's card name: the label its script gave it (`resolve:renderer#1`, as Claude Code's
 * own workflow view shows it), else its name, else its place in the run (`agent #3`).
 */
const workflowAgentLabel = (s: Pick<Spawned, 'type' | 'name' | 'agentIndex' | 'description'>) => {
  const label = s.description.split('\n')[0]!.trim()
  if (label) return label.length > 60 ? `${label.slice(0, 59)}…` : label
  return s.name ?? `${s.type === 'workflow-subagent' || !s.type ? 'agent' : s.type}${s.agentIndex ? ` #${s.agentIndex}` : ''}`
}

/**
 * The name a Workflow call runs under: its `name` (a saved workflow), else the `name` in its script's
 * `meta`, else its `scriptPath`'s file name; undefined when none is given.
 */
export const workflowName = (input: { name?: unknown; script?: unknown; scriptPath?: unknown }): string | undefined => {
  if (typeof input.name === 'string' && input.name) return input.name
  if (typeof input.script === 'string') {
    const m = /export\s+const\s+meta\s*=\s*\{[\s\S]*?\bname\s*:\s*(['"`])([^'"`\n]{1,80})\1/.exec(input.script)
    if (m) return m[2]
  }
  if (typeof input.scriptPath === 'string' && input.scriptPath) return baseName(input.scriptPath).replace(/\.[cm]?[jt]s$/, '')
  return undefined
}

/** Phases a run lists at most; a longer list keeps its first ones. */
const MAX_PHASES = 24

/**
 * The phase titles a Workflow script declares, in order: `meta.phases[].title`. Empty when the script
 * declares none (its agents' phases still show up as they run).
 */
export const phaseTitles = (script: unknown): string[] => {
  if (typeof script !== 'string') return []
  const meta = /export\s+const\s+meta\s*=\s*\{/.exec(script)
  if (!meta) return []
  const at = script.slice(meta.index).search(/["']?phases["']?\s*:\s*\[/)
  if (at < 0) return []
  const list = script.slice(meta.index + at)
  const close = list.search(/\]\s*,?\s*(\n|\})/)
  const body = close > 0 ? list.slice(0, close) : list.slice(0, 4000)
  const titles: string[] = []
  for (const m of body.matchAll(/["']?title["']?\s*:\s*(['"`])((?:(?!\1)[^\n\\]){1,60})\1/g)) {
    if (!titles.includes(m[2]!)) titles.push(m[2]!)
    if (titles.length >= MAX_PHASES) break
  }
  return titles
}

/** A phase card's id: its run's id and its title, in the characters an agent id may hold. */
export const phaseId = (runId: string, title: string) => `${runId}.${title.replace(/[^A-Za-z0-9_-]/g, '_').slice(0, 40) || 'phase'}`

/** True for a phase card (a workflow-kind node of type `phase`). */
export const isPhase = (a: AgentNode) => a.kind === 'workflow' && a.type === 'phase'

const runNode = (id: string, parentId: string, runId: string, label: string, type: 'workflow' | 'phase', now: number): AgentNode => ({
  ...mainNode(now),
  id,
  parentId,
  kind: 'workflow',
  type,
  label,
  description: type === 'workflow' ? `workflow ${runId}` : '',
  status: type === 'workflow' ? 'running' : 'idle',
  runId,
  progress: type === 'workflow' ? '0 agents' : '',
})

export type RunStart = { runId: string; parentId?: string | null; name?: string; phases?: readonly string[] }

/**
 * The graph with run `runId`'s card present: a new one under `parentId` (the loop that made the
 * Workflow call, else main), or the one there, named once a name is known; and a phase card for each
 * of `phases` not there yet, in order, not started until an agent of it runs.
 */
export const upsertRun = (g: SessionGraph, r: RunStart, now: number): SessionGraph => {
  const prev = g.agents[r.runId]
  let out = g
  if (!prev) {
    const parentId = r.parentId && g.agents[r.parentId] ? r.parentId : MAIN
    out = { ...g, agents: { ...g.agents, [r.runId]: runNode(r.runId, parentId, r.runId, r.name ?? r.runId, 'workflow', now) }, order: [...g.order, r.runId] }
  } else if (r.name && prev.label === r.runId) out = patch(g, r.runId, a => ({ ...a, label: r.name! }))
  for (const title of r.phases ?? []) out = withPhase(out, r.runId, title, now)
  return out
}

/** The graph with the card of phase `title` of run `runId` present (the run must be there). */
const withPhase = (g: SessionGraph, runId: string, title: string, now: number): SessionGraph => {
  const id = phaseId(runId, title)
  if (g.agents[id] || !g.agents[runId]) return g
  return { ...g, agents: { ...g.agents, [id]: runNode(id, runId, runId, title, 'phase', now) }, order: [...g.order, id] }
}

/**
 * Agent `id` of a Workflow run is in phase `title` (from its meta file): it moves under that phase's
 * card, made when the script did not declare the phase. An agent outside a run is left as it is.
 */
export const phaseKnown = (g: SessionGraph, id: string, title: string, now: number): SessionGraph => {
  const a = g.agents[id]
  if (!a?.runId || a.kind === 'workflow' || !title || !g.agents[a.runId]) return g
  const withCard = withPhase(g, a.runId, title, now)
  return settleRuns(patch(withCard, id, x => ({ ...x, phase: title, parentId: phaseId(a.runId!, title) })), now)
}

/**
 * Each run's and phase's card from its agents: running while one of them is live, else completed
 * (failed only when every agent failed); tokens and calls summed; progress `done/total`, and on the
 * run also the phase that runs now. A card with no agent yet keeps what it has (a phase stays not
 * started). Phases are settled before their run. Returns `g` itself when nothing changed.
 */
export const settleRuns = (g: SessionGraph, now: number): SessionGraph => {
  const cards = g.order.map(id => g.agents[id]).filter((a): a is AgentNode => !!a && a.kind === 'workflow')
  if (cards.length === 0) return g
  let out = g
  for (const card of [...cards.filter(isPhase), ...cards.filter(c => !isPhase(c))]) {
    const phase = isPhase(card)
    const kids = g.order
      .map(k => g.agents[k])
      .filter((a): a is AgentNode => !!a && a.kind !== 'workflow' && a.runId === card.runId && (!phase || a.phase === card.label))
    if (kids.length === 0) continue
    const live = kids.some(a => LIVE.has(a.status))
    const ended = kids.filter(a => isDone(a.status) || a.status === 'lost')
    const status: NodeStatus = live ? 'running' : kids.every(a => a.status === 'failed') ? 'failed' : 'completed'
    // The run names the phase that runs now: the last one, in order, with a live agent.
    const current = phase ? undefined : [...cards].reverse().find(c => isPhase(c) && c.runId === card.runId && out.agents[c.id]?.status === 'running')?.label
    const next = {
      status,
      endedAt: live ? null : Math.max(...kids.map(a => a.endedAt ?? a.lastEventAt ?? now)),
      tokens: kids.reduce((n, a) => n + a.tokens, 0),
      toolCalls: kids.reduce((n, a) => n + a.toolCalls, 0),
      progress: `${ended.length}/${kids.length}${phase ? '' : ' agents'}${live && current ? ` · ${current}` : ''}`,
      startedAt: Math.min(...(phase ? [] : [card.startedAt]), ...kids.map(a => a.startedAt)),
    }
    if (Object.entries(next).every(([k, v]) => card[k as keyof AgentNode] === v)) continue
    out = patch(out, card.id, a => ({ ...a, ...next, lastEventAt: now }))
  }
  return out
}

/** A run's or phase's status line: `✓ done 6/6`, `running 4/6`, or `· not started` for a phase none of whose agents ran yet. */
export const runStatusText = (a: AgentNode): string =>
  a.status === 'idle' ? '· not started' : a.status === 'running' ? `running ${a.progress ?? ''}`.trim() : `${STATUS_TEXT[a.status]}${a.progress ? ` ${a.progress}` : ''}`

/** The main loop starts a turn; its clock starts at the session's first prompt. */
export const promptSubmitted = (g: SessionGraph, now = 0): SessionGraph =>
  patch(g, MAIN, a => ({ ...a, status: 'running', endedAt: null, startedAt: a.startedAt > 0 ? a.startedAt : now }))

/** Tools that start agents: the child's own card (a run's card, for Workflow) stands for the call, so it is not listed as a use. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task', 'Workflow'])

/**
 * What a tool call uses, as the graph files it: a skill by name, an MCP server, or the tool itself;
 * null for a call that starts an agent.
 */
export const useKey = (tool: string, input: { skill?: unknown } = {}): string | null => {
  if (SPAWN_TOOLS.has(tool)) return null
  if (tool === 'Skill' && typeof input.skill === 'string' && input.skill) return `skill:${input.skill}`
  if (tool.startsWith('mcp__')) return `mcp:${tool.slice(5).split('__')[0] || tool}`
  return tool
}

/** A use key's kind and the name the graph shows: `skill:commit` → skill `commit`, a rule → its file name. */
export const useOf = (key: string): { kind: UseKind; label: string } => {
  const i = key.indexOf(':')
  const prefix = i > 0 ? key.slice(0, i) : ''
  if (prefix === 'skill' || prefix === 'mcp') return { kind: prefix, label: key.slice(i + 1) }
  if (prefix === 'rule') return { kind: 'rule', label: baseName(key.slice(i + 1)) }
  return { kind: 'tool', label: key }
}

const baseName = (path: string) => path.split(/[\\/]/).pop() || path

/** The calls still in flight, and what they leave as the agent's current tool. */
const withCalls = (a: AgentNode, inFlight: InFlightCall[]): AgentNode => {
  const last = inFlight[inFlight.length - 1]
  return { ...a, inFlight, currentTool: last?.tool ?? null, currentUse: last?.use ?? null }
}

export const toolStarted = (
  g: SessionGraph,
  id: string,
  tool: string,
  now = 0,
  key: string | null = useKey(tool),
  callId: string | null = null,
): SessionGraph =>
  settleRuns(patch(withAgent(g, id, now), id, prev => {
    const a = heard(prev, now)
    return {
      ...withCalls(a, [...(a.inFlight ?? []), { callId, tool, use: key }]),
      waitingSince: ASK_TOOLS.has(tool) ? now : a.waitingSince,
      toolCalls: a.toolCalls + 1,
      ...(key ? { tools: { ...a.tools, [key]: (a.tools[key] ?? 0) + 1 }, toolAt: { ...(a.toolAt ?? {}), [key]: now } } : {}),
      // A tool call is proof the loop runs: a teammate woken by a message, the main loop mid-turn.
      // A finished subagent stays finished (only its turn.complete ends it, a late call does not revive it).
      status: a.status === 'waiting' || (a.kind === 'subagent' && isDone(a.status)) ? a.status : 'running',
      endedAt: a.status === 'waiting' || (a.kind === 'subagent' && isDone(a.status)) ? a.endedAt : null,
    }
  }), now)

export const toolFinished = (
  g: SessionGraph,
  id: string,
  tool: string,
  now = 0,
  key: string | null = useKey(tool),
  callId: string | null = null,
): SessionGraph =>
  patch(g, id, prev => {
    const a = heard(prev, now)
    const calls = a.inFlight ?? []
    // The call by its id; without one, the latest call of the same tool.
    let i = callId ? calls.findIndex(c => c.callId === callId) : -1
    for (let j = calls.length - 1; j >= 0 && i < 0; j--) if (calls[j]!.tool === tool) i = j
    const rest = i < 0 ? calls : calls.filter((_, j) => j !== i)
    return {
      ...withCalls(a, rest),
      ...(key ? { toolAt: { ...(a.toolAt ?? {}), [key]: now } } : {}),
      waitingSince: rest.some(c => ASK_TOOLS.has(c.tool)) ? a.waitingSince : null,
    }
  })

/** An agent loaded a rule or CLAUDE.md file (InstructionsLoaded): listed among its uses. */
export const ruleLoaded = (g: SessionGraph, id: string, path: string, now = 0): SessionGraph => {
  const key = `rule:${path}`
  return patch(g, id, a => ({ ...heard(a, now), tools: { ...a.tools, [key]: (a.tools[key] ?? 0) + 1 }, toolAt: { ...(a.toolAt ?? {}), [key]: now } }))
}

/** One thing an agent used, as its card lists it. */
export type Use = { key: string; kind: UseKind; label: string; calls: number; at: number; isActive: boolean }

/** What an agent used, in first-use order; a use is active while the agent runs it or just did. */
export const agentUses = (a: AgentNode, now: number): Use[] =>
  Object.entries(a.tools).map(([key, calls]) => ({ key, ...useOf(key), calls, at: a.toolAt?.[key] ?? 0, isActive: isToolHot(a, key, now) }))

/** True while `a` runs the use `key`, or started or finished it less than TOOL_GLOW_MS ago. */
export const isToolHot = (a: AgentNode, key: string, now: number) =>
  a.currentUse === key || now - (a.toolAt?.[key] ?? -Infinity) < TOOL_GLOW_MS

/** The uses of an agent, most used first: `Grep×3 skill commit×1` in the status lines. */
export const toolSummary = (a: AgentNode) =>
  Object.entries(a.tools)
    .sort((x, y) => y[1] - x[1])
    .map(([key, n]) => {
      const u = useOf(key)
      return `${u.kind === 'tool' ? u.label : `${u.kind} ${u.label}`}×${n}`
    })
    .join(' ')

/** The `context.breakdown` fields of `$.session.usage` the harness card reads. */
export type HarnessBreakdown = {
  memoryFiles?: readonly { path: string }[]
  mcpTools?: readonly { serverName: string }[]
  agents?: readonly unknown[]
  skills?: { totalSkills: number }
}

/** The harness card from the merged settings (`hooks`) and the context breakdown. */
export const harnessFrom = (settings: { hooks?: unknown }, breakdown: HarnessBreakdown = {}): Harness => {
  const hooks: Record<string, number> = {}
  if (settings.hooks && typeof settings.hooks === 'object') {
    for (const [event, groups] of Object.entries(settings.hooks)) {
      if (!Array.isArray(groups)) continue
      const n = groups.reduce((sum: number, group: { hooks?: unknown }) => sum + (Array.isArray(group?.hooks) ? group.hooks.length : 0), 0)
      if (n > 0) hooks[event] = n
    }
  }
  return {
    rules: (breakdown.memoryFiles ?? []).map(f => f.path),
    hooks,
    skills: breakdown.skills?.totalSkills ?? 0,
    mcpServers: [...new Set((breakdown.mcpTools ?? []).map(t => t.serverName))],
    agents: breakdown.agents?.length ?? 0,
  }
}

export const setHarness = (g: SessionGraph, harness: Harness): SessionGraph => ({ ...g, harness })

/** The harness card's lines, one per kind: `hooks 3: PreToolUse 2, Stop 1`. */
export const harnessLines = (h: Harness): string[] => {
  const list = (xs: string[]) => (xs.length ? `: ${xs.join(', ')}` : '')
  const hookTotal = Object.values(h.hooks).reduce((n, k) => n + k, 0)
  return [
    `rules ${h.rules.length}${list(h.rules.map(baseName))}`,
    `hooks ${hookTotal}${list(Object.entries(h.hooks).map(([event, n]) => `${event} ${n}`))}`,
    `skills ${h.skills}`,
    `mcp ${h.mcpServers.length}${list(h.mcpServers)}`,
    `agents ${h.agents}`,
  ]
}

export type TurnEnd = { tokens: number; reason: 'answer' | 'aborted' | 'refusal' | 'error'; model?: string }

/**
 * A turn ended: a subagent is finished (its run is one turn); the main loop and teammates go idle,
 * and a teammate whose turn failed is marked failed until its next tool call.
 */
export const turnEnded = (g: SessionGraph, id: string, t: TurnEnd, now: number): SessionGraph =>
  settleRuns(patch(withAgent(g, id, now), id, a => {
    const failed = t.reason === 'error' || t.reason === 'refusal'
    const status: NodeStatus =
      a.kind === 'subagent' ? (t.reason === 'answer' ? 'completed' : t.reason === 'aborted' ? 'killed' : 'failed') : a.kind === 'teammate' && failed ? 'failed' : 'idle'
    return {
      ...a,
      status,
      tokens: a.tokens + t.tokens,
      model: t.model || a.model,
      currentTool: null,
      currentUse: null,
      inFlight: [],
      waitingSince: null,
      endedAt: isDone(status) ? now : a.endedAt,
      lastEventAt: now,
    }
  }), now)

/** Which agent a SendMessage `to` names: an id, a teammate address (`name@team`), or a bare name. */
export const resolveRecipient = (g: SessionGraph, to: string): string | null => {
  if (to === MAIN || g.agents[to]) return to
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a) continue
    if (a.label === to || a.label.split('@')[0] === to) return id
  }
  return null
}

export const messageSent = (g: SessionGraph, from: string, to: string): SessionGraph => {
  if (!g.agents[from] || !g.agents[to] || from === to) return g
  const i = g.messages.findIndex(m => m.from === from && m.to === to)
  const messages =
    i < 0 ? [...g.messages, { from, to, count: 1 }] : g.messages.map((m, j) => (j === i ? { ...m, count: m.count + 1 } : m))
  return { ...g, messages }
}

/** One row of `$.agent.list()`, the fields q-graph reads. */
export type ListedAgent = {
  id: string
  status: NodeStatus
  type: string
  description: string
  parentId?: string
  name?: string
  teammateId?: string
}

export type Transition = { id: string; from: NodeStatus | null; to: NodeStatus }

/**
 * Takes the engine's view of each agent. Agents it lists that no `agent.spawn` reached (a forked
 * skill's loop) are added. One it no longer lists keeps what the hooks recorded, until it is also
 * silent for LOST_MS: then it is `lost`.
 */
export const syncAgents = (g: SessionGraph, list: readonly ListedAgent[], now: number): { graph: SessionGraph; transitions: Transition[] } => {
  let graph = g
  const transitions: Transition[] = []
  for (const row of list) {
    const prev = graph.agents[row.id]
    if (!prev) {
      graph = spawnAgent(graph, { id: row.id, parentId: row.parentId, isTeammate: !!row.teammateId, type: row.type, name: row.name, teammateId: row.teammateId, description: row.description }, now)
    }
    const cur = graph.agents[row.id]!
    // A finished subagent stays finished: the list can lag behind its turn.complete.
    if (cur.status === row.status || (isDone(cur.status) && cur.kind === 'subagent')) continue
    transitions.push({ id: row.id, from: prev ? cur.status : null, to: row.status })
    graph = patch(graph, row.id, a => ({
      ...a,
      status: row.status,
      endedAt: isDone(row.status) ? (a.endedAt ?? now) : null,
      ...(row.status === 'running' || row.status === 'waiting' ? {} : { currentTool: null, currentUse: null, inFlight: [] }),
    }))
  }
  // Absence alone proves nothing: it takes silence too, and a call still in flight counts as activity
  // (its end always raises tool.call's finally). A Workflow run and its agents are never listed, so
  // only their turn.complete ends them: a long think between two calls must not read as lost.
  if (list.length > 0) {
    const listed = new Set(list.map(r => r.id))
    for (const id of graph.order) {
      const a = graph.agents[id]
      if (!a || a.kind === 'main' || a.runId || listed.has(id) || !LIVE.has(a.status)) continue
      if ((a.inFlight ?? []).length > 0 || now - (a.lastEventAt ?? 0) < LOST_MS) continue
      graph = patch(graph, id, x => ({ ...x, status: 'lost', endedAt: now, waitingSince: null }))
    }
  }
  return { graph: settleRuns(graph, now), transitions }
}

/** Agents other than main that are still going, or finished within RECENT_MS. */
export const rosterAgents = (g: SessionGraph, now: number): AgentNode[] =>
  g.order
    .map(id => g.agents[id])
    .filter((a): a is AgentNode => !!a && a.kind !== 'main')
    .filter(a => !(isDone(a.status) || a.status === 'lost') || (a.endedAt !== null && now - a.endedAt < RECENT_MS))

/** True while some agent other than main still runs or waits: the poll and the animation run until it is false. */
export const hasLiveAgents = (g: SessionGraph) =>
  g.order.some(id => {
    const a = g.agents[id]
    return !!a && a.kind !== 'main' && (a.status === 'running' || a.status === 'waiting' || a.status === 'pending')
  })

export const formatElapsed = (ms: number) => {
  const s = Math.max(0, Math.floor(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m${String(s % 60).padStart(2, '0')}`
  return `${Math.floor(m / 60)}h${String(m % 60).padStart(2, '0')}`
}

export const formatTokens = (n: number) => (n >= 1_000_000 ? `${(n / 1_000_000).toFixed(1)}M` : n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(Math.round(n)))

/** The model's family for a card: `claude-haiku-5-5` → `haiku`; an unknown id loses only its prefix and date. */
export const shortModel = (model: string) =>
  /\b(opus|sonnet|haiku|fable)\b/i.exec(model)?.[1]?.toLowerCase() ?? model.replace(/^claude-/, '').replace(/-\d{8}$/, '')

export const STATUS_TEXT: Record<NodeStatus, string> = {
  pending: '· starting',
  running: 'running',
  waiting: '⏸ waiting',
  idle: '○ idle',
  completed: '✓ done',
  failed: '✗ failed',
  killed: '■ stopped',
  lost: '? lost',
}

/** One line per agent for `/q-graph status` and for surfaces without a Raster. */
export const describeAgents = (g: SessionGraph, now: number): string[] => {
  const depth = (a: AgentNode, seen = new Set<string>()): number => {
    const parent = a.parentId ? g.agents[a.parentId] : undefined
    if (!parent || seen.has(a.id)) return 0
    seen.add(a.id)
    return depth(parent, seen) + 1
  }
  return g.order
    .map(id => g.agents[id])
    .filter((a): a is AgentNode => !!a)
    .map(a => {
      const status = a.kind === 'workflow'
        ? runStatusText(a)
        : needsYou(a)
        ? `⚠ needs you (${askingTool(a)})`
        : a.status === 'running'
          ? a.currentTool || a.progress
            ? `running ${a.currentTool ?? a.progress}`
            : 'running'
          : STATUS_TEXT[a.status]
      const time = a.startedAt > 0 ? formatElapsed((a.endedAt ?? now) - a.startedAt) : '–'
      const model = a.model ? ` · ${shortModel(a.model)}` : ''
      const what = a.description ? ` · ${a.description}` : ''
      const used = a.toolCalls ? ` (${toolSummary(a)})` : ''
      return `${'  '.repeat(depth(a))}${a.label}${model} · ${status} · ${time} · ${formatTokens(a.tokens)} tok · ${a.toolCalls} tools${used}${what}`
    })
}
