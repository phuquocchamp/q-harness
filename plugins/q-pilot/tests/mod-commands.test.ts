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
  expect(shown).toMatch(/dashboard +off/)
  expect((await run($, 'config helper Opus')).text).toBe('q-pilot helper opus.')
  expect((await run($, 'config box on')).text).toBe('q-pilot box on.')
  expect((await run($, 'config visionmodel jev-1.14.0')).text).toBe('q-pilot visionModel jev-1.14.0.')
  expect((await run($, 'config node /opt/homebrew/bin/node')).text).toBe('q-pilot node /opt/homebrew/bin/node.')
  expect(host.store.get('settings')).toEqual({ helper: 'opus', box: true, visionModel: 'jev-1.14.0', node: '/opt/homebrew/bin/node' })
  expect((await run($, 'config helper gpt')).exitCode).toBe(2)
  expect((await run($, 'config maxTaskSeconds 5')).exitCode).toBe(2)
  expect((await run($, 'config bogus 1')).exitCode).toBe(2)
  expect((await run($, 'config helper default')).text).toBe('q-pilot helper haiku.')
  expect((await run($, 'config reset')).text).toMatch(/^q-pilot user settings reset/)
  expect(host.store.get('settings')).toEqual({})
})

test('the first start after the upgrade keeps a /q-pilot mode set before settings existed', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('mode', 'all')
  await start($)
  expect(host.store.get('settings')).toEqual({ mode: 'all' })
})

const LOCAL = `${ROOT}/.q-pilot/settings.local.json`
const PROJECT = `${ROOT}/.q-pilot/settings.json`
const row = (text: string, key: string) => text.split('\n').find(l => l.trimStart().startsWith(`${key} `) || l.trimStart().startsWith(`${key}*`)) ?? ''

test('scopes: local beats project beats user beats default, and config shows each value\'s source and what it overrides', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { helper: 'opus', vision: 'always', box: true })
  host.files.set(PROJECT, JSON.stringify({ helper: 'sonnet', vision: 'off', dashboard: true }))
  host.files.set(LOCAL, JSON.stringify({ helper: 'session' }))
  await start($)
  const shown = (await run($, 'config')).text
  expect(row(shown, 'helper')).toMatch(/helper +session +local +project=sonnet, user=opus/)
  expect(row(shown, 'vision')).toMatch(/vision +off +project +user=always/)
  expect(row(shown, 'box')).toMatch(/box +on +user +-/)
  expect(row(shown, 'dashboard')).toMatch(/dashboard +on +project/)
  expect(row(shown, 'mode')).toMatch(/mode +affected +default/)
  const why = (await run($, 'config explain helper')).text
  expect(why).toMatch(/^helper: session \(local\)/)
  expect(why).toMatch(/local +session +<- wins/)
  expect(why).toMatch(/project +sonnet/)
  expect(why).toMatch(/user +opus/)
  expect(why).toMatch(/default +haiku/)
  expect(why).toMatch(/cli +-/)
  expect((await run($, 'config explain nope')).exitCode).toBe(2)
})

test('personal keys in the project or local file are ignored with a warning; set --scope project refuses them', async ($, on) => {
  const host = fakeHost(on)
  host.files.set(PROJECT, JSON.stringify({ node: '/evil/node', trust: 'on', cdpUrl: 'http://evil:9222', mode: 'all' }))
  host.files.set(LOCAL, JSON.stringify({ node: '/evil/local-node' }))
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  const shown = (await run($, 'config')).text
  expect(row(shown, 'node')).toMatch(/node\* +node +default/)
  expect(row(shown, 'trust')).toMatch(/trust\* +shadow +default/)
  expect(row(shown, 'mode')).toMatch(/mode +all +project/)
  expect(shown).toMatch(/! project: "node" is personal/)
  expect(shown).toMatch(/! local: "node" is personal/)
  expect(shown).toMatch(/! project: "cdpUrl" is personal/)
  await run($, 'run all')
  expect(host.runs[0]![0]).toBe('node')
  const refused = await run($, 'config set node /usr/bin/node --scope project')
  expect(refused.exitCode).toBe(2)
  expect(refused.text).toMatch(/node is personal.*project file.*--scope user/)
  expect((await run($, 'config set trust on --scope local')).exitCode).toBe(2)
  expect(host.files.get(PROJECT)).toBe(JSON.stringify({ node: '/evil/node', trust: 'on', cdpUrl: 'http://evil:9222', mode: 'all' }))
  expect((await run($, 'config set node /opt/node --scope user')).text).toBe('q-pilot node /opt/node.')
})

