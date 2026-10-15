// q-advisor: watches the session at turn boundaries and suggests one thing: compact (with a focus),
// start fresh, or switch model. Jev (Haiku as the fallback, the number rules as the last) makes the
// judgement calls; the numbers come from the session itself. Nothing is ever done unasked: advice is
// a band above the prompt with a button, and a Tab suggestion for /compact.
// The prompt is never delayed: prompt.submit and turn.complete hand their judgement work to
// $.clock.after and return at once. The only hook that rewrites anything is session.compact, and only
// to add the stored focus to the engine's own autocompact.
// Every hook and every helper that takes `$` lives in this file (the engine follows `$` only within
// one module); pure helpers are in ./lib.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register, SessionMessage } from 'claude-code'

import type { AdvAdvice, AdvFocus, AdvSettings, AdvVerdict } from '../types'
import { ADVICE_KINDS } from './lib/contract'
import type { Advice, AdviceKind, AdviceRecord, Candidate, Decision, Msg, PromptVerdict, Recent, Settings, Snapshot, Source } from './lib/contract'
import { dismissalsOf, decide, shouldPrecomputeFocus } from './lib/decide'
import { JEV_URL, RELATIONS, RELATION_TEXT, SIZES, SIZE_TEXT, finishedRequest, keepRequest, parseFinished, parseKeep, parsePrompt, promptRequest } from './lib/jev'
import { extractCandidates, isTrivialPrompt, keepByRules, remainingWork, summarizeRecent } from './lib/signals'
import { applyConfig, resolveSettings, showSettings } from './lib/settings'
import { adviceLine, cleanModelText, fallbackFocus, fallbackHandoff, focusPrompt, formatReport, formatStats, handoffPrompt, mergeInstructions } from './lib/text'

const settingsAtom = atom({ plugin: 'q-advisor', key: 'settings' } as const, null as AdvSettings | null)
const verdictAtom = atom({ plugin: 'q-advisor', key: 'verdict' } as const, null as AdvVerdict | null)
const finishedAtom = atom({ plugin: 'q-advisor', key: 'finished' } as const, null as number | null)
const adviceAtom = atom({ plugin: 'q-advisor', key: 'advice' } as const, null as AdvAdvice | null)
const adviceAtAtom = atom({ plugin: 'q-advisor', key: 'adviceAt' } as const, null as number | null)
const focusAtom = atom({ plugin: 'q-advisor', key: 'focus' } as const, null as AdvFocus | null)
const compactionsAtom = atom({ plugin: 'q-advisor', key: 'compactions' } as const, 0 as number)
/** Starts high so the first piece of advice is not held back by quietTurns. */
const turnsSinceAdviceAtom = atom({ plugin: 'q-advisor', key: 'turnsSinceAdvice' } as const, 99 as number)
const cacheWarmAtom = atom({ plugin: 'q-advisor', key: 'cacheWarm' } as const, null as boolean | null)
/** The context size and turn count at the last turn end; the baseline of the missed-compaction heuristic. */
const lastSeenAtom = atom({ plugin: 'q-advisor', key: 'lastSeen' } as const, null as { tokens: number | null; turns: number } | null)
const busyAtom = atom({ plugin: 'q-advisor', key: 'busy' } as const, false as boolean)

const COMMAND = 'q-advisor'
/** The one-step focused compact; works where the session.compact and classic hooks do not run. */
const COMPACT_COMMAND = `/${COMMAND} compact`
const JEV_TIMEOUT_MS = 800
/** The turn end waits this long for the prompt's own judgement before deciding without it. */
const JUDGE_WAIT_MS = 1500
const HAIKU_TIMEOUT_MS = 8000
const DECISIONS = 300
const ADVICE_LOG = 200
/** A handoff note older than this is not injected after a /clear. */
const HANDOFF_TTL_MS = 30 * 60_000
/** Prompt origins that are the person's own prompt. */
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])
const WARN_HEX = '#ffc04d'

const USAGE = [
  'Usage: /q-advisor [subcommand]',
  '  (none)               the session report and the advice for now',
  '  on | shadow | off    show advice, only log it, or do nothing (saved)',
  '  compact              compact now, keeping the focus (plan, decisions, changed files)',
  '  stats                judgements and advice counts',
  '  focus                the focus for the next autocompact',
  '  mute <kind>          stop one kind: context, model, task, limits (or an exact kind)',
  '  unmute <kind>',
  '  config               the settings',
  '  config <key> <value> change a setting (saved)',
  '  reset                forget overrides, logs and handoff',
].join('\n')

