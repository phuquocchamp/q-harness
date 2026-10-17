// The Dashboard's Settings page, as the mod answers it: the same path and the same checks as /q-pilot config.

import { expect, test } from 'claude-code/testing'

import { ROOT, fakeHost, settle, start } from './host'

const PROJECT = `${ROOT}/.q-pilot/settings.json`

/** Starts the Dashboard (so its fake raises the requests) and waits for every answer. */
const serve = async ($: Parameters<typeof start>[0], host: ReturnType<typeof fakeHost>) => {
  await start($)
  await $.command.run({ command: 'q-pilot', args: 'dashboard' } as never)
  for (let i = 0; i < 200 && host.configAnswers.length < host.dash.configs.length; i++) await settle()
}

test('get answers every setting with its group, kind, options, scopes and source, and never a secret', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { helper: 'sonnet' })
  host.dash.configs = [{ op: 'get' }]
  await serve($, host)
  const a = host.configAnswers[0]!
  expect(a.ok).toBe(true)
  const row = (k: string) => a.settings.find((r: { key: string }) => r.key === k)
  expect(row('helper')).toMatchObject({ value: 'sonnet', source: 'user', kind: 'enum', options: ['haiku', 'sonnet', 'opus', 'session'], group: 'Helper', personal: false, scopes: ['user', 'project', 'local'] })
  expect(row('box')).toMatchObject({ kind: 'bool', options: ['on', 'off'], value: false, source: 'default', group: 'Jev vision' })
  expect(row('dashboardWindow')).toMatchObject({ value: 'app', group: 'Dashboard' })
  expect(row('node')).toMatchObject({ personal: true, scopes: ['user'], group: 'Browser' })
  expect(row('maxTaskSeconds')).toMatchObject({ kind: 'number', group: 'Runs' })
  expect(a.files).toEqual({ user: 'q-pilot plugin store', project: PROJECT, local: `${ROOT}/.q-pilot/settings.local.json` })
  expect(JSON.stringify(a)).not.toMatch(/TYPESAFE|jevApiKey|sk-/)
})

test('set and unset write the scope like /q-pilot config, toast the change, and show the new resolution', async ($, on) => {
  const host = fakeHost(on)
  host.dash.configs = [
    { op: 'set', key: 'dashboardWindow', value: 'tab', scope: 'project' },
    { op: 'set', key: 'visionmodel', value: 'jev-1.14.0', scope: 'user' },
    { op: 'unset', key: 'dashboardWindow', scope: 'project' },
  ]
  await serve($, host)
  const [a, b, c] = host.configAnswers
  expect(a).toMatchObject({ ok: true, message: `saved dashboardWindow=tab to project (.q-pilot/settings.json)` })
  expect(a.settings.find((r: { key: string }) => r.key === 'dashboardWindow')).toMatchObject({ value: 'tab', source: 'project' })
  expect(b.message).toBe('saved visionModel=jev-1.14.0 to user')
  expect(host.store.get('settings')).toEqual({ visionModel: 'jev-1.14.0' })
  expect(c).toMatchObject({ ok: true, message: 'removed dashboardWindow from project (.q-pilot/settings.json)' })
  expect(c.settings.find((r: { key: string }) => r.key === 'dashboardWindow')).toMatchObject({ value: 'app', source: 'default' })
  expect(JSON.parse(host.files.get(PROJECT)!)).toEqual({})
  expect(host.toasts).toContain('q-pilot: saved dashboardWindow=tab to project (.q-pilot/settings.json)')
})

test('bad requests are refused with the config command\'s messages and change nothing: value, personal key in a repo scope, unknown key, scope, op', async ($, on) => {
  const host = fakeHost(on)
  host.dash.configs = [
    { op: 'set', key: 'vision', value: 'sometimes', scope: 'user' },
    { op: 'set', key: 'node', value: '/evil', scope: 'project' },
    { op: 'set', key: 'nope', value: 'x', scope: 'user' },
    { op: 'set', key: 'box', value: 'on', scope: 'cli' },
    { op: 'set', key: 'box', value: 5, scope: 'user' },
    { op: 'wipe', scope: 'user' },
  ]
  await serve($, host)
  expect(host.configAnswers.map(a => a.error)).toEqual([
    'vision must be off|gated|always.',
    expect.stringMatching(/^node is personal .* Use --scope user\.$/),
    'Unknown setting "nope".',
    'scope must be user, project, local',
    'value must be a string',
    'op must be get, set or unset',
  ])
  expect(host.configAnswers.every(a => Array.isArray(a.settings))).toBe(true)
  expect(host.store.get('settings')).toEqual({})
  expect(host.files.has(PROJECT)).toBe(false)
})

test('a change made in the Dashboard reaches the next run without a restart', async ($, on) => {
  const host = fakeHost(on)
  host.dash.configs = [{ op: 'set', key: 'vision', value: 'always', scope: 'user' }, { op: 'set', key: 'inspector', value: 'off', scope: 'user' }]
  host.runner.explore = [{ exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: 'explore', runId: 'r1', runDir: `${ROOT}/.q-pilot/runs/r1`, durationMs: 1, flows: [{ id: 'smoke', outcome: 'pass', steps: [], diverged: [], verifyFails: [] }] })}\n` }]
  await serve($, host)
  await $.tool.call({ tool: 'mcp__q-pilot__pilot_test', name: 'smoke', start: '/', goal: 'Open and stop.', checks: [{ title: 'x' }] } as never)
  const argv = host.runs.find(r => r.includes('explore'))!
  expect(argv[argv.indexOf('--vision') + 1]).toBe('always')
  expect(host.envs.at(-1)).not.toHaveProperty('Q_PILOT_DASH_FILE')
})
