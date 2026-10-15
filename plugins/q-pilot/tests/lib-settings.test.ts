import { expect, test } from 'claude-code/testing'

import { DEFAULT_SETTINGS, applyConfig, explainSetting, resolveSettings, unsetConfig } from '../hooks/lib/settings'

test('every scope wins over the ones below it; the source lists what it overrides', () => {
  const r = resolveSettings({ cli: { vision: 'off' }, env: { cdpUrl: 'http://e' }, local: { vision: 'always', helper: 'session' }, project: { vision: 'gated', helper: 'sonnet', mode: 'all' }, user: { helper: 'opus', box: true } })
  expect(r.values.vision).toBe('off')
  expect(r.sources.vision).toEqual({ scope: 'cli', overridden: [{ scope: 'local', value: 'always' }, { scope: 'project', value: 'gated' }] })
  expect(r.values.helper).toBe('session')
  expect(r.sources.helper).toEqual({ scope: 'local', overridden: [{ scope: 'project', value: 'sonnet' }, { scope: 'user', value: 'opus' }] })
  expect(r.sources.mode).toEqual({ scope: 'project', overridden: [] })
  expect(r.sources.box).toEqual({ scope: 'user', overridden: [] })
  expect(r.sources.cdpUrl.scope).toBe('env')
  expect(r.sources.inspector).toEqual({ scope: 'default', overridden: [] })
  expect(r.values.inspector).toBe(DEFAULT_SETTINGS.inspector)
  expect(r.warnings).toEqual([])
})

test('an empty cdpUrl (off) in a higher scope is a value, and beats a lower one', () => {
  const r = resolveSettings({ cli: { cdpUrl: '' }, env: { cdpUrl: 'http://e' } })
  expect(r.values.cdpUrl).toBe('')
  expect(r.sources.cdpUrl).toEqual({ scope: 'cli', overridden: [{ scope: 'env', value: 'http://e' }] })
})

test('personal keys count from user, env and cli only', () => {
  const r = resolveSettings({ project: { node: '/x', trust: 'on', cdpUrl: 'http://x' }, local: { node: '/y' }, user: { node: '/z' } })
  expect(r.values.node).toBe('/z')
  expect(r.values.trust).toBe('shadow')
  expect(r.values.cdpUrl).toBe('')
  expect(r.warnings).toHaveLength(4)
  expect(r.warnings).toContain('project: "node" is personal (it runs a command or opens a connection) and is only read from user, env or cli; ignored')
  expect(r.warnings.filter(w => w.startsWith('local:'))).toHaveLength(1)
})

test('invalid values, unknown keys, secrets and non-objects are dropped with the scope and key named', () => {
  const r = resolveSettings({ project: { helper: 'gpt', mode: 'all', nope: 1, apiKey: 'x', box: 'maybe' }, local: [1], user: 'text', env: { vision: 'sometimes' } })
  expect(r.values.helper).toBe('haiku')
  expect(r.values.mode).toBe('all')
  expect(r.warnings).toEqual(
    expect.arrayContaining([
      'env: vision must be off|gated|always; ignored',
      'local: settings must be a JSON object; ignored',
      'project: helper must be haiku|sonnet|opus|session; ignored',
      'project: unknown setting "nope"; ignored',
      expect.stringMatching(/^project: "apiKey" looks like a secret/),
      'project: box must be on|off; ignored',
      'user: settings must be a JSON object; ignored',
    ]),
  )
})

test('a value that looks like a token is dropped even under a known key', () => {
  const r = resolveSettings({ user: { node: 'ghp_abcdefghijklmnopqrstuvwxyz' } })
  expect(r.values.node).toBe('node')
  expect(r.warnings[0]).toMatch(/^user: "node" looks like a secret/)
})

test('applyConfig sets, validates, keeps other keys and refuses personal keys outside user', () => {
  expect(applyConfig({ mode: 'all' }, 'Helper', 'Opus', 'project')).toEqual({ mode: 'all', helper: 'opus' })
  expect(applyConfig({ helper: 'opus' }, 'helper', 'default')).toEqual({})
  expect(applyConfig({}, 'node', 'off')).toEqual({ node: '' })
  expect(applyConfig({}, 'helper', 'gpt')).toBe('helper must be haiku|sonnet|opus|session.')
  expect(applyConfig({}, 'bogus', '1')).toMatch(/^Unknown setting "bogus"/)
  expect(applyConfig({}, 'node', 'x', 'local')).toMatch(/node is personal.*local file.*--scope user/)
  expect(applyConfig({}, 'trust', 'on', 'project')).toMatch(/trust is personal/)
  expect(applyConfig({}, 'node', 'ghp_abcdefghijklmnopqrstuvwxyz')).toMatch(/looks like a secret/)
})

test('unsetConfig drops one key; explain lists every scope', () => {
  expect(unsetConfig({ helper: 'opus', mode: 'all' }, 'HELPER')).toEqual({ mode: 'all' })
  expect(unsetConfig({}, 'bogus')).toMatch(/^Unknown setting/)
  const text = explainSetting('cdpUrl', resolveSettings({ env: { cdpUrl: 'http://e' }, user: { cdpUrl: '' } }))
  expect(text).toMatch(/^cdpUrl: http:\/\/e \(env\)/)
  expect(text).toMatch(/env +http:\/\/e +<- wins/)
  expect(text).toMatch(/user +off/)
  expect(text).toMatch(/env variable: Q_PILOT_CDP_URL/)
})