/** The family names of the README's `mute` command, besides the exact kinds. */
const KIND_FAMILIES: Record<string, AdviceKind[]> = {
  context: ['compact-now', 'compact-urgent'],
  model: ['model-fit'],
  task: ['new-task', 'fresh-session'],
  limits: ['rate-limit'],
}

const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))
const isCompactKind = (kind: AdviceKind) => kind === 'compact-now' || kind === 'compact-urgent'

const toMsg = (m: SessionMessage): Msg => ({
  role: m.role,
  text: m.text,
  toolUses: m.toolUses.map(t => ({ tool: t.tool, input: t.input, ...(t.isError ? { isError: true as const } : {}) })),
  ...(m.toolResults ? { toolResults: m.toolResults.map(r => ({ isError: r.isError })) } : {}),
})

async function messagesOf($: EngineInterface): Promise<Msg[]> {
  return (await $.session.messages()).map(toMsg)
}

// ---- settings and the store ------------------------------------------------------------------------

async function overridesOf($: EngineInterface): Promise<Record<string, unknown>> {
  const v = await $.store.get('overrides').catch(() => undefined)
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
}

/** Resolves the settings from the options and the stored overrides and keeps them in state. */
async function loadSettings($: EngineInterface, options: PluginOptions): Promise<Settings> {
  const ov = await overridesOf($)
  const s = resolveSettings(options, ov)
  await update($, settingsAtom, () => s)
  return s
}

async function settingsOf($: EngineInterface, options: PluginOptions): Promise<Settings> {
  return (await read($, settingsAtom)) ?? loadSettings($, options)
}

async function jevKeyOf($: EngineInterface, options: PluginOptions, s: Settings): Promise<string> {
  if (!s.jev) return ''
  const fromOption = String(options.jevApiKey ?? '')
  if (fromOption) return fromOption
  try {
    return (await $.env.get('TYPESAFE_API_KEY')) ?? ''
  } catch {
    return ''
  }
}

async function listOf<T>($: EngineInterface, key: string): Promise<T[]> {
  const v = await $.store.get(key).catch(() => undefined)
  return Array.isArray(v) ? (v as T[]) : []
}

async function pushCapped<T>($: EngineInterface, key: string, items: T[], cap: number) {
  if (items.length === 0) return
  const list = await listOf<T>($, key)
  await $.store.set(key, [...list, ...items].slice(-cap)).catch(() => undefined)
}

/** Settles the pending advice record `at` with its outcome. */
async function settleRecord($: EngineInterface, at: number | null, outcome: AdviceRecord['outcome']) {
  if (at === null) return
  const log = await listOf<AdviceRecord>($, 'adviceLog')
  for (let i = log.length - 1; i >= 0; i--) {
    const r = log[i]!
    if (r.at === at && r.outcome === 'pending') {
      log[i] = { ...r, outcome }
      await $.store.set('adviceLog', log).catch(() => undefined)
      return
    }
  }
}

/** Takes the shown advice down (nothing pending any more) and settles its record. */
async function clearAdvice($: EngineInterface, outcome: AdviceRecord['outcome']) {
  const at = await read($, adviceAtAtom)
  await settleRecord($, at, outcome)
  await update($, adviceAtom, () => null)
  await update($, adviceAtAtom, () => null)
}

// ---- the judgement calls ---------------------------------------------------------------------------

/** `p`'s result, or undefined once `ms` have passed; the timer is dropped when `p` wins. */
async function within<T>($: EngineInterface, ms: number, p: Promise<T>): Promise<T | undefined> {
  const stop = new AbortController()
  const timeout = $.clock.sleep(ms, { signal: stop.signal }).then(
    () => undefined,
    () => undefined,
  )
  try {
    return await Promise.race([p, timeout])
  } finally {
    stop.abort()
  }
}

/** Jev's answer text within JEV_TIMEOUT_MS, else undefined. Never throws. */
async function askJev($: EngineInterface, key: string, body: string): Promise<string | undefined> {
  if (!key) return undefined
  try {
    const call = $.http.fetch(JEV_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body }).catch(() => undefined)
    const res = await within($, JEV_TIMEOUT_MS, call)
    return res?.ok ? res.text : undefined
  } catch {
    // Refused by policy: the fallback decides.
    return undefined
  }
}

