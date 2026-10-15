import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS, applyConfig, resolveSettings, showSettings } from '../hooks/lib/settings'

test('defaults apply with no options or overrides', () => {
  const s = resolveSettings({}, {})
  expect(s).toEqual(DEFAULT_SETTINGS)
  expect(s.thresholds).toEqual({ relation: 0.9, size: 0.7, finished: 0.7, keep: 0.5 })
  s.muted.push('model-fit')
  expect(resolveSettings({}, {}).muted).toEqual([])
})

test('overrides win over options win over defaults', () => {
  expect(resolveSettings({ mode: 'on', focusCompact: 'off' }, {}).mode).toBe('on')
  expect(resolveSettings({ focusCompact: 'off' }, {}).focusCompact).toBe(false)
  expect(resolveSettings({ mode: 'on' }, { mode: 'off' }).mode).toBe('off')
  expect(resolveSettings({}, { jev: false, compactAt: 50, 'thresholds.size': 0.8, muted: ['model-fit', 'bogus'] })).toMatchObject({
    jev: false, compactAt: 50, thresholds: { relation: 0.9, size: 0.8, finished: 0.7, keep: 0.5 }, muted: ['model-fit'],
  })
  expect(resolveSettings({}, { thresholds: { relation: 0.95 } }).thresholds.relation).toBe(0.95)
})

test('bad values are ignored', () => {
  const s = resolveSettings({ mode: 'loud', focusCompact: 'maybe' }, { compactAt: 0, urgentAt: 100, quietTurns: 21, minPromptChars: -1, 'thresholds.keep': 0.3, jev: 'yes', nope: 1 })
  expect(s).toEqual(DEFAULT_SETTINGS)
})

test('applyConfig sets values', () => {
  const r = applyConfig({}, 'compactAt', '55')
  expect(r.overrides).toEqual({ compactAt: 55 })
  expect(r.message).toContain('compactAt')
  expect(applyConfig(r.overrides, 'jev', 'off').overrides).toEqual({ compactAt: 55, jev: false })
  expect(applyConfig({}, 'thresholds.relation', '0.95').overrides).toEqual({ 'thresholds.relation': 0.95 })
  expect(applyConfig({}, 'jevModel', 'jev-v2').overrides).toEqual({ jevModel: 'jev-v2' })
  expect(resolveSettings({}, applyConfig({}, 'focusCompact', 'off').overrides).focusCompact).toBe(false)
})

test('applyConfig reports errors and keeps the overrides', () => {
  const o = { compactAt: 55 }
  const unknown = applyConfig(o, 'bogus', '1')
  expect(unknown.overrides).toBe(o)
  expect(unknown.message).toContain('compactAt')
  const range = applyConfig(o, 'quietTurns', '99')
  expect(range.overrides).toBe(o)
  expect(range.message).toContain('0 to 20')
  expect(applyConfig(o, 'compactAt', 'abc').overrides).toBe(o)
  expect(applyConfig(o, 'jev', 'maybe').overrides).toBe(o)
  expect(applyConfig(o, 'thresholds.size', '0.2').overrides).toBe(o)
})

test('applyConfig reset removes the override', () => {
  const r = applyConfig({ compactAt: 55, jev: false }, 'compactAt', 'reset')
  expect(r.overrides).toEqual({ jev: false })
  expect(applyConfig({ thresholds: { size: 0.8, keep: 0.6 } }, 'thresholds.size', 'reset').overrides).toEqual({ thresholds: { keep: 0.6 } })
})

test('showSettings tells where each value came from', () => {
  const out = showSettings({ mode: 'on' }, { compactAt: 50 })
  expect(out).toContain('compactAt 50 (override)')
  expect(out).toContain('mode on (option)')
  expect(out).toContain('urgentAt 80 (default)')
  expect(out).toContain('thresholds.relation 0.9 (default)')
  expect(out).toContain('muted none (default)')
})
