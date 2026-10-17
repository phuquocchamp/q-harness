import { expect, test } from 'claude-code/testing'

import type { AdviceRecord, PromptVerdict, Settings, Snapshot } from '../hooks/lib/contract'
import { decide, dismissalsOf, modelFamily, modelFit, shouldPrecomputeFocus } from '../hooks/lib/decide'

const settings: Settings = {
  mode: 'on', focusCompact: true, jev: true, jevModel: 'jev-latest',
  compactAt: 60, urgentAt: 80, focusAt: 70, newTaskAt: 30, freshAfter: 3, rateLimitAt: 80, quietTurns: 3,
  minPromptChars: 25, thresholds: { relation: 0.9, size: 0.7, finished: 0.7, keep: 0.5 }, muted: [],
}
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  contextPercent: 10, contextTokens: 100_000, fiveHourPercent: 10, sevenDayPercent: 10, costUsd: 1, model: 'claude-sonnet-5-5',
  turns: 10, compactions: 0, turnsSinceAdvice: 10, cacheWarm: true, ...over,
})
const verdict = (over: Partial<PromptVerdict> = {}): PromptVerdict => ({ source: 'jev', latencyMs: 100, at: 0, ...over })
const record = (kind: AdviceRecord['kind'], outcome: AdviceRecord['outcome']): AdviceRecord => ({ at: 0, kind, mode: 'on', shown: true, outcome })

test('modelFamily: ids, aliases and [1m] suffixes', () => {
  expect(modelFamily('claude-opus-5-5')).toBe('opus')
  expect(modelFamily('claude-sonnet-5-5')).toBe('sonnet')
  expect(modelFamily('claude-haiku-5-5')).toBe('haiku')
  expect(modelFamily('opus')).toBe('opus')
  expect(modelFamily('sonnet[1m]')).toBe('sonnet')
  expect(modelFamily('claude-opus-5-5[1m]')).toBe('opus')
  expect(modelFamily('gpt-x')).toBe('other')
})

test('modelFit: only two-step mismatches', () => {
  expect(modelFit('deep', 'haiku')).toBe('opus')
  expect(modelFit('trivial', 'opus')).toBe('sonnet')
  expect(modelFit('deep', 'sonnet')).toBeNull()
  expect(modelFit('trivial', 'sonnet')).toBeNull()
  expect(modelFit('routine', 'opus')).toBeNull()
  expect(modelFit('trivial', 'other')).toBeNull()
})

test('shouldPrecomputeFocus: from focusAt, then every 5 points', () => {
  expect(shouldPrecomputeFocus(snap({ contextPercent: 69 }), settings, null)).toBe(false)
  expect(shouldPrecomputeFocus(snap({ contextPercent: 70 }), settings, null)).toBe(true)
  expect(shouldPrecomputeFocus(snap({ contextPercent: 74 }), settings, 70)).toBe(false)
  expect(shouldPrecomputeFocus(snap({ contextPercent: 75 }), settings, 70)).toBe(true)
  expect(shouldPrecomputeFocus(snap({ contextPercent: null }), settings, null)).toBe(false)
  expect(shouldPrecomputeFocus(snap({ contextPercent: 90 }), { ...settings, focusCompact: false }, null)).toBe(false)
})

test('dismissalsOf: consecutive per kind, reset by accept', () => {
  const log = [
    record('compact-now', 'dismissed'), record('compact-now', 'dismissed'), record('new-task', 'dismissed'),
    record('compact-now', 'accepted'), record('compact-now', 'dismissed'), record('new-task', 'pending'), record('new-task', 'dismissed'),
  ]
  expect(dismissalsOf(log)).toEqual({ 'compact-now': 1, 'new-task': 2 })
  expect(dismissalsOf([])).toEqual({})
})

test('compact-urgent: high context while the task is unfinished or unknown', () => {
  const a = decide({ snap: snap({ contextPercent: 83 }), settings, finished: 0.1 })
  expect(a?.kind).toBe('compact-urgent')
  expect(a?.command).toBe('/compact')
  expect(a?.wants).toBe('focus')
  expect(a?.reason).toContain('context 83% mid-task')
  expect(decide({ snap: snap({ contextPercent: 83 }), settings })?.kind).toBe('compact-urgent')
  expect(decide({ snap: snap({ contextPercent: 79 }), settings, finished: 0.1 })).toBeNull()
  // finished: no urgency, compact-now takes over
  expect(decide({ snap: snap({ contextPercent: 83 }), settings, finished: 0.93 })?.kind).toBe('compact-now')
  // ambiguous finished: neither urgent nor finished
  expect(decide({ snap: snap({ contextPercent: 83 }), settings, finished: 0.5 })).toBeNull()
})