const labelText = <L extends string>(labels: readonly L[], text: Record<L, string>) => labels.map(l => `- ${l}: ${text[l]}`)

/** Haiku's single pick among `labels`, or undefined. Never throws. */
async function haikuPick<L extends string>($: EngineInterface, text: string, labels: readonly L[]): Promise<L | undefined> {
  try {
    const label = await $.model.classify(text, labels, { model: 'haiku' })
    return label && (labels as readonly string[]).includes(label) ? (label as L) : undefined
  } catch {
    return undefined
  }
}

const decisionOf = (question: Decision['question'], label: string, p: number, source: Source, latencyMs: number, at: number): Decision => ({ at, question, label, p, source, latencyMs })

/** Jev within 800 ms, else Haiku classify (p 0.5: one sample), else the rules alone (no labels). Never throws. */
async function judgePrompt($: EngineInterface, s: Settings, key: string, text: string, recent: Recent): Promise<PromptVerdict> {
  const t0 = await $.clock.now()
  const done = async (v: Omit<PromptVerdict, 'latencyMs' | 'at'>): Promise<PromptVerdict> => {
    const at = await $.clock.now()
    const verdict: PromptVerdict = { ...v, latencyMs: at - t0, at }
    const log: Decision[] = []
    if (verdict.relation) log.push(decisionOf('relation', verdict.relation.label, verdict.relation.p, verdict.source, verdict.latencyMs, at))
    if (verdict.size) log.push(decisionOf('size', verdict.size.label, verdict.size.p, verdict.source, verdict.latencyMs, at))
    await pushCapped($, 'decisions', log, DECISIONS)
    return verdict
  }
  const body = key ? promptRequest({ recent, newPrompt: text, model: s.jevModel, secrets: [key] }) : ''
  const answer = key ? await askJev($, key, body) : undefined
  const parsed = answer ? parsePrompt(answer) : undefined
  if (parsed && (parsed.relation || parsed.size)) return done({ ...parsed, source: 'jev' })

  const context = [`Recent work: ${recent.recentWork}`, `Last reply: ${recent.lastReply}`, `New prompt: ${text}`].join('\n')
  const relation = await haikuPick($, ['Is the new prompt a continuation of the work, a new task, or a side question? Labels:', ...labelText(RELATIONS, RELATION_TEXT), '', context].join('\n'), RELATIONS)
  const size = await haikuPick($, ['How big is the task the new prompt asks for? Labels:', ...labelText(SIZES, SIZE_TEXT), '', context].join('\n'), SIZES)
  if (relation || size) return done({ ...(relation ? { relation: { label: relation, p: 0.5 } } : {}), ...(size ? { size: { label: size, p: 0.5 } } : {}), source: 'haiku' })
  return done({ source: 'rules' })
}

/** Has the task that just ended finished? The noul from Jev, else Haiku's yes at 0.5, else undefined. Never throws. */
async function judgeFinished($: EngineInterface, s: Settings, key: string, recent: Recent): Promise<number | undefined> {
  const t0 = await $.clock.now()
  const log = async (p: number, source: Source) => {
    const at = await $.clock.now()
    await pushCapped($, 'decisions', [decisionOf('finished', p >= s.thresholds.finished ? 'finished' : 'unfinished', p, source, at - t0, at)], DECISIONS)
    return p
  }
  const answer = key ? await askJev($, key, finishedRequest({ recent, model: s.jevModel, secrets: [key] })) : undefined
  const noul = answer ? parseFinished(answer) : undefined
  if (noul !== undefined) return log(noul, 'jev')
  const text = ['Did the last turn finish the task, or is work left (open todos, errors, a question)? Labels:', '- finished: the task is done and nothing is open', '- unfinished: work is left', '', `Recent work: ${recent.recentWork}`, `Last reply: ${recent.lastReply}`, `Todos: ${recent.todoState}`, `Tool errors: ${recent.toolErrors}`].join('\n')
  const label = await haikuPick($, text, ['finished', 'unfinished'] as const)
  return label === 'finished' ? log(0.5, 'haiku') : undefined
}

