import { expect, test } from 'claude-code/testing'

import { APP_BUG, DRIFT, ROOT, calls, edit, fakeHost, flow, run, say, seedProject, start, stop } from './host'

type Status = {
  mode: string
  trust: string
  summary: string | null
  flows: Record<string, { outcome: string; accepted: boolean; jevCalls: number }>
  lastRun: null | { flows: { id: string; outcome: string; jevCalls: number; verifyFails: unknown[] }[] }
}

const statusTool = async ($: Parameters<typeof start>[0]) => $.tool.call({ tool: 'mcp__q-pilot__pilot_status' } as never)

test('the status tool answers a string before the first run', async ($, on) => {
  fakeHost(on)
  await start($)
  const r = await statusTool($)
  expect(typeof r.result).toBe('string')
  const s = JSON.parse(r.result as string) as Status
  expect(s.lastRun).toBeNull()
  expect(s.flows).toEqual({})
})

test('the status tool answers a string with the last run per flow', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG, flow('home', 'pass', { jevCalls: 2, jevMs: [400, 500] })])]
  await start($)
  await edit($, `${ROOT}/src/checkout.html`)
  await stop($)
  const r = await statusTool($)
  // The host takes a string (or a content array) as a tool result, not an object.
  expect(typeof r.result).toBe('string')
  const s = JSON.parse(r.result as string) as Status
  expect(s.mode).toBe('affected')
  expect(s.trust).toBe('shadow')
  expect(s.summary).toBe('✗ 1 of 2 flows: checkout app-bug')
  expect(s.flows.checkout!.outcome).toBe('app-bug')
  expect(s.flows.home!.outcome).toBe('pass')
  expect(s.flows.home!.jevCalls).toBe(2)
  expect(s.lastRun!.flows.find(x => x.id === 'home')!.jevCalls).toBe(2)
  expect(s.flows.checkout!.jevCalls).toBe(0)
  expect(s.lastRun!.flows[0]!.verifyFails).toEqual([{ check: { testid: 'total', text: '€12.00' }, actual: '€14.00' }])
  expect((await run($, 'status')).text).toMatch(/✗ checkout: app-bug/)
})

test('/q-pilot run all and run <id> pass --all and --flows', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass'), flow('home', 'pass')])]
  await start($)
  const all = await run($, 'run all')
  expect(all.exitCode).toBe(0)
  expect(all.text).toMatch(/^✓ 2\/2 flows\n {2}✓ checkout: pass/)
  expect(host.runs[0]).toEqual(['node', expect.stringMatching(/pilot\.mjs$/), 'run', '--root', ROOT, '--all'])
  await run($, 'run checkout')
  expect(host.runs[1]!.slice(-2)).toEqual(['--flows', 'checkout'])
  expect((await run($, 'run Bad_ID')).exitCode).toBe(2)
})

test('/q-pilot run without an argument runs the flows the pending edits affect', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  expect((await run($, 'run')).text).toMatch(/No UI-relevant edits pending/)
  await edit($, `${ROOT}/src/checkout.html`)
  await run($, 'run')
  expect(host.runs[0]!.slice(-2)).toEqual(['--flows', 'checkout'])
})

test('/q-pilot run without a config explains, and a red run exits 1 and shows in the band', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'run all')).text).toMatch(/Run \/q-pilot init/)
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  const r = await run($, 'run all')
  expect(r.exitCode).toBe(1)
  expect(r.text).toContain('checkout: drift')
  const band = await $.ui.mount({ plugin: 'q-pilot', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } } as Parameters<typeof $.ui.mount>[0])
  expect(await band.find({ type: 'Text', text: /pilot ≈ 1 of 1 flows: checkout drift · \/q-pilot accept/ })).toBeDefined()
  await band.unmount()
})

test('/q-pilot record writes through the runner and reports needs-verify with the suggestion', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  host.runner.record = [say([flow('checkout', 'pass', { recorded: true })], 'record')]
  expect((await run($, 'record checkout')).text).toMatch(/checkout: recorded, verify passed/)
  expect(calls(host.runs, 'record')[0]!.slice(2)).toEqual(['record', '--root', ROOT, '--flow', 'checkout'])
  host.runner.record = [say([flow('checkout', 'needs-verify', { suggestedVerify: [{ url: '^/done$' }] })], 'record')]
  const r = await run($, 'record checkout')
  expect(r.exitCode).toBe(1)
  expect(r.text).toContain('"url": "^/done$"')
  expect((await run($, 'record')).exitCode).toBe(2)
})

