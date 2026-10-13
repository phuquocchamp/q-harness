import { expect, test } from 'claude-code/testing'

import {
  BUILTIN_RULES,
  clip,
  compileRules,
  displayWidth,
  headTail,
  matchRule,
  parseConfig,
  parseTestSummary,
  pickSettings,
  previewTail,
  stripAnsi,
} from '../hooks/lib'

test('clip counts terminal cells, not UTF-16 units', () => {
  expect(displayWidth('日本語')).toBe(6)
  expect(clip('日本語テキスト', 7)).toBe('日本語…')
  expect(clip('short', 10)).toBe('short')
  expect(stripAnsi('\x1b[31mred\x1b[0m')).toBe('red')
})

test('the preview keeps room for stdout when stderr is noisy', () => {
  const out = ['a', 'b', 'c', 'result']
  const err = ['w1', 'w2', 'w3', 'w4']
  expect(previewTail(out, err, 4).map(l => l.t)).toEqual(['c', 'result', 'w3', 'w4'])
  expect(previewTail([], err, 4).map(l => l.t)).toEqual(err)
})

test('headTail splits around a gap', () => {
  const all = Array.from({ length: 10 }, (_, i) => ({ t: String(i), err: false }))
  const r = headTail(all, 4)
  expect(r.head.map(l => l.t)).toEqual(['0', '1'])
  expect(r.tail.map(l => l.t)).toEqual(['8', '9'])
  expect(r.gap).toBe(6)
})

test('test summaries of common runners', () => {
  expect(parseTestSummary('Tests:       1 failed, 41 passed, 2 skipped, 44 total')).toEqual({ passed: 41, failed: 1, skipped: 2 })
  expect(parseTestSummary('===== 3 passed, 1 skipped in 0.12s =====')).toEqual({ passed: 3, failed: 0, skipped: 1 })
  expect(parseTestSummary('test result: ok. 12 passed; 0 failed; 1 ignored; 0 measured')).toEqual({ passed: 12, failed: 0, skipped: 1 })
  expect(parseTestSummary('--- PASS: TestA (0.00s)\n--- FAIL: TestB (0.01s)')).toEqual({ passed: 1, failed: 1, skipped: 0 })
  expect(parseTestSummary('hello world')).toBeUndefined()
})

test('guard rules compile and skip invalid patterns', () => {
  const rules = compileRules([...BUILTIN_RULES, { pattern: '(', why: 'broken' }, { pattern: 'kubectl\\s+delete', why: 'k8s' }])
  expect(rules.length).toBe(BUILTIN_RULES.length + 1)
  expect(matchRule('kubectl delete pod x', rules)?.why).toBe('k8s')
})

test('config values are validated', () => {
  expect(parseConfig('previewLines', '8')).toEqual({ previewLines: 8 })
  expect(parseConfig('guard', 'off')).toEqual({ guard: false })
  expect(parseConfig('unfoldGroups', 'on')).toEqual({ unfoldGroups: true })
  expect(typeof parseConfig('previewLines', '-1')).toBe('string')
  // Settings removed in 0.4 are unknown now.
  expect(typeof parseConfig('commandBg', '#112233')).toBe('string')
  expect(typeof parseConfig('maskSecrets', 'on')).toBe('string')
})

test('stored settings are read back with stale keys dropped and bad values defaulted', () => {
  expect(pickSettings({ previewLines: 8, guard: false, band: true, guardRules: [] })).toEqual({ previewLines: 8, guard: false, unfoldGroups: true })
  expect(pickSettings({ previewLines: -3, guard: 'yes' })).toEqual({ previewLines: 4, guard: true, unfoldGroups: true })
  expect(pickSettings(undefined)).toEqual({ previewLines: 4, guard: true, unfoldGroups: true })
})