/** Which candidates survive a compaction: Jev's scores at the keep threshold, else the rules. */
async function keepIds($: EngineInterface, s: Settings, key: string, work: string, candidates: Candidate[]): Promise<{ ids: string[]; source: Source }> {
  const t0 = await $.clock.now()
  const answer = key ? await askJev($, key, keepRequest({ remainingWork: work, candidates, model: s.jevModel, secrets: [key] })) : undefined
  const scores = answer ? parseKeep(answer, candidates.map(c => c.id)) : undefined
  if (scores) {
    const ids = candidates.filter(c => (scores[c.id] ?? 0) >= s.thresholds.keep).map(c => c.id)
    const at = await $.clock.now()
    const mean = candidates.length > 0 ? Object.values(scores).reduce((a, b) => a + b, 0) / candidates.length : 0
    await pushCapped($, 'decisions', [decisionOf('keep', `kept ${ids.length}/${candidates.length}`, mean, 'jev', at - t0, at)], DECISIONS)
    if (ids.length > 0) return { ids, source: 'jev' }
  }
  return { ids: keepByRules(candidates), source: 'rules' }
}

/** The focus for the next compaction: kept candidates written up by Haiku, else deterministically. Never throws. */
async function buildFocus($: EngineInterface, s: Settings, key: string, messages: Msg[], contextPercent: number | null): Promise<AdvFocus | undefined> {
  const candidates = extractCandidates(messages)
  if (candidates.length === 0) return undefined
  const work = remainingWork(messages)
  const { ids, source } = await keepIds($, s, key, work, candidates)
  const kept = candidates.filter(c => ids.includes(c.id))
  let text = ''
  try {
    const r = await $.model.complete({ model: 'haiku', ...focusPrompt({ remainingWork: work, kept }), maxTokens: 400, timeoutMs: HAIKU_TIMEOUT_MS })
    if (r.isAnswered) text = cleanModelText(r.text, 700)
  } catch {
    // Falls through to the deterministic focus.
  }
  const isFallback = !text
  return { text: text || fallbackFocus({ remainingWork: work, kept }), kept: ids, source: isFallback ? 'fallback' : source, at: await $.clock.now(), contextPercent }
}

// ---- the numbers -----------------------------------------------------------------------------------

/** The numbers the rules read now; `turnsSinceAdvice` is the stored count. */
async function snapshotOf($: EngineInterface): Promise<Snapshot> {
  const [usage, model, turns] = await Promise.all([$.session.usage(), $.session.model(), $.session.turns()])
  const limit = (kind: string) => usage.rateLimits.find(r => r.kind === kind)?.percentUsed ?? null
  return {
    contextPercent: usage.context.percent ?? null,
    contextTokens: usage.context.tokens ?? null,
    fiveHourPercent: limit('five_hour'),
    sevenDayPercent: limit('seven_day'),
    costUsd: usage.cost?.usd ?? null,
    model,
    turns,
    compactions: await read($, compactionsAtom),
    turnsSinceAdvice: await read($, turnsSinceAdviceAtom),
    cacheWarm: await read($, cacheWarmAtom),
  }
}

// ---- acting on advice ------------------------------------------------------------------------------

/** What the compaction should keep when no precomputed focus exists: the rules' picks, written deterministically. */
async function focusNow($: EngineInterface): Promise<string> {
  const stored = await read($, focusAtom)
  if (stored) return stored.text
  const messages = await messagesOf($)
  const candidates = extractCandidates(messages)
  const ids = keepByRules(candidates)
  return fallbackFocus({ remainingWork: remainingWork(messages), kept: candidates.filter(c => ids.includes(c.id)) })
}

/** One more compaction of the main conversation: the stored focus is spent and the size baseline restarts. */
async function countCompaction($: EngineInterface) {
  await update($, compactionsAtom, n => n + 1)
  await update($, focusAtom, () => null)
  await update($, lastSeenAtom, () => null)
}

type CompactOutcome = { instructions: string; failure?: string }

/**
 * A compaction with the focus as its instructions. Under this plugin's own call the session.compact hook
 * is skipped (and where managed settings bypass user plugins it never runs), so the compaction is counted here
 * unless the hook already did.
 */