test('/q-pilot accept <id> and accept without an id run the runner accept', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([DRIFT, flow('home', 'pass')])]
  host.runner.accept = [say([flow('checkout', 'pass')], 'accept')]
  await start($)
  expect((await run($, 'accept')).text).toMatch(/Nothing to accept/)
  await run($, 'run all')
  const r = await run($, 'accept')
  expect(r.text).toContain('✓ checkout: accepted')
  expect(calls(host.runs, 'accept')[0]!.slice(2)).toEqual(['accept', '--root', ROOT, '--flow', 'checkout', '--run', 'r1'])
  // Accepted: the band and the summary no longer count it.
  expect(host.statuses.at(-1)).toBe('pilot ✓ 2/2 flows')
  expect((await run($, 'accept')).text).toMatch(/Nothing to accept/)
  expect((await run($, 'accept home')).text).toMatch(/Accepted home/)
  expect(calls(host.runs, 'accept')[1]!.includes('--run')).toBe(false)
})

test('/q-pilot accept reports a runner failure', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.accept = [say([flow('checkout', 'error', { error: 'no proposal for checkout' })], 'accept')]
  await start($)
  const r = await run($, 'accept checkout')
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/could not accept checkout: no proposal/)
})

test('/q-pilot export passes the flow to the runner', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.export = [{ exitCode: 0, stdout: `${JSON.stringify({ ok: true, command: 'export', out: 'tests/q-pilot/checkout.spec.ts' })}\n` }]
  await start($)
  expect((await run($, 'export checkout')).text).toBe('Exported checkout to tests/q-pilot/checkout.spec.ts.')
  expect(calls(host.runs, 'export')[0]!.slice(2)).toEqual(['export', '--root', ROOT, '--flow', 'checkout'])
})

test('/q-pilot init writes the config and the example flow, and never overwrites', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  const first = await run($, 'init')
  expect(first.text).toMatch(/\+ write q-pilot\.config\.json\n {2}\+ write flows\/example\.flow\.json/)
  expect(JSON.parse(host.files.get(`${ROOT}/q-pilot.config.json`)!).baseURL).toBe('http://localhost:3000')
  expect(JSON.parse(host.files.get(`${ROOT}/flows/example.flow.json`)!).id).toBe('example')
  host.files.set(`${ROOT}/q-pilot.config.json`, '{"baseURL":"http://mine"}')
  host.files.delete(`${ROOT}/flows/example.flow.json`)
  const again = await run($, 'init')
  expect(again.text).toMatch(/· keep q-pilot\.config\.json\n {2}\+ write flows\/example\.flow\.json/)
  expect(host.files.get(`${ROOT}/q-pilot.config.json`)).toBe('{"baseURL":"http://mine"}')
  const third = await run($, 'init')
  expect(third.text).not.toMatch(/\+ write/)
})

test('/q-pilot mode switches the gate and survives in the store', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  expect((await run($, 'mode')).text).toMatch(/^mode is affected/)
  expect((await run($, 'mode off')).text).toBe('q-pilot mode off.')
  expect(host.store.get('settings')).toEqual({ mode: 'off' })
  await edit($, `${ROOT}/src/checkout.html`)
  expect((await stop($)).block).toBeUndefined()
  expect(host.runs).toEqual([])
  expect((await run($, 'bogus')).exitCode).toBe(2)
})

test('/q-pilot config shows, sets, checks and resets the settings; they survive in the store', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  const shown = (await run($, 'config')).text
  expect(shown).toMatch(/helper +haiku/)
  expect(shown).toMatch(/vision +gated/)
  expect(shown).toMatch(/box +off/)
  expect((await run($, 'config helper Opus')).text).toBe('q-pilot helper opus.')
  expect((await run($, 'config box on')).text).toBe('q-pilot box on.')
  expect((await run($, 'config visionmodel jev-1.14.0')).text).toBe('q-pilot visionModel jev-1.14.0.')
  expect((await run($, 'config node /opt/homebrew/bin/node')).text).toBe('q-pilot node /opt/homebrew/bin/node.')
  expect(host.store.get('settings')).toEqual({ helper: 'opus', box: true, visionModel: 'jev-1.14.0', node: '/opt/homebrew/bin/node' })
  expect((await run($, 'config helper gpt')).exitCode).toBe(2)
  expect((await run($, 'config maxTaskSeconds 5')).exitCode).toBe(2)
  expect((await run($, 'config bogus 1')).exitCode).toBe(2)
  expect((await run($, 'config helper default')).text).toBe('q-pilot helper haiku.')
  expect((await run($, 'config reset')).text).toMatch(/^q-pilot settings reset/)
  expect(host.store.get('settings')).toEqual({})
})

test('the first start after the upgrade keeps the old plugin options and /q-pilot mode as settings', { options: { node: '/opt/homebrew/bin/node', vision: 'always', visionBox: 'on', inspectorPort: 9001 } }, async ($, on) => {
  const host = fakeHost(on)
  host.store.set('mode', 'all')
  await start($)
  expect(host.store.get('settings')).toEqual({ node: '/opt/homebrew/bin/node', vision: 'always', box: true, mode: 'all' })
})
