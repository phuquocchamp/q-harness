// Test helpers shared by the q-graph tests: a fake host and short ways to drive the plugin.

import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { AgentInfo, On } from 'claude-code'

/**
 * An in-memory $.store, a mocked clock, the toasts and notifications raised, an agent list the test
 * sets, and an engine that starts every spawn as `a<n>`.
 */
export const fakeHost = (on: On) => {
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const notes: string[] = []
  const agents: AgentInfo[] = []
  let spawned = 0
  const clock = mock.clock(on, { now: 1_000 })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('ui.toast', (_$, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.notify', (_$, e) => {
    notes.push(e.text)
    return { value: { isSent: true, channel: 'terminal_bell' as const } }
  })
  on('ui.invalidate', () => ({ value: undefined }))
  on('agent.list', () => ({ value: agents.slice() }))
  on('agent.spawn', () => ({ model: 'claude-haiku-5-5', agentId: `a${++spawned}` }))
  // The harness card's reads: one settings hook, a CLAUDE.md, a context7 MCP server, 12 skills.
  on('settings.read', () => ({ value: { hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'guard' }] }] } } }) as never)
  on('session.usage', () =>
    ({
      value: {
        context: {
          breakdown: {
            memoryFiles: [{ path: '/repo/CLAUDE.md', type: 'Project', tokens: 10 }],
            mcpTools: [{ name: 'mcp__context7__query-docs', serverName: 'context7', tokens: 1, isLoaded: true }],
            agents: [],
            skills: { totalSkills: 12, includedSkills: 12, tokens: 1, skillFrontmatter: [] },
          },
        },
      },
    }) as never,
  )
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  return { store, toasts, notes, agents, clock }
}

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-graph', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

export const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])

export const spawn = ($: Engine, subagentType: string, description: string) =>
  $.agent.spawn({ prompt: `do: ${description}`, description, subagentType } as Parameters<Engine['agent']['spawn']>[0])

/** Ends the turn of agent `agentId` (main when absent) with the given token usage. */
export const endTurn = ($: Engine, agentId: string | undefined, tokens: number, reason: 'answer' | 'error' = 'answer') =>
  $.turn.complete({
    answer: 'ok',
    durationMs: 1000,
    isAborted: false,
    turnId: `turn-${agentId ?? 'main'}`,
    ...(agentId ? { agentId } : {}),
    usage: { input_tokens: tokens, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, model: 'claude-haiku-5-5' },
    reason,
  } as Parameters<Engine['turn']['complete']>[0])
