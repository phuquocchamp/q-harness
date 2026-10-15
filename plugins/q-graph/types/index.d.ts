export type AgentKind = 'main' | 'subagent' | 'teammate'

/**
 * Where an agent's loop stands: `AgentStatus` from `$.agent.list()`, kept by q-graph after the engine
 * drops the row, plus `lost`: recorded as live, but the engine no longer lists it and no hook has
 * named it for a while. Any later hook event for the agent makes it `running` again.
 */
export type NodeStatus = 'pending' | 'running' | 'waiting' | 'idle' | 'completed' | 'failed' | 'killed' | 'lost'

/** A tool call an agent has started and not yet finished. */
export type InFlightCall = {
  /** The `tool_use_id` of the call; null when the event carried none. */
  callId: string | null
  tool: string
  /** The use key the call is filed under; null for a call that starts an agent. */
  use: string | null
}

export type AgentNode = {
  /** `main` for the main loop, else the id `agent.spawn` answered (the one `$.agent.list()` and every event's `agentId` use). */
  id: string
  /** The agent whose loop spawned it; null for the main loop. */
  parentId: string | null
  kind: AgentKind
  /** The agent type (`Explore`, `general-purpose`, `teammate`, ...). */
  type: string
  /** What the graph and the band call it: a teammate's `name@team`, else its name or type. */
  label: string
  model: string
  /** The Agent call's own few words on the task. */
  description: string
  status: NodeStatus
  startedAt: number
  endedAt: number | null
  /** When it started asking the person (AskUserQuestion, ExitPlanMode); null while it is not. */
  waitingSince: number | null
  /**
   * What its turns cost: input, output and cache writes. Cache reads are left out: every request
   * re-reads the cached prefix, so counting them would multiply the figure by the number of requests.
   */
  tokens: number
  toolCalls: number
  /**
   * What it used, by use key, in first-use order: a tool name (`Bash`), a skill (`skill:commit`), an
   * MCP server (`mcp:context7`) or a rule file it loaded (`rule:/repo/.claude/rules/x.md`).
   */
  tools: Record<string, number>
  /** The tool it is running now (the latest call still in flight), if any. */
  currentTool: string | null
  /** The use key of the call it is running now, if any. */
  currentUse: string | null
  /** Every call it has started and not finished, oldest first: an agent can run several at once. */
  inFlight: InFlightCall[]
  /** When a hook last named this agent; with the engine's list it tells a dead agent from a quiet one. */
  lastEventAt: number
  /** When it last started or finished each use: the graph lights the use for a moment after a call. */
  toolAt: Record<string, number>
}

/** What a use is: the graph colours and labels each kind on its own. */
export type UseKind = 'tool' | 'skill' | 'mcp' | 'rule'

/** What the session's harness holds: configured or loaded for the session, not used by one agent. */
export type Harness = {
  /** The memory files the context carries (CLAUDE.md, rules, auto-memory), by path. */
  rules: string[]
  /** Settings hooks per event (`PreToolUse` → 2). Hooks modules of plugins are not listed. */
  hooks: Record<string, number>
  /** Skills the session lists. */
  skills: number
  /** MCP servers whose tools the session has. */
  mcpServers: string[]
  /** Custom agents the Agent tool describes. */
  agents: number
}

/** Messages sent between two agents (SendMessage), counted per direction. */
export type MessageEdge = { from: string; to: string; count: number }

export type SessionGraph = {
  agents: Record<string, AgentNode>
  /** Agent ids in the order they appeared; `main` first. */
  order: string[]
  messages: MessageEdge[]
  /** The harness card; null until the first read of the settings and the context. */
  harness: Harness | null
}

export type GraphSettings = {
  /** Draw the roster band above the prompt while agents run. */
  band: boolean
  /** Send a native notification when an agent waits for the person or fails. */
  notify: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'q-graph': {
      /** Every agent of this session and the messages between them, recorded from the hooks. */
      graph: SessionGraph
      /** Loaded from `$.store` at session start; the only value kept across sessions. */
      settings: GraphSettings
      /** The live browser viewer's address while its process runs (`/q-graph web`); null otherwise. */
      webUrl: string | null
      /** The band lists every agent on wrapped rows (its `+N more` was pressed); false keeps it to one row. */
      bandAll: boolean
    }
  }
}
