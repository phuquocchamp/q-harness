// Pure rules: the numbers of a turn boundary plus Jev's verdicts in, at most one piece of advice out.
import type { Advice, AdviceKind, AdviceRecord, ModelFamily, PromptVerdict, Settings, Snapshot, TaskSize } from './contract'

const DISMISSALS_BEFORE_BACKOFF = 5
const SMALL_CONTEXT_TOKENS = 20_000
const FOCUS_STEP = 5

export function modelFamily(model: string): ModelFamily {
  const m = model.toLowerCase()
  for (const family of ['opus', 'sonnet', 'haiku'] as const) if (m.includes(family)) return family
  return 'other'
}

/** The model a task size fits, or null when the current family already fits or is only one step off. */
export function modelFit(size: TaskSize, family: ModelFamily): 'haiku' | 'sonnet' | 'opus' | null {
  if (size === 'deep' && family === 'haiku') return 'opus'
  if (size === 'trivial' && family === 'opus') return 'sonnet'
  return null
}

/** True when the turn end should (re)compute the autocompact focus. */
export function shouldPrecomputeFocus(snap: Snapshot, settings: Settings, focusAt: number | null): boolean {
  if (!settings.focusCompact || snap.contextPercent === null || snap.contextPercent < settings.focusAt) return false
  return focusAt === null || snap.contextPercent >= focusAt + FOCUS_STEP
}

const pct = (n: number) => `${Math.round(n)}%`
const p2 = (p: number) => p.toFixed(2)

/**
 * The one piece of advice for this turn boundary, or null. Priority: compact-urgent, new-task,
 * compact-now, fresh-session, rate-limit, model-fit. Respects mode 'off', muted kinds, quietTurns,
 * thresholds (a verdict below its threshold counts as no verdict) and the side-question guard.
 * `finished` is the probability that the task that just ended is done (undefined when unknown).
 * `dismissals` counts consecutive dismissals per kind: 5 or more raises that kind's thresholds halfway to 1.
 */
export function decide(input: { snap: Snapshot; settings: Settings; prompt?: PromptVerdict; finished?: number; dismissals?: Partial<Record<Advice['kind'], number>> }): Advice | null {
  const { snap, settings, prompt, finished, dismissals = {} } = input
  if (settings.mode === 'off' || snap.turnsSinceAdvice < settings.quietTurns) return null

  const ctx = snap.contextPercent
  const family = modelFamily(snap.model)
  const open = (kind: AdviceKind) => !settings.muted.includes(kind)
  /** The threshold a verdict must clear for this kind: stricter after repeated dismissals. */
  const need = (kind: AdviceKind, base: number) => ((dismissals[kind] ?? 0) >= DISMISSALS_BEFORE_BACKOFF ? base + (1 - base) / 2 : base)

  const relation = prompt?.relation
  const sideQuestion = !!relation && relation.label === 'side-question' && relation.p >= settings.thresholds.relation
  const size = prompt?.size
  const isFinished = (kind: AdviceKind) => finished !== undefined && finished >= need(kind, settings.thresholds.finished)
  const finishedText = () => `task finished (p ${p2(finished!)})`

  if (ctx !== null && open('compact-urgent') && ctx >= settings.urgentAt) {
    const unfinished = finished === undefined || finished < 1 - need('compact-urgent', settings.thresholds.finished)
    if (unfinished) {
      const why = finished === undefined ? 'task state unknown' : `task unfinished (p ${p2(1 - finished)})`
      return { kind: 'compact-urgent', reason: `context ${pct(ctx)} mid-task · compact before autocompact does it · ${why}`, command: '/compact', wants: 'focus' }
    }
  }

  if (ctx !== null && open('new-task') && snap.turns >= 2 && !sideQuestion && relation && relation.label === 'new-task'
    && relation.p >= need('new-task', settings.thresholds.relation) && ctx >= settings.newTaskAt && isFinished('new-task')) {
    return { kind: 'new-task', reason: `context ${pct(ctx)} · new task (p ${p2(relation.p)}) · ${finishedText()}`, command: '/clear', wants: 'handoff' }
  }

  if (ctx !== null && open('compact-now') && ctx >= settings.compactAt && isFinished('compact-now')) {
    return { kind: 'compact-now', reason: `context ${pct(ctx)} · ${finishedText()}`, command: '/compact', wants: 'focus' }
  }

  if (open('fresh-session') && snap.compactions >= settings.freshAfter && isFinished('fresh-session')) {
    return { kind: 'fresh-session', reason: `${snap.compactions} compactions · ${finishedText()} · a fresh session beats another summary`, command: '/clear', wants: 'handoff' }
  }

  const sizeOk = (kind: AdviceKind) => !!size && size.p >= need(kind, settings.thresholds.size)

  if (open('rate-limit') && !sideQuestion && snap.fiveHourPercent !== null && snap.fiveHourPercent >= settings.rateLimitAt
    && family === 'opus' && sizeOk('rate-limit') && (size!.label === 'trivial' || size!.label === 'routine')) {
    return { kind: 'rate-limit', reason: `five-hour limit ${pct(snap.fiveHourPercent)} · ${size!.label} task (p ${p2(size!.p)}) on Opus`, command: '/model sonnet' }
  }

  if (open('model-fit') && !sideQuestion && sizeOk('model-fit')) {
    const fit = modelFit(size!.label, family)
    const cheapSwitch = snap.cacheWarm === false || (snap.contextTokens !== null && snap.contextTokens < SMALL_CONTEXT_TOKENS)
    if (fit && cheapSwitch) {
      return { kind: 'model-fit', reason: `${size!.label} task (p ${p2(size!.p)}) on ${family} · ${fit} fits better`, command: `/model ${fit}` }
    }
  }

  return null
}

/** Consecutive dismissals per kind from the advice log (reset by an accept). */
export function dismissalsOf(log: AdviceRecord[]): Partial<Record<Advice['kind'], number>> {
  const counts: Partial<Record<Advice['kind'], number>> = {}
  for (const r of log) {
    if (r.outcome === 'accepted') counts[r.kind] = 0
    else if (r.outcome === 'dismissed') counts[r.kind] = (counts[r.kind] ?? 0) + 1
  }
  return counts
}
