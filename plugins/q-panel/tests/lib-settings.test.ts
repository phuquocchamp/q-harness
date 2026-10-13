import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS, parseConfig, pickSettings, showSettings } from '../hooks/lib/settings'

test('config values are validated', () => {
  expect(parseConfig('previewLines', '8')).toEqual({ previewLines: 8 })
  expect(parseConfig('guard', 'off')).toEqual({ guard: false })
  expect(parseConfig('git', 'on')).toEqual({ git: true })
  expect(typeof parseConfig('previewLines', '-1')).toBe('string')
  expect(typeof parseConfig('guard', 'maybe')).toBe('string')
  expect(typeof parseConfig('maskSecrets', 'on')).toBe('string')
})

test('stored settings are read back with unknown keys dropped and bad values defaulted', () => {
  expect(pickSettings({ previewLines: 8, guard: false, history: [] })).toEqual({ ...DEFAULT_SETTINGS, previewLines: 8, guard: false })
  expect(pickSettings({ previewLines: -3, band: 'yes' })).toEqual(DEFAULT_SETTINGS)
  expect(pickSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  expect(showSettings(DEFAULT_SETTINGS)).toMatch(/band\s+on[\s\S]*previewLines\s+4/)
})
