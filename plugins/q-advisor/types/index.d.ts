// State contract of q-advisor. No imports: these shapes mirror hooks/lib/contract.ts structurally
// (Settings, PromptVerdict, Advice, Focus), so the contract's values can be stored here as they are.
// Names carry an `Adv` prefix so none shadows a type of the `claude-code` module.

export type AdvMode = 'shadow' | 'on' | 'off'
export type AdvSource = 'jev' | 'haiku' | 'rules'
export type AdvKind = 'compact-now' | 'compact-urgent' | 'new-task' | 'fresh-session' | 'model-fit' | 'rate-limit'

/** The resolved settings (contract Settings). */
export type AdvSettings = {
  mode: AdvMode
  focusCompact: boolean
  jev: boolean
  jevModel: string
  compactAt: number
  urgentAt: number
  focusAt: number
  newTaskAt: number
  freshAfter: number
  rateLimitAt: number
  quietTurns: number
  minPromptChars: number
  thresholds: { relation: number; size: number; finished: number; keep: number }
  muted: AdvKind[]
}

/** What Jev (or the fallback) said about the prompt that started the turn (contract PromptVerdict). */
export type AdvVerdict = {
  relation?: { label: 'continuation' | 'new-task' | 'side-question'; p: number }
  size?: { label: 'trivial' | 'routine' | 'deep'; p: number }
  source: AdvSource
  latencyMs: number
  at: number
}

/** One piece of advice, ready to show (contract Advice). */
export type AdvAdvice = {
  kind: AdvKind
  reason: string
  command: string
  wants?: 'focus' | 'handoff'
}

/** The precomputed focus for the next compaction (contract Focus). */
export type AdvFocus = {
  text: string
  kept: string[]
  source: AdvSource | 'fallback'
  at: number
  contextPercent: number | null
}

declare module 'claude-code' {
  interface PluginState {
    'q-advisor': {
      /** The resolved settings (options + stored overrides); null before session.start. */
      settings: AdvSettings | null
      /** The verdict on the prompt that started the running turn; null for none or a trivial prompt. */
      verdict: AdvVerdict | null
      /** The noul that the last turn had finished (0..1); null when not asked or unknown. */
      finished: number | null
      /** The advice the band shows; null for none. Only set in mode 'on'. */
      advice: AdvAdvice | null
      /** The `at` of the advice's record in the advice log, to settle its outcome; null for none. */
      adviceAt: number | null
      /** The precomputed autocompact focus; null until one is computed, and after each compaction. */
      focus: AdvFocus | null
      /** Compactions of the main conversation since the session began (or its last /clear). */
      compactions: number
      /** Main turns since the last piece of advice (shown or shadowed). */
      turnsSinceAdvice: number
      /** false after a resume whose prompt cache expired; null when unknown. */
      cacheWarm: boolean | null
      /** Context tokens and turn count at the last turn end; the baseline for spotting a compaction that bypassed our hooks. */
      lastSeen: { tokens: number | null; turns: number } | null
      /** True while a band action (compact, handoff, command) runs. */
      busy: boolean
    }
  }
}