test('unknown keys, secrets and bad values in a file are dropped with a warning naming scope and key', async ($, on) => {
  const host = fakeHost(on)
  host.files.set(PROJECT, JSON.stringify({ jevApiKey: 'sk-abcdefghijklmnop', colour: 'red', helper: 'gpt', mode: 'all', maxTaskSeconds: 5 }))
  await start($)
  const shown = (await run($, 'config')).text
  expect(shown).toMatch(/! project: "jevApiKey" looks like a secret/)
  expect(shown).toMatch(/! project: unknown setting "colour"/)
  expect(shown).toMatch(/! project: helper must be haiku\|sonnet\|opus\|session/)
  expect(shown).toMatch(/! project: maxTaskSeconds must be a number from 30 to 600/)
  expect(row(shown, 'mode')).toMatch(/mode +all +project/)
  expect(row(shown, 'helper')).toMatch(/helper +haiku +default/)
})

test('invalid JSON in a settings file is a warning, not a crash, and set refuses to overwrite it', async ($, on) => {
  const host = fakeHost(on)
  host.files.set(PROJECT, '{ "mode": ')
  await start($)
  const shown = (await run($, 'config')).text
  expect(shown).toMatch(/! project: \.q-pilot\/settings\.json could not be read/)
  expect(row(shown, 'mode')).toMatch(/mode +affected +default/)
  const r = await run($, 'config set mode all --scope project')
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/not valid JSON.*fix or delete it first/)
  expect(host.files.get(PROJECT)).toBe('{ "mode": ')
  expect((await statusTool($)).result).toEqual(expect.any(String))
})

test('set, unset and reset write the chosen scope with 2-space JSON; local is added to .gitignore once', async ($, on) => {
  const host = fakeHost(on)
  host.files.set(`${ROOT}/.gitignore`, 'node_modules/\n.q-pilot/runs/')
  await start($)
  expect((await run($, 'config set vision always --scope project')).text).toBe('q-pilot vision always (project: .q-pilot/settings.json).')
  expect(host.files.get(PROJECT)).toBe('{\n  "vision": "always"\n}\n')
  expect(host.files.get(`${ROOT}/.gitignore`)).toBe('node_modules/\n.q-pilot/runs/')
  const local = await run($, 'config set box on --scope local')
  expect(local.text).toMatch(/^q-pilot box on \(local: \.q-pilot\/settings\.local\.json\)\.\nadded \.q-pilot\/settings\.local\.json to \.gitignore\./)
  expect(host.files.get(LOCAL)).toBe('{\n  "box": true\n}\n')
  expect(host.files.get(`${ROOT}/.gitignore`)).toBe('node_modules/\n.q-pilot/runs/\n# q-pilot personal settings\n.q-pilot/settings.local.json\n')
  expect((await run($, 'config set box off --scope local')).text).not.toMatch(/gitignore/)
  expect(host.files.get(`${ROOT}/.gitignore`)!.match(/settings\.local\.json/g)).toHaveLength(1)
  expect(host.store.get('settings')).toEqual({})
  // A value stored below a higher scope says so.
  await run($, 'config set vision off')
  const note = (await run($, 'config set vision gated')).text
  expect(note).toMatch(/Note: project overrides it, so vision stays always \(project\)/)
  const unset = (await run($, 'config unset vision --scope project')).text
  expect(unset).toBe('q-pilot vision unset in project; now gated (user).')
  expect(host.files.get(PROJECT)).toBe('{}\n')
  expect((await run($, 'config unset vision --scope nowhere')).exitCode).toBe(2)
  expect((await run($, 'config unset bogus')).exitCode).toBe(2)
  expect((await run($, 'config reset --scope local')).text).toMatch(/^q-pilot local settings reset\./)
  expect(host.files.get(LOCAL)).toBe('{}\n')
  expect(host.store.get('settings')).toEqual({ vision: 'gated' })
})