async function compactWithFocus($: EngineInterface): Promise<CompactOutcome> {
  const instructions = await focusNow($)
  const before = await read($, compactionsAtom)
  try {
    const r = await $.session.compact({ instructions })
    if (!r.messages) return { instructions, failure: r.skip }
  } catch (err) {
    return { instructions, failure: errMsg(err) }
  }
  if ((await read($, compactionsAtom)) === before) await countCompaction($)
  return { instructions }
}

/** The pending handoff note if it is fresh. It is deleted either way, so it is delivered at most once. */
async function takeHandoff($: EngineInterface): Promise<string | undefined> {
  const saved = await $.store.get('handoff').catch(() => undefined)
  if (!saved || typeof saved !== 'object') return undefined
  const { text, at } = saved as { text?: unknown; at?: unknown }
  await $.store.delete('handoff').catch(() => undefined)
  if (typeof text !== 'string' || typeof at !== 'number' || (await $.clock.now()) - at > HANDOFF_TTL_MS) return undefined
  return `Handoff note from the previous session (q-advisor):\n${text}`
}

/** Writes the handoff note a fresh session starts from to the store (Haiku, else deterministic). */
async function writeHandoff($: EngineInterface) {
  const messages = await messagesOf($)
  const candidates = extractCandidates(messages)
  const ids = keepByRules(candidates)
  const input = { remainingWork: remainingWork(messages), kept: candidates.filter(c => ids.includes(c.id)), recentWork: summarizeRecent(messages).recentWork }
  let text = ''
  try {
    const r = await $.model.complete({ model: 'haiku', ...handoffPrompt(input), maxTokens: 700, timeoutMs: HAIKU_TIMEOUT_MS })
    if (r.isAnswered) text = cleanModelText(r.text, 1200)
  } catch {
    // Falls through to the deterministic note.
  }
  await $.store.set('handoff', { text: text || fallbackHandoff(input), at: await $.clock.now() })
}

