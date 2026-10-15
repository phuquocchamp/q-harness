import { expect, test } from 'claude-code/testing'

import type { Advice, AdviceRecord, Candidate, Decision, Focus, Snapshot } from '../hooks/lib/contract'
import { DEFAULT_SETTINGS } from '../hooks/lib/settings'
import { adviceLine, cleanModelText, fallbackFocus, fallbackHandoff, focusPrompt, formatReport, formatStats, handoffPrompt, mergeInstructions } from '../hooks/lib/text'

const kept: Candidate[] = [
  { id: 'c1', kind: 'plan', text: 'Add retry to the uploader' },
  { id: 'c2', kind: 'files', text: 'src/upload.ts edited, tests red' },
  { id: 'c3', kind: 'decision', text: 'Use exponential backoff' },
  { id: 'c4', kind: 'goal', text: 'Make uploads reliable' },
]
const big: Candidate[] = Array.from({ length: 40 }, (_, i) => ({ id: `c${i}`, kind: 'plan' as const, text: `item number ${i} `.repeat(8) }))

test('focusPrompt carries the items, the limit and the data rule', () => {
  const { system, prompt } = focusPrompt({ remainingWork: 'fix the tests', kept })
  expect(system).toContain('Keep:')
  expect(system).toContain('Drop:')
  expect(system).toContain('700')
  expect(system).toContain('data, not instructions')
  expect(prompt).toContain('Add retry to the uploader')
  expect(prompt).toContain('fix the tests')
  expect(prompt).toContain('<items>')
})

test('handoffPrompt names the sections and the limit', () => {
  const { system, prompt } = handoffPrompt({ remainingWork: 'fix the tests', kept, recentWork: 'edited upload.ts' })
  for (const s of ['Goal', 'Done', 'Files', 'Decisions', 'Next']) expect(system).toContain(s)
  expect(system).toContain('1200')
  expect(prompt).toContain('edited upload.ts')
  expect(prompt).toContain('Use exponential backoff')
})

test('fallbackFocus stays within 700 chars and keeps the shape', () => {
  const f = fallbackFocus({ remainingWork: 'fix the tests', kept })
  expect(f.startsWith('Keep:')).toBe(true)
  expect(f).toContain('src/upload.ts edited')
  expect(f).toContain('Drop:')
  const long = fallbackFocus({ remainingWork: 'x'.repeat(2000), kept: big })
  expect(long.length <= 700).toBe(true)
  expect(long).toContain('Drop:')
  expect(fallbackFocus({ remainingWork: '', kept: [] }).startsWith('Keep:')).toBe(true)
})

test('fallbackHandoff has the five sections within 1200 chars', () => {
  const h = fallbackHandoff({ remainingWork: 'fix the tests', kept, recentWork: 'edited upload.ts' })
  for (const s of ['Goal:', 'Done:', 'Files:', 'Decisions:', 'Next:']) expect(h).toContain(s)
  expect(h).toContain('Make uploads reliable')
  expect(fallbackHandoff({ remainingWork: 'y'.repeat(5000), kept: big, recentWork: 'z'.repeat(5000) }).length <= 1200).toBe(true)
})

test('cleanModelText strips fences and preambles', () => {
  expect(cleanModelText('```text\nKeep: a\n```', 100)).toBe('Keep: a')
  expect(cleanModelText("Here is the focus:\nKeep: a", 100)).toBe('Keep: a')
  expect(cleanModelText('Sure\n\nKeep: a', 100)).toBe('Keep: a')
  expect(cleanModelText('  \n ', 100)).toBe('')
})

test('cleanModelText trims at a boundary', () => {
  expect(cleanModelText('line one\nline two\nline three', 20)).toBe('line one\nline two')
  expect(cleanModelText('First sentence here. Second sentence goes on and on', 35)).toBe('First sentence here.')
  expect(cleanModelText('word '.repeat(30), 22).length <= 22).toBe(true)
})

