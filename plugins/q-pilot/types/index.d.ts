// State contract of q-pilot. No imports: these shapes mirror the runner's result JSON (DESIGN.md)
// and hooks/lib/contract.ts structurally. Names carry a `Pilot` prefix so none shadows a type of the
// `claude-code` module.

export type PilotMode = 'off' | 'affected' | 'all'

/** Where the main turn's Stop was seen: by the turn's id (from `turn.start`), else by time. */
export type PilotStopSeen = { turnId: string | null; at: number }

export type PilotOutcome =
  | 'pass'
  | 'drift'
  | 'app-bug'
  | 'flaky'
  | 'blocked'
  | 'env'
  | 'untraced'
  | 'needs-verify'
  | 'skipped'
  | 'error'

/** One flow of a runner result (contract FlowResult), plus `accepted` once its proposal became the trace. */
export type PilotFlow = {
  id: string
  outcome: PilotOutcome
  durationMs: number
  recorded: boolean
  /** Jev requests this flow made (record or heal), and how long each took. */
  jevCalls?: number
  jevMs?: number[]
  steps: { op: string; role?: string; name?: string; by?: string }[]
  diverged: { step: number; was: { op: string; role?: string; name?: string }; now: { op: string; role?: string; name?: string }; p?: number }[]
  verifyFails: { check: unknown; actual: unknown }[]
  proposal?: string | null
  screenshot?: string | null
  error?: string | null
  accepted?: boolean
}

/** One finished runner `run` (contract RunResult), kept as the last run. */
export type PilotRun = {
  runId: string
  startedAt: number
  durationMs: number
  reason: 'stop-gate' | 'command'
  flows: PilotFlow[]
}

/** The last outcome of one flow, kept across runs. */
export type PilotLast = { outcome: PilotOutcome; runId: string; at: number; accepted?: boolean; jevCalls?: number }

declare module 'claude-code' {
  interface PluginState {
    'q-pilot': {
      /** Repo-relative files the main loop wrote or edited since the gate last let a stop through. */
      edits: string[]
      /** Stops the gate blocked since the last stop that was not a block continuation (max 2). */
      blocksThisTurn: number
      /** The last finished run; restored from `$.store` at session start. */
      lastRun: PilotRun | null
      /** The last outcome of every flow that ran, by flow id. */
      lastByFlow: Record<string, PilotLast>
      /** `/q-pilot mode` override of the `mode` option; null follows the option. */
      mode: PilotMode | null
      /** The main loop's running turn, from `turn.start`; null before the first. */
      currentTurn: string | null
      /** Set by the classic.Stop hook when it ran for the main turn; the turn.complete fallback skips that turn. */
      stopSeen: PilotStopSeen | null
      /** Follow-up prompts the fallback submitted since the person's last prompt (max 2). */
      followUps: number
      /** Whether a person is at the prompt (false for `-p` and the SDK); from session.start. */
      interactive: boolean
    }
  }
}
