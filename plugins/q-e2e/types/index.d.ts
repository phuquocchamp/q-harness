// State contract of q-e2e. No imports: these shapes mirror hooks/lib/contract.ts (SpecResult,
// RunEvidence, TriageVerdict) structurally, so the contract's values can be stored here as they are.
// Names carry an `E2e` prefix so none shadows a type of the `claude-code` module.

export type E2eMode = 'off' | 'affected' | 'all'

/** Where the main turn's Stop was seen: by the turn's id (from `turn.start`), else by time. */
export type E2eStopSeen = { turnId: string | null; at: number }

export type E2eTriageLabel = 'flaky' | 'test-drift' | 'app-bug' | 'env-auth'

/** One Playwright spec result (contract SpecResult). */
export type E2eSpecResult = {
  file: string
  line: number
  title: string
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'flaky'
  durationMs: number
  retries: number
  error?: string
  errorContextPath?: string
}

/** One finished run (contract RunEvidence). */
export type E2eRun = {
  id: string
  startedAt: number
  durationMs: number
  commit?: string
  specs: string[]
  reason: 'stop-gate' | 'command' | 'full-suite' | 'heal-verify'
  exitCode: number
  passed: number
  failed: number
  flaky: number
  skipped: number
  results: E2eSpecResult[]
}

/** A triage verdict for one red spec (contract TriageVerdict). */
export type E2eVerdict = {
  label: E2eTriageLabel
  p: number
  probabilities: Partial<Record<E2eTriageLabel, number>>
  touched?: number
  source: 'jev' | 'haiku' | 'fallback'
  latencyMs?: number
}

/** The guarded healer subagent working on one drifted spec. */
export type E2eHealing = {
  /** The subagent's id, as `agent.spawn` answered it and its `turn.complete` carries it. */
  agentId: string
  /** Spec file, repo-relative. */
  spec: string
  line: number
  startedAt: number
  status: 'running' | 'verifying' | 'passed' | 'failed' | 'rejected'
  /** Repo-relative files the healer wrote or edited (its own tool calls). */
  files: string[]
  /** Diff guard reasons when rejected, or the verify run's summary. */
  reasons: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'q-e2e': {
      /** Repo-relative files the main loop wrote or edited since the gate last let a stop through. */
      edits: string[]
      /** Stops the gate blocked since the last stop that was not a block continuation (max 2). */
      blocksThisTurn: number
      /** The last finished run; restored from `$.store` at session start. */
      lastRun: E2eRun | null
      /** Triage verdicts of the last red run, by `file:line`. */
      verdicts: Record<string, E2eVerdict>
      /** The healer at work or its last outcome; null when none ran this session. */
      healing: E2eHealing | null
      /** `/q-e2e mode` override of the `mode` option; null follows the option. */
      mode: E2eMode | null
      /** The main loop's running turn, from `turn.start`; null before the first. */
      currentTurn: string | null
      /** Set by the classic.Stop hook when it ran for the main turn; the turn.complete fallback skips that turn. */
      stopSeen: E2eStopSeen | null
      /** Follow-up prompts the fallback submitted since the person's last prompt (max 2). */
      followUps: number
      /** Whether a person is at the prompt (false for `-p` and the SDK); from session.start. */
      interactive: boolean
    }
  }
}