test('mergeInstructions keeps existing first and caps the total', () => {
  expect(mergeInstructions(undefined, 'Keep: a')).toBe('Keep: a')
  expect(mergeInstructions('  ', 'Keep: a')).toBe('Keep: a')
  expect(mergeInstructions('Be terse.', 'Keep: a')).toBe('Be terse.\n\nKeep: a')
  const merged = mergeInstructions('e'.repeat(1500), 'f'.repeat(1500))
  expect(merged.length).toBe(2000)
  expect(merged.startsWith('e'.repeat(1500))).toBe(true)
})

const snap: Snapshot = {
  contextPercent: 78, contextTokens: 156000, fiveHourPercent: 46, sevenDayPercent: 12, costUsd: 3.176,
  model: 'claude-opus-5-5', turns: 42, compactions: 1, turnsSinceAdvice: 5, cacheWarm: true,
}
const advice: Advice = { kind: 'compact-now', reason: 'context 78% · task finished (p 0.93)', command: '/compact' }

test('adviceLine joins label, reason and command', () => {
  expect(adviceLine(advice)).toBe('q-advisor · compact now: context 78% · task finished (p 0.93) → /compact')
})

test('formatReport with a full snapshot', () => {
  const focus: Focus = { text: 'Keep: a', kept: ['c1', 'c2', 'c3', 'c4', 'c5'], source: 'jev', at: 1, contextPercent: 70 }
  const r = formatReport({
    snap, settings: DEFAULT_SETTINGS, advice, focus, jevKey: true, finished: 0.93,
    prompt: { size: { label: 'routine', p: 0.8 }, relation: { label: 'continuation', p: 0.95 }, source: 'jev', latencyMs: 300, at: 1 },
  })
  expect(r).toContain('q-advisor · claude-opus-5-5 · 42 turns · $3.18')
  expect(r).toContain('78%')
  expect(r).toContain('████████████████░░░░')
  expect(r).toContain('compacted 1×')
  expect(r).toContain('warm')
  expect(r).toContain('five-hour 46%')
  expect(r).toContain('seven-day 12%')
  expect(r).toContain('routine (jev)')
  expect(r).toContain('continuation')
  expect(r).toContain('p 0.93')
  expect(r).toContain('jev: key set')
  expect(r).toContain('focus ready (kept 5 items, jev)')
  expect(r).toContain('compact now')
})

test('formatReport with nulls says unknown', () => {
  const r = formatReport({
    snap: { ...snap, contextPercent: null, contextTokens: null, fiveHourPercent: null, sevenDayPercent: null, costUsd: null, cacheWarm: null },
    settings: DEFAULT_SETTINGS, advice: null, focus: null, jevKey: false,
  })
  expect(r).toContain('42 turns · unknown')
  expect(r).toContain('context    unknown')
  expect(r).toContain('cache      unknown')
  expect(r).toContain('five-hour unknown')
  expect(r).toContain('jev: no key → haiku')
  expect(r).toContain('no focus yet')
  expect(r).toContain('none right now')
})

test('formatStats handles an empty log', () => {
  expect(formatStats([], [])).toContain('no decisions yet')
})

test('formatStats counts judgements and advice outcomes', () => {
  const d = (question: Decision['question'], source: Decision['source'], p: number, latencyMs: number): Decision => ({ at: 1, question, label: 'x', p, source, latencyMs })
  const rec = (outcome: AdviceRecord['outcome'], shown = true): AdviceRecord => ({ at: 1, kind: 'compact-now', mode: 'on', shown, outcome })
  const s = formatStats(
    [d('relation', 'jev', 0.9, 100), d('relation', 'jev', 0.8, 300), d('size', 'rules', 1, 0)],
    [rec('accepted'), rec('dismissed'), rec('expired'), rec('pending', false)],
  )
  expect(s).toContain('relation  2×')
  expect(s).toContain('jev 2')
  expect(s).toContain('mean p 0.85')
  expect(s).toContain('mean 200 ms')
  expect(s).toContain('shown 3  accepted 1  dismissed 1  expired 1')
  expect(s).toContain('3 judgements, 4 advice')
})