test('writing local does not touch a .gitignore that already ignores .q-pilot/', async ($, on) => {
  const host = fakeHost(on)
  host.files.set(`${ROOT}/.gitignore`, '.q-pilot/\n')
  await start($)
  await run($, 'config set mode all --scope local')
  expect(host.files.get(`${ROOT}/.gitignore`)).toBe('.q-pilot/\n')
})

test('two sessions see each other\'s settings: every call re-reads the files and the store', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass'), flow('home', 'pass')])]
  await start($)
  expect(row((await run($, 'config')).text, 'mode')).toMatch(/mode +affected +default/)
  // Another session (or an editor) changes a file and the shared store behind this one's back.
  host.files.set(PROJECT, JSON.stringify({ mode: 'all' }))
  expect(row((await run($, 'config')).text, 'mode')).toMatch(/mode +all +project/)
  await edit($, `${ROOT}/src/other.html`)
  expect((await stop($)).block).toBeUndefined()
  expect(calls(host.runs, 'run')[0]!.at(-3)).toBe('checkout,home')
  host.store.set('settings', { mode: 'off' })
  host.files.delete(PROJECT)
  expect(row((await run($, 'config')).text, 'mode')).toMatch(/mode +off +user/)
})

test('cdpUrl: the shell variable is the env scope and wins over user; a set value reaches the runner, off included', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  host.env.set('Q_PILOT_CDP_URL', 'http://127.0.0.1:9222')
  await start($)
  await run($, 'config set cdpUrl off')
  const shown = (await run($, 'config')).text
  expect(row(shown, 'cdpUrl')).toMatch(/cdpUrl\* +http:\/\/127\.0\.0\.1:9222 +env +user=off/)
  await run($, 'run all')
  expect(host.envs[0]).toEqual({ Q_PILOT_CDP_URL: 'http://127.0.0.1:9222' })
  host.env.delete('Q_PILOT_CDP_URL')
  await run($, 'run all')
  expect(host.envs[1]).toEqual({ Q_PILOT_CDP_URL: '' })
  await run($, 'config unset cdpUrl')
  await run($, 'run all')
  expect(host.envs[2]).toEqual({})
})

test('lastRun and the last run per flow are kept per project root', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('lastRun', { runId: 'old', startedAt: 1, durationMs: 1, reason: 'command', flows: [flow('legacy', 'pass')] })
  host.runner.record = [say([flow('checkout', 'pass', { recorded: true })], 'record')]
  await start($)
  // The old global key is read until the project writes its own.
  expect(host.statuses.at(-1)).toBe('pilot ✓ 1/1 flows')
  await run($, 'record checkout')
  expect([...host.store.keys()].filter(k => /^lastRun:[0-9a-f]{8}$/.test(k))).toHaveLength(1)
  expect(host.stored('lastByFlow')).toHaveProperty('checkout')
  expect(host.store.get('lastRun')).toMatchObject({ runId: 'old' })
  host.root = '/other'
  await start($)
  host.runner.record = [say([flow('home', 'pass', { recorded: true })], 'record')]
  await run($, 'record home')
  const keys = [...host.store.keys()].filter(k => /^lastByFlow:[0-9a-f]{8}$/.test(k))
  expect(keys).toHaveLength(2)
  expect(Object.keys(host.store.get(keys[0]!) as object)).toEqual(['checkout'])
})

test('a q-pilot.config.json that does not parse is reported, not mistaken for a missing one', async ($, on) => {
  const host = fakeHost(on)
  host.files.set(`${ROOT}/q-pilot.config.json`, '{ "baseURL": ')
  await start($)
  const r = await run($, 'run all')
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/q-pilot\.config\.json could not be read: .*Fix it/)
  expect(r.text).not.toMatch(/Run \/q-pilot init/)
  host.files.set(`${ROOT}/q-pilot.config.json`, '[]')
  expect((await run($, 'run all')).text).toMatch(/must be a JSON object/)
  await edit($, `${ROOT}/src/checkout.html`)
  expect((await stop($)).block).toBeUndefined()
  expect(host.toasts.join('\n')).toMatch(/q-pilot\.config\.json must be a JSON object; the stop gate is off/)
})