test('compact-now: context past compactAt and the task finished', () => {
  const a = decide({ snap: snap({ contextPercent: 64 }), settings, finished: 0.93 })
  expect(a).toEqual({ kind: 'compact-now', reason: 'context 64% · task finished (p 0.93)', command: '/compact', wants: 'focus' })
  expect(decide({ snap: snap({ contextPercent: 59 }), settings, finished: 0.93 })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: 64 }), settings, finished: 0.69 })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: 64 }), settings })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: null }), settings, finished: 0.99 })).toBeNull()
})

test('new-task: new task, previous one finished, context above newTaskAt', () => {
  const prompt = verdict({ relation: { label: 'new-task', p: 0.95 } })
  const a = decide({ snap: snap({ contextPercent: 45 }), settings, prompt, finished: 0.9 })
  expect(a?.kind).toBe('new-task')
  expect(a?.command).toBe('/clear')
  expect(a?.wants).toBe('handoff')
  // first turn of a session: nothing came before, so nothing to clear
  expect(decide({ snap: snap({ contextPercent: 45, turns: 1 }), settings, prompt, finished: 0.9 })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: 45, turns: 2 }), settings, prompt, finished: 0.9 })?.kind).toBe('new-task')
  expect(decide({ snap: snap({ contextPercent: 25 }), settings, prompt, finished: 0.9 })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: 45 }), settings, prompt, finished: 0.5 })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: 45 }), settings, prompt: verdict({ relation: { label: 'new-task', p: 0.85 } }), finished: 0.9 })).toBeNull()
  expect(decide({ snap: snap({ contextPercent: 45 }), settings, prompt: verdict({ relation: { label: 'continuation', p: 0.95 } }), finished: 0.9 })).toBeNull()
})

test('fresh-session: after freshAfter compactions with a finished task', () => {
  const a = decide({ snap: snap({ compactions: 3 }), settings, finished: 0.9 })
  expect(a?.kind).toBe('fresh-session')
  expect(a?.command).toBe('/clear')
  expect(a?.wants).toBe('handoff')
  expect(decide({ snap: snap({ compactions: 2 }), settings, finished: 0.9 })).toBeNull()
  expect(decide({ snap: snap({ compactions: 3 }), settings, finished: 0.4 })).toBeNull()
})

test('rate-limit: trivial or routine task on Opus near the five-hour limit', () => {
  const opus = snap({ model: 'claude-opus-5-5', fiveHourPercent: 85, cacheWarm: true })
  const a = decide({ snap: opus, settings, prompt: verdict({ size: { label: 'routine', p: 0.8 } }) })
  expect(a?.kind).toBe('rate-limit')
  expect(a?.command).toBe('/model sonnet')
  expect(a?.reason).toContain('85%')
  expect(decide({ snap: opus, settings, prompt: verdict({ size: { label: 'deep', p: 0.9 } }) })).toBeNull()
  expect(decide({ snap: opus, settings, prompt: verdict({ size: { label: 'routine', p: 0.6 } }) })).toBeNull()
  expect(decide({ snap: { ...opus, fiveHourPercent: 79 }, settings, prompt: verdict({ size: { label: 'routine', p: 0.8 } }) })).toBeNull()
  expect(decide({ snap: { ...opus, model: 'sonnet' }, settings, prompt: verdict({ size: { label: 'routine', p: 0.8 } }) })).toBeNull()
})

test('model-fit: two-step mismatch when the cache is cold or the context small', () => {
  const trivial = verdict({ size: { label: 'trivial', p: 0.9 } })
  const deep = verdict({ size: { label: 'deep', p: 0.9 } })
  const opus = snap({ model: 'claude-opus-5-5', contextTokens: 5_000 })
  expect(decide({ snap: opus, settings, prompt: trivial })).toMatchObject({ kind: 'model-fit', command: '/model sonnet' })
  expect(decide({ snap: snap({ model: 'haiku', contextTokens: 50_000, cacheWarm: false }), settings, prompt: deep })).toMatchObject({ kind: 'model-fit', command: '/model opus' })
  // warm cache and a big context: switching would cost a cache rebuild
  expect(decide({ snap: { ...opus, contextTokens: 50_000, cacheWarm: true }, settings, prompt: trivial })).toBeNull()
  expect(decide({ snap: { ...opus, contextTokens: null, cacheWarm: null }, settings, prompt: trivial })).toBeNull()
  expect(decide({ snap: opus, settings, prompt: verdict({ size: { label: 'trivial', p: 0.5 } }) })).toBeNull()
  expect(decide({ snap: snap({ contextTokens: 5_000 }), settings, prompt: deep })).toBeNull()
})

