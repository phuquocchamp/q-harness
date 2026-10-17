// Shared shapes of q-advisor. Pure types only: every lib file and register.tsx import from here.

export type Mode = 'shadow' | 'on' | 'off'
export type Relation = 'continuation' | 'new-task' | 'side-question'
export type TaskSize = 'trivial' | 'routine' | 'deep'
export type ModelFamily = 'haiku' | 'sonnet' | 'opus' | 'other'
/** Who made a judgement: Jev, Haiku's classify fallback, or the number rules alone. */
export type Source = 'jev' | 'haiku' | 'rules'
export type AdviceKind = 'compact-now' | 'compact-urgent' | 'new-task' | 'fresh-session' | 'model-fit' | 'rate-limit'
export const ADVICE_KINDS: readonly AdviceKind[] = ['compact-now', 'compact-urgent', 'new-task', 'fresh-session', 'model-fit', 'rate-limit']

/** Probability thresholds a Jev verdict must clear before it may drive advice (from the live probes). */
export interface Thresholds {
  relation: number // 0.9
  size: number // 0.7
  finished: number // 0.7
  keep: number // 0.5
}

export interface Settings {
  mode: Mode
  focusCompact: boolean
  jev: boolean
  jevModel: string // 'jev-latest'
  compactAt: number // 60 (% context): compact-now window
  urgentAt: number // 80 (% context): compact-urgent window, mid-task
  focusAt: number // 70 (% context): precompute the autocompact focus from here
  newTaskAt: number // 30 (% context): below this a new task needs no /clear
  freshAfter: number // 3 compactions
  rateLimitAt: number // 80 (% of the five-hour window)
  quietTurns: number // 3 turns between two pieces of advice
  minPromptChars: number // 25: shorter prompts are never classified
  thresholds: Thresholds
  muted: AdviceKind[]
}

/** The subset of the engine's SessionMessage that q-advisor reads. */
export interface Msg {
  role: 'user' | 'assistant'
  text: string
  toolUses: { tool: string; input: Record<string, unknown>; isError?: true }[]
  toolResults?: { isError?: boolean }[]
}

/** What Jev (or the fallback) said about the prompt that started the current turn. */
export interface PromptVerdict {
  relation?: { label: Relation; p: number }
  size?: { label: TaskSize; p: number }
  source: Source
  latencyMs: number
  at: number
}

/** The numbers the rules read at a turn boundary (from $.session.usage, model, turns and the mod's own counters). */
export interface Snapshot {
  contextPercent: number | null
  contextTokens: number | null
  fiveHourPercent: number | null
  sevenDayPercent: number | null
  costUsd: number | null
  model: string
  turns: number
  compactions: number
  turnsSinceAdvice: number
  /** true/false when the engine reported it (resume, model switch); null when unknown. */
  cacheWarm: boolean | null
}

/** What the current conversation is about, condensed from the messages for Jev and Haiku. */
export interface Recent {
  recentWork: string
  lastReply: string
  todoState: string
  toolErrors: string
}

/** A piece of the conversation that may need to survive a compaction. */
export interface Candidate {
  id: string // 'c1', 'c2', ... (Jev state field item_<id>)
  kind: 'plan' | 'decision' | 'files' | 'open-question' | 'todo' | 'goal'
  text: string
}

/** One piece of advice, ready to show. */
export interface Advice {
  kind: AdviceKind
  /** One line with the reason and its numbers: "context 64% · task finished (p 0.93)". */
  reason: string
  /** The slash command it proposes, e.g. "/compact", "/clear", "/model sonnet". */
  command: string
  /** /compact advice wants focus instructions; /clear advice wants a handoff note. */
  wants?: 'focus' | 'handoff'
}

/** The precomputed focus for the next compaction. */
export interface Focus {
  text: string
  kept: string[] // candidate ids Jev kept
  source: Source | 'fallback'
  at: number
  contextPercent: number | null
}

/** One logged judgement (shadow log and /q-advisor stats). */
export interface Decision {
  at: number
  question: 'relation' | 'size' | 'finished' | 'keep'
  label: string
  p: number
  source: Source
  latencyMs: number
}

/** One logged piece of advice and what became of it. */
export interface AdviceRecord {
  at: number
  kind: AdviceKind
  mode: Mode
  shown: boolean
  outcome: 'pending' | 'accepted' | 'dismissed' | 'expired'
}
