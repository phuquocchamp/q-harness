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
  // A stub that already finished (its turn.complete beat this spawn) stays finished.
  const settled = prev && prev.type === 'unknown' && isDone(prev.status)
  const node: AgentNode = {
    ...(prev ?? mainNode(now)),
    id: s.id,
    parentId,
    kind,
    type: s.type,
    label: labelFor(s),
    model: s.model ?? prev?.model ?? '',
    description: s.description,
    status: settled ? prev.status : 'running',
    startedAt: prev?.startedAt ?? now,
    endedAt: settled ? prev.endedAt : null,
    waitingSince: null,
    lastEventAt: now,
  }
  return { ...g, agents: { ...g.agents, [s.id]: node }, order: prev ? g.order : [...g.order, s.id] }
}

/** The main loop starts a turn; its clock starts at the session's first prompt. */
export const promptSubmitted = (g: SessionGraph, now = 0): SessionGraph =>
  patch(g, MAIN, a => ({ ...a, status: 'running', endedAt: null, startedAt: a.startedAt > 0 ? a.startedAt : now }))

/** Tools that start an agent: the child's own card stands for the call, so it is not listed as a use. */
const SPAWN_TOOLS: ReadonlySet<string> = new Set(['Agent', 'Task'])

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
  patch(withAgent(g, id, now), id, prev => {
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
  })

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
  patch(withAgent(g, id, now), id, a => {
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
  })

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
  // Workflow-started agents are never listed, so absence alone proves nothing: it takes silence too,
  // and a call still in flight counts as activity (its end always raises tool.call's finally).
  if (list.length > 0) {
    const listed = new Set(list.map(r => r.id))
    for (const id of graph.order) {
      const a = graph.agents[id]
      if (!a || a.kind === 'main' || listed.has(id) || !LIVE.has(a.status)) continue
      if ((a.inFlight ?? []).length > 0 || now - (a.lastEventAt ?? 0) < LOST_MS) continue
      graph = patch(graph, id, x => ({ ...x, status: 'lost', endedAt: now, waitingSince: null }))
    }
  }
  return { graph, transitions }
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
      const status = needsYou(a)
        ? `⚠ needs you (${askingTool(a)})`
        : a.status === 'running'
          ? a.currentTool
            ? `running ${a.currentTool}`
            : 'running'
          : STATUS_TEXT[a.status]
      const time = a.startedAt > 0 ? formatElapsed((a.endedAt ?? now) - a.startedAt) : '–'
      const model = a.model ? ` · ${shortModel(a.model)}` : ''
      const what = a.description ? ` · ${a.description}` : ''
      const used = a.toolCalls ? ` (${toolSummary(a)})` : ''
      return `${'  '.repeat(depth(a))}${a.label}${model} · ${status} · ${time} · ${formatTokens(a.tokens)} tok · ${a.toolCalls} tools${used}${what}`
    })
}