test('side-question guard: no new-task, rate-limit or model-fit', () => {
  const side = { label: 'side-question' as const, p: 0.95 }
  const trivial = { label: 'trivial' as const, p: 0.9 }
  const opus = snap({ model: 'claude-opus-5-5', contextTokens: 5_000, fiveHourPercent: 90 })
  expect(decide({ snap: opus, settings, prompt: verdict({ relation: side, size: trivial }) })).toBeNull()
  // a weak side-question verdict does not guard
  expect(decide({ snap: opus, settings, prompt: verdict({ relation: { label: 'side-question', p: 0.5 }, size: trivial }) })?.kind).toBe('rate-limit')
  // context advice is unaffected
  expect(decide({ snap: snap({ contextPercent: 70 }), settings, prompt: verdict({ relation: side }), finished: 0.9 })?.kind).toBe('compact-now')
})

test('priority order', () => {
  const prompt = verdict({ relation: { label: 'new-task', p: 0.95 }, size: { label: 'trivial', p: 0.9 } })
  const all = snap({ contextPercent: 85, compactions: 4, model: 'claude-opus-5-5', fiveHourPercent: 90, contextTokens: 5_000 })
  expect(decide({ snap: all, settings, prompt })?.kind).toBe('compact-urgent')
  expect(decide({ snap: all, settings, prompt, finished: 0.9 })?.kind).toBe('new-task')
  expect(decide({ snap: all, settings: { ...settings, muted: ['new-task'] }, prompt, finished: 0.9 })?.kind).toBe('compact-now')
  expect(decide({ snap: all, settings: { ...settings, muted: ['new-task', 'compact-now'] }, prompt, finished: 0.9 })?.kind).toBe('fresh-session')
  expect(decide({ snap: all, settings: { ...settings, muted: ['new-task', 'compact-now', 'fresh-session'] }, prompt, finished: 0.9 })?.kind).toBe('rate-limit')
  expect(decide({ snap: all, settings: { ...settings, muted: ['new-task', 'compact-now', 'fresh-session', 'rate-limit'] }, prompt, finished: 0.9 })?.kind).toBe('model-fit')
})

test('gates: off, quiet turns, muted', () => {
  const hot = snap({ contextPercent: 90 })
  expect(decide({ snap: hot, settings: { ...settings, mode: 'off' } })).toBeNull()
  expect(decide({ snap: hot, settings: { ...settings, mode: 'shadow' } })?.kind).toBe('compact-urgent')
  expect(decide({ snap: { ...hot, turnsSinceAdvice: 2 }, settings })).toBeNull()
  expect(decide({ snap: { ...hot, turnsSinceAdvice: 3 }, settings })?.kind).toBe('compact-urgent')
  expect(decide({ snap: hot, settings: { ...settings, muted: ['compact-urgent'] } })).toBeNull()
})

test('dismissal backoff: five dismissals raise the thresholds halfway to 1', () => {
  const cool = snap({ contextPercent: 64 })
  // finished threshold 0.7 -> 0.85
  expect(decide({ snap: cool, settings, finished: 0.8, dismissals: { 'compact-now': 4 } })?.kind).toBe('compact-now')
  expect(decide({ snap: cool, settings, finished: 0.8, dismissals: { 'compact-now': 5 } })).toBeNull()
  expect(decide({ snap: cool, settings, finished: 0.9, dismissals: { 'compact-now': 5 } })?.kind).toBe('compact-now')
  // other kinds are unaffected
  expect(decide({ snap: cool, settings, finished: 0.8, dismissals: { 'new-task': 9 } })?.kind).toBe('compact-now')
  // size threshold 0.7 -> 0.85
  const opus = snap({ model: 'claude-opus-5-5', contextTokens: 5_000 })
  const trivial = (p: number) => verdict({ size: { label: 'trivial', p } })
  expect(decide({ snap: opus, settings, prompt: trivial(0.8), dismissals: { 'model-fit': 5 } })).toBeNull()
  expect(decide({ snap: opus, settings, prompt: trivial(0.9), dismissals: { 'model-fit': 5 } })?.kind).toBe('model-fit')
})
