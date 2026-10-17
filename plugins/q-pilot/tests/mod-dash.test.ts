// The q-pilot Dashboard as the mod sees it: one process per Claude session, found by the runners through the
// descriptor path in the env, and never a reason for a run to fail.

import { expect, test } from 'claude-code/testing'

import { APP_BUG, ROOT, calls, edit, fakeHost, flow, say, seedProject, start, stop } from './host'

const DASH_FILE = `${ROOT}/.q-pilot/dashboard/server.json`
const TASK = { goal: 'Open the start page. Stop when it loads.', url: 'https://example.com/' }
const SPEC = { name: 'smoke', start: '/', goal: 'Open the start page and stop.', checks: [{ title: 'Example' }] }
const runTask = ($: Parameters<typeof start>[0]) => $.tool.call({ tool: 'mcp__q-pilot__pilot_run', ...TASK } as never)
const runTest = ($: Parameters<typeof start>[0]) => $.tool.call({ tool: 'mcp__q-pilot__pilot_test', ...SPEC } as never)
const DONE = flow('task', 'done')

test('pilot_test registers as a test session: --session-kind test, the settings sources and the Dashboard env', async ($, on) => {
  const host = fakeHost(on)
  host.runner.explore = [say([flow('smoke', 'pass')], 'explore')]
  await start($)
  await runTest($)
  const argv = calls(host.runs, 'explore')[0]!
  expect(argv[argv.indexOf('--session-kind') + 1]).toBe('test')
  expect(argv).toContain('--settings-sources')
  expect(host.envs[0]!.Q_PILOT_DASH_FILE).toBe(DASH_FILE)
  expect(host.toasts).toEqual(['q-pilot: Dashboard http://127.0.0.1:8767/'])
})

test('the stop gate runs as a gate session, links the red flow in the band, and never toasts or opens anything', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  await edit($, `${ROOT}/src/checkout.html`)
  expect((await stop($)).block).toMatch(/checkout/)
  const argv = calls(host.runs, 'run')[0]!
  expect(argv.slice(-2)).toEqual(['--session-kind', 'gate'])
  expect(host.envs[0]!.Q_PILOT_DASH_FILE).toBe(DASH_FILE)
  expect(host.dashSpawns).toHaveLength(1)
  expect(host.toasts).toEqual([])
  const band = await $.ui.mount({ plugin: 'q-pilot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 200 } } as Parameters<typeof $.ui.mount>[0])
  expect(await band.find({ type: 'Text', text: /pilot ✗ 1 of 1 flows: checkout app-bug$/ })).toBeDefined()
  expect(await band.find({ type: 'Text', text: 'http://127.0.0.1:8767/#s=r1:checkout' })).toBeDefined()
  await band.unmount()
})

test('a Dashboard started by the gate is announced by the next run the person asked for', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  host.runner.task = [say([DONE], 'task')]
  await start($)
  await edit($, `${ROOT}/src/checkout.html`)
  await stop($)
  expect(host.toasts).toEqual([])
  await runTask($)
  expect(host.toasts).toEqual(['q-pilot: Dashboard http://127.0.0.1:8767/'])
  expect(host.dashSpawns).toHaveLength(1)
})

const unharmed = async ($: Parameters<typeof start>[0], on: Parameters<typeof fakeHost>[0], how: { throws?: string; exits?: boolean }) => {
  const host = fakeHost(on)
  Object.assign(host.dash, how)
  host.runner.task = [say([DONE], 'task')]
  host.runner.explore = [say([flow('smoke', 'pass')], 'explore')]
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  expect(String((await runTask($)).result)).toMatch(/^pilot_run done/)
  expect(String((await runTest($)).result)).toMatch(/^pilot_test pass/)
  await edit($, `${ROOT}/src/checkout.html`)
  expect((await stop($)).block).toBeUndefined()
  expect(host.envs.every(e => !e || !('Q_PILOT_DASH_FILE' in e))).toBe(true)
  expect(host.toasts).toEqual(['q-pilot: the Dashboard could not start; runs go on without it'])
  expect(host.dashSpawns).toHaveLength(1)
}

test('a Dashboard whose spawn fails never stops a run: no env, one toast, no second try', ($, on) => unharmed($, on, { throws: 'spawn node ENOENT' }))

test('a Dashboard that exits before its ready mark never stops a run either', ($, on) => unharmed($, on, { exits: true }))

test('a Dashboard that another session already serves is used as it is', async ($, on) => {
  const host = fakeHost(on)
  host.dash.reused = true
  host.runner.task = [say([DONE], 'task')]
  await start($)
  await runTask($)
  expect(host.envs[0]!.Q_PILOT_DASH_FILE).toBe(DASH_FILE)
  expect(host.toasts).toEqual(['q-pilot: Dashboard http://127.0.0.1:8767/'])
})

test('a reused Dashboard is checked again on every use: when the other session is gone, a new one takes over', async ($, on) => {
  const host = fakeHost(on)
  host.dash.reused = true
  host.runner.task = [say([DONE], 'task')]
  await start($)
  await runTask($)
  expect(host.dashSpawns).toHaveLength(1)
  // The other session ended: the next spawn serves by itself on a new port.
  host.dash.reused = false
  host.dash.url = 'http://127.0.0.1:8768/'
  await runTask($)
  expect(host.dashSpawns).toHaveLength(2)
  expect((await $.command.run({ command: 'q-pilot', args: 'dashboard' } as never) as { text: string }).text).toBe('q-pilot Dashboard: http://127.0.0.1:8768/')
  // Its own process is kept from then on.
  await runTask($)
  expect(host.dashSpawns).toHaveLength(2)
})