/** Runs the advice's action; when the engine refuses, the command goes to the prompt box instead. */
async function runAdvice($: EngineInterface, advice: Advice) {
  let fallback = advice.command
  try {
    if (isCompactKind(advice.kind)) {
      const { instructions, failure } = await compactWithFocus($)
      if (!failure) return
      fallback = `/compact ${instructions}`
      throw new Error(failure)
    }
    if (advice.wants === 'handoff') await writeHandoff($)
    const [name = '', ...args] = advice.command.replace(/^\//, '').split(/\s+/)
    await $.command.run({ command: name, args: args.join(' ') })
  } catch (err) {
    await $.prompt.suggest({ text: fallback }).catch(() => undefined)
    $.ui.toast(`q-advisor: could not run ${advice.command} (${errMsg(err)}); it is in the prompt box, Tab to take it`, { timeoutMs: 8000 })
  }
}

async function acceptAdvice($: EngineInterface) {
  const advice = await read($, adviceAtom)
  if (!advice || (await read($, busyAtom))) return
  await update($, busyAtom, () => true)
  try {
    await clearAdvice($, 'accepted')
    await runAdvice($, advice)
  } finally {
    await update($, busyAtom, () => false)
  }
}

// ---- /q-advisor ------------------------------------------------------------------------------------

/** The kinds a `mute` word names: an exact kind or a family (context, model, task, limits). */
const kindsOf = (word: string | undefined): AdviceKind[] => {
  if (word && (ADVICE_KINDS as readonly string[]).includes(word)) return [word as AdviceKind]
  return (word && KIND_FAMILIES[word]) || []
}

/**
 * What the hooks share while a turn runs, not worth a state atom (a reload may lose it): `generation` is
 * bumped by each prompt of the person, so work started for an earlier one does not show its result;
 * `judging` is the running judgement of the latest prompt, which the turn end waits for (bounded).
 */
type Flow = { generation: number; judging: Promise<void> }

/**
 * Heuristic for a compaction or /clear that never reached our hooks (managed settings bypass them): the turn
 * count went down (a /clear: the story starts over), or the context fell by more than half since the last
 * turn end (a compaction). Returns the compaction count to use. The baseline is reset by our own compactions.
 */
async function detectBypassedCompaction($: EngineInterface, snap: Snapshot): Promise<number> {
  const prev = await read($, lastSeenAtom)
  await update($, lastSeenAtom, () => ({ tokens: snap.contextTokens, turns: snap.turns }))
  if (!prev) return snap.compactions
  if (snap.turns < prev.turns) {
    await update($, compactionsAtom, () => 0)
    await update($, focusAtom, () => null)
    return 0
  }
  if (prev.tokens !== null && snap.contextTokens !== null && snap.contextTokens < prev.tokens * 0.5) {
    await countCompaction($)
    await update($, lastSeenAtom, () => ({ tokens: snap.contextTokens, turns: snap.turns }))
    return snap.compactions + 1
  }
  return snap.compactions
}

/** Settings, state and the advice for a turn end; runs detached from turn.complete. */
async function adviseAtTurnEnd($: EngineInterface, options: PluginOptions, flow: Flow, myGeneration: number) {
  const s = await settingsOf($, options)
  if (s.mode === 'off') return
  const key = await jevKeyOf($, options, s)
  await within($, JUDGE_WAIT_MS, flow.judging)
  const since = (await read($, turnsSinceAdviceAtom)) + 1
  await update($, turnsSinceAdviceAtom, () => since)
  let snap = { ...(await snapshotOf($)), turnsSinceAdvice: since }
  snap = { ...snap, compactions: await detectBypassedCompaction($, snap) }
  const messages = await messagesOf($)

  // Only a rule that needs "is the task finished" asks: a big context, a long compaction streak, or a new task.
  const verdict = (await read($, verdictAtom)) ?? undefined
  const ctx = snap.contextPercent
  const needsFinished = (ctx !== null && ctx >= s.compactAt) || snap.compactions >= s.freshAfter || (ctx !== null && ctx >= s.newTaskAt && verdict?.relation?.label === 'new-task')
  const finished = needsFinished ? await judgeFinished($, s, key, summarizeRecent(messages)) : undefined
  await update($, finishedAtom, () => finished ?? null)

  const dismissals = dismissalsOf(await listOf<AdviceRecord>($, 'adviceLog'))
  const advice = decide({ snap, settings: s, ...(verdict ? { prompt: verdict } : {}), ...(finished !== undefined ? { finished } : {}), dismissals })
  if (myGeneration !== flow.generation) return

  if (advice) {
    const at = await $.clock.now()
    const isShown = s.mode === 'on'
    await update($, turnsSinceAdviceAtom, () => 0)
    // Shadow mode logs what it would have shown, as an expired (never shown) record.
    await pushCapped($, 'adviceLog', [{ at, kind: advice.kind, mode: s.mode, shown: isShown, outcome: isShown ? 'pending' : 'expired' } satisfies AdviceRecord], ADVICE_LOG)
    if (isShown) {
      await update($, adviceAtAtom, () => at)
      await update($, adviceAtom, () => advice)
      if (advice.kind === 'compact-urgent') $.ui.toast(adviceLine(advice), { timeoutMs: 8000 })
    }
  }
  await update($, cacheWarmAtom, () => null)

  // The focus for the autocompact that may come: computed here, off the compaction's own path.
  const before = await read($, compactionsAtom)
  let focus = await read($, focusAtom)
  if (s.focusCompact && shouldPrecomputeFocus(snap, s, focus?.contextPercent ?? null)) {
    const built = await buildFocus($, s, key, messages, snap.contextPercent)
    if (built && before === (await read($, compactionsAtom))) {
      focus = built
      await update($, focusAtom, () => built)
    }
  }
  if (advice && s.mode === 'on' && isCompactKind(advice.kind) && focus && myGeneration === flow.generation) {
    await $.prompt.suggest({ text: COMPACT_COMMAND }).catch(() => undefined)
  }
}

export const register: Register = (on, options) => {
  const flow: Flow = { generation: 0, judging: Promise.resolve() }

  on('session.start', async ($, e, next) => {
    try {
      await loadSettings($, options)
    } catch {
      // The defaults stand when the store cannot be read.
    }
    await $.command.register({
      name: COMMAND,
      description: 'Context advice: compact with a focus, start fresh, or switch model',
      argumentHint: 'compact | on | shadow | off | stats | focus | mute <kind> | unmute <kind> | config [<key> <value>] | reset',
    })
    return next(e)
  })

  // ---- the prompt: classify it in the background, never delay it -----------------------------------

  on('prompt.submit', async ($, e, next) => {
    if (!USER_ORIGINS.has(e.origin?.kind) || e.isMeta || e.command) return next(e)
    flow.generation += 1
    const myGeneration = flow.generation
    await clearAdvice($, 'expired')
    await update($, verdictAtom, () => null)
    // Fallback for a /clear whose classic.SessionStart never reached us: the first prompt of the fresh session carries the note.
    let context = e.context
    if ((await $.store.get('handoff').catch(() => undefined)) !== undefined && (await $.session.turns()) === 0) {
      const note = await takeHandoff($)
      if (note) context = [...(e.context ?? []), note]
    }
    const s = await settingsOf($, options)
    if (s.mode !== 'off' && !isTrivialPrompt(e.text, s.minPromptChars)) {
      // The rows before this prompt, read now: the prompt itself is judged against them.
      const messages = await messagesOf($)
      let release = () => {}
      flow.judging = new Promise<void>(resolve => {
        release = resolve
      })
      const text = e.text
      $.clock.after(0, () => {
        void (async () => {
          const key = await jevKeyOf($, options, s)
          const verdict = await judgePrompt($, s, key, text, summarizeRecent(messages))
          if (myGeneration === flow.generation) await update($, verdictAtom, () => verdict)
        })()
          .catch(() => undefined)
          .finally(release)
      })
    }
    return next(context === e.context ? e : { ...e, context })
  }).catch(($, e, next) => next(e))

  // ---- the turn end: decide, show or log, precompute the focus -------------------------------------

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId || e.isAborted || e.reason !== 'answer') return r
    const s = await settingsOf($, options)
    if (s.mode === 'off') return r
    // Detached: the Jev and Haiku calls (and the focus write-up, up to 8 s) must not hold the turn's end,
    // and the next prompt supersedes them (the generation check) rather than waits for them.
    const myGeneration = flow.generation
    $.clock.after(0, () => {
      void adviseAtTurnEnd($, options, flow, myGeneration).catch(() => undefined)
    })
    return r
  }).catch(($, e, next) => next(e))

  // ---- autocompact: the stored focus, nothing computed here ----------------------------------------

  on('session.compact', async ($, e, next) => {
    const s = await settingsOf($, options)
    const isMain = !e.agentId
    let input = e
    if (e.trigger === 'auto' && isMain && s.focusCompact && s.mode !== 'off') {
      const focus = await read($, focusAtom)
      if (focus) input = { ...e, instructions: mergeInstructions(e.instructions, focus.text) }
    }
    const r = await next(input)
    if (isMain && e.trigger !== 'precompute' && r.messages) {
      await countCompaction($)
      // A compaction the person ran themselves settles a pending compact advice.
      const advice = await read($, adviceAtom)
      if (advice && isCompactKind(advice.kind)) await clearAdvice($, 'accepted')
    }
    return r
  }).catch(($, e, next) => next(e))

  // ---- /clear carries the handoff note; a resume may have a cold cache -----------------------------

  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    if (e.source === 'resume') {
      if (typeof e.prompt_cache_likely_expired === 'boolean') await update($, cacheWarmAtom, () => !e.prompt_cache_likely_expired)
      return r
    }
    if (e.source !== 'clear') return r
    // A /clear starts the session's story over.
    await update($, compactionsAtom, () => 0)
    await update($, focusAtom, () => null)
    await update($, verdictAtom, () => null)
    await update($, finishedAtom, () => null)
    await update($, turnsSinceAdviceAtom, () => 99)
    await clearAdvice($, 'expired')
    const note = await takeHandoff($)
    return note ? { ...r, additionalContext: [...(r.additionalContext ?? []), note] } : r
  }).catch(($, e, next) => next(e))

  // ---- /q-advisor ----------------------------------------------------------------------------------

  on('command.run', { command: COMMAND }, async ($, e) => {
    const args = e.args.trim()
    const [sub = '', ...rest] = args.split(/\s+/).filter(Boolean)
    const s = await settingsOf($, options)
    switch (sub) {
      case '': {
        const snap = await snapshotOf($)
        const key = await jevKeyOf($, options, s)
        const verdict = (await read($, verdictAtom)) ?? undefined
        const finished = (await read($, finishedAtom)) ?? undefined
        const dismissals = dismissalsOf(await listOf<AdviceRecord>($, 'adviceLog'))
        const advice = (await read($, adviceAtom)) ?? decide({ snap, settings: s, ...(verdict ? { prompt: verdict } : {}), ...(finished !== undefined ? { finished } : {}), dismissals })
        return { text: formatReport({ snap, settings: s, ...(verdict ? { prompt: verdict } : {}), ...(finished !== undefined ? { finished } : {}), advice, focus: await read($, focusAtom), jevKey: !!key }) }
      }
      case 'on':
      case 'shadow':
      case 'off': {
        await $.store.set('overrides', { ...(await overridesOf($)), mode: sub })
        await loadSettings($, options)
        if (sub !== 'on') await clearAdvice($, 'expired')
        return { text: `q-advisor ${sub}.` }
      }
      case 'compact': {
        if (await read($, busyAtom)) return { text: 'q-advisor: an action is already running.', exitCode: 1 }
        // The engine refuses a compaction raised from inside a command hook (it would run under the command's own
        // turn), so it starts once the command has returned; the outcome is a toast.
        $.clock.after(0, () => {
          void (async () => {
            const { instructions, failure } = await compactWithFocus($)
            if (failure) return $.ui.toast(`q-advisor: could not compact (${failure}). Try again when Claude is idle.`, { timeoutMs: 8000 })
            const advice = await read($, adviceAtom)
            if (advice && isCompactKind(advice.kind)) await clearAdvice($, 'accepted')
            $.ui.toast(`q-advisor: compacted with a focus of ${instructions.length} characters.`)
          })().catch(() => undefined)
        })
        return { text: 'q-advisor: compacting with the focus (plan, decisions, changed files)...' }
      }
      case 'stats':
        return { text: formatStats(await listOf<Decision>($, 'decisions'), await listOf<AdviceRecord>($, 'adviceLog')) }
      case 'focus': {
        const focus = await read($, focusAtom)
        return { text: focus ? `Focus for the next autocompact (${focus.source}, at context ${focus.contextPercent ?? '?'}%):\n${focus.text}` : `No focus yet: it is computed at a turn end from context ${s.focusAt}%.` }
      }
      case 'mute':
      case 'unmute': {
        const kinds = kindsOf(rest[0])
        if (kinds.length === 0) return { text: `Usage: /q-advisor ${sub} <kind>. Kinds: ${[...Object.keys(KIND_FAMILIES), ...ADVICE_KINDS].join(', ')}`, exitCode: 2 }
        const muted = sub === 'mute' ? [...new Set([...s.muted, ...kinds])] : s.muted.filter(k => !kinds.includes(k))
        await $.store.set('overrides', { ...(await overridesOf($)), muted })
        await loadSettings($, options)
        return { text: `q-advisor ${sub}d ${kinds.join(', ')}. Muted: ${muted.join(', ') || 'none'}.` }
      }
      case 'config': {
        const ov = await overridesOf($)
        if (rest.length === 0) return { text: showSettings(options, ov) }
        const [key = '', ...value] = rest
        const result = applyConfig(ov, key, value.join(' '))
        await $.store.set('overrides', result.overrides)
        await loadSettings($, options)
        return { text: result.message }
      }
      case 'reset': {
        for (const key of ['overrides', 'decisions', 'adviceLog', 'handoff']) await $.store.delete(key).catch(() => undefined)
        await loadSettings($, options)
        await update($, focusAtom, () => null)
        await update($, verdictAtom, () => null)
        await clearAdvice($, 'expired')
        return { text: 'q-advisor reset: overrides, logs and handoff note cleared.' }
      }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  }).catch(() => ({ text: 'q-advisor: the command failed; /q-advisor help lists the subcommands.', exitCode: 1 }))

  // ---- the band: one line of advice and its button -------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey || e.props.isWorking) return next(e)
    const s = await read($, settingsAtom)
    const advice = await read($, adviceAtom)
    if (!advice || s?.mode !== 'on') return next(e)
    const { Box, Button, Text } = $.ui.resolve(e)
    const label = isCompactKind(advice.kind) ? 'Compact' : advice.command.replace(/^\//, '')
    return (
      <Box flexDirection="row" gap={2}>
        <Text key="advice" wrap="truncate" color={WARN_HEX}>
          {adviceLine(advice)}
        </Text>
        <Button key="accept" label={label} variant="primary" onPress={() => acceptAdvice($)} />
        <Button key="dismiss" label="Dismiss" onPress={() => clearAdvice($, 'dismissed')} />
      </Box>
    )
  })
}
