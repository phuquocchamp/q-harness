import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS, parseConfig, pickSettings, showSettings } from '../hooks/lib/settings'

test('config values are validated', () => {
  expect(parseConfig('previewLines', '8')).toEqual({ previewLines: 8 })
  expect(parseConfig('filePanels', 'off')).toEqual({ filePanels: false })
  expect(parseConfig('codeBlocks', 'on')).toEqual({ codeBlocks: true })
  expect(typeof parseConfig('previewLines', '-1')).toBe('string')
  expect(typeof parseConfig('filePanels', 'maybe')).toBe('string')
  expect(typeof parseConfig('guard', 'on')).toBe('string')
})

test('stored settings are read back with unknown keys dropped and bad values defaulted', () => {
  expect(pickSettings({ previewLines: 8, filePanels: false, band: true })).toEqual({ ...DEFAULT_SETTINGS, previewLines: 8, filePanels: false })
  expect(pickSettings({ previewLines: -3, codeBlocks: 'yes' })).toEqual(DEFAULT_SETTINGS)
  expect(pickSettings(undefined)).toEqual(DEFAULT_SETTINGS)
  expect(showSettings(DEFAULT_SETTINGS)).toMatch(/filePanels\s+on[\s\S]*previewLines\s+4/)
})
