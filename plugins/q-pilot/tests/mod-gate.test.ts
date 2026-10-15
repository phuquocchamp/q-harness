import { expect, test } from 'claude-code/testing'

import { stopBudget } from '../hooks/lib/report'
import { APP_BUG, DRIFT, ROOT, calls, edit, fakeHost, flow, say, seedProject, start, stop } from './host'

const CHECKOUT = `${ROOT}/src/checkout.html`

test('no q-pilot.config.json keeps the gate off', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.files.delete(`${ROOT}/q-pilot.config.json`)
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.runs).toEqual([])
})

test('a change that is not UI, or that no flow covers and no smoke flow stands in for, runs nothing', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  await edit($, `${ROOT}/README.md`)
  await edit($, `${ROOT}/flows/checkout.flow.json`)
  expect((await stop($)).block).toBeUndefined()
  expect(host.runs).toEqual([])
})

test('a green run lets the turn end; the runner argv is the one in DESIGN', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.runs).toEqual([['node', expect.stringMatching(/\/runner\/pilot\.mjs$/), 'run', '--root', ROOT, '--flows', 'checkout', '--budget-ms', '48000']])
  expect(host.statuses.at(-1)).toBe('pilot ✓ 1/1 flows')
  expect((host.stored('lastByFlow') as Record<string, { outcome: string }>).checkout!.outcome).toBe('pass')
})

test('uncovered UI files select the smoke flows; mixed changes select both', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('home', 'pass')])]
  await start($)
  await edit($, `${ROOT}/src/other.html`)
  await stop($)
  expect(calls(host.runs, 'run')[0]!.at(-3)).toBe('home')
  await edit($, CHECKOUT)
  await edit($, `${ROOT}/src/other.html`)
  await stop($)
  expect(calls(host.runs, 'run')[1]!.at(-3)).toBe('checkout,home')
})

test('mode all runs every flow', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { mode: 'all' })
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass'), flow('home', 'pass')])]
  await start($)
  await edit($, `${ROOT}/src/other.html`)
  await stop($)
  expect(calls(host.runs, 'run')[0]!.at(-3)).toBe('checkout,home')
})

test('mode off never runs', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { mode: 'off' })
  seedProject(host.files)
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.runs).toEqual([])
})

// outcome, blocks in shadow, blocks with trust on (no diff, so drift is untouched)
const TABLE: [string, boolean, boolean][] = [
  ['pass', false, false],
  ['flaky', true, false],
  ['app-bug', true, true],
  ['blocked', true, true],
  ['error', true, true],
  ['drift', true, true],
  ['env', true, false],
  ['untraced', false, false],
  ['needs-verify', false, false],
  ['skipped', false, false],
]
for (const [outcome, shadow, on_] of TABLE) {
  for (const trust of ['shadow', 'on'] as const) {
    test(`outcome ${outcome}, trust ${trust}: ${(trust === 'shadow' ? shadow : on_) ? 'blocks' : 'allows'}`, async ($, on) => {
      const host = fakeHost(on)
      host.store.set('settings', { trust })
      seedProject(host.files)
      host.runner.run = [say([flow('checkout', outcome, outcome === 'drift' ? DRIFT : { error: 'reason' })])]
      await start($)
      await edit($, CHECKOUT)
      expect((await stop($)).block !== undefined).toBe(trust === 'shadow' ? shadow : on_)
      // Whatever the decision, the gate itself never accepts without a touched drift.
      expect(calls(host.runs, 'accept')).toEqual([])
    })
  }
}

test('an app-bug block names the flow, the step, the failed check and the actual value', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  await edit($, CHECKOUT)
  const { block } = await stop($)
  expect(block).toMatch(/^q-pilot: 1 flow needs attention after your changes \(run r1\)\./)
  expect(block).toContain('checkout: app-bug')
  expect(block).toContain('after step 1 (click button "Place order")')
  expect(block).toContain('✗ {"testid":"total","text":"€12.00"} → found "€14.00"')
})

test('shadow drift blocks with old → new and how to accept, and writes no trace', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  host.diff = '+<button>Pay now</button>'
  await start($)
  await edit($, CHECKOUT)
  const { block } = await stop($)
  expect(block).toContain('click button "Place order" → click button "Pay now"')
  expect(block).toContain('/q-pilot accept checkout')
  // The diff is not even looked at in shadow, and nothing is accepted or written.
  expect(host.runs.filter(a => a[0] === 'git')).toEqual([])
  expect(calls(host.runs, 'accept')).toEqual([])
  expect([...host.files.keys()].filter(k => k.startsWith(`${ROOT}/.q-pilot`))).toEqual([])
})

test('trust on: a drift whose element name is in the turn diff is accepted automatically', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { trust: 'on' })
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  host.runner.accept = [say([flow('checkout', 'pass')], 'accept')]
  host.diff = '-<button>Place order</button>\n+<button>Pay now</button>'
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(calls(host.runs, 'accept')).toEqual([['node', expect.stringMatching(/pilot\.mjs$/), 'accept', '--root', ROOT, '--flow', 'checkout', '--run', 'r1']])
  expect(host.statuses.at(-1)).toBe('pilot ✓ 1/1 flows')
  expect(host.appended.join('\n')).toMatch(/checkout drifted .* accepted/)
})

test('trust on: a drift the diff does not mention blocks and is not accepted', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { trust: 'on' })
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  host.diff = '+<h1>Welcome</h1>'
  await start($)
  await edit($, CHECKOUT)
  const { block } = await stop($)
  expect(block).toContain('mentions neither element name')
  expect(calls(host.runs, 'accept')).toEqual([])
})

test('trust on: a failed auto-accept blocks with the reason', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { trust: 'on' })
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  host.runner.accept = [{ exitCode: 1, stderr: 'disk full' }]
  host.diff = '+Pay now'
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toMatch(/Auto-accept failed: .*disk full/s)
})

test('trust on: env only notifies; untraced asks for a recording', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { trust: 'on' })
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'env', { error: 'landed on /login' }), flow('home', 'untraced')])]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.notes[0]).toMatch(/checkout: environment problem: landed on \/login/)
  expect(host.appended.join('\n')).toContain('/q-pilot record home')
})

test('a runner crash blocks once with the stderr tail and does not gate those edits again', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [{ exitCode: 1, stderr: 'Error: Cannot find package playwright\n    at x' }]
  await start($)
  await edit($, CHECKOUT)
  const first = await stop($)
  expect(first.block).toMatch(/the runner crashed \(exit 1\) and printed no result:\n.*Cannot find package playwright/)
  expect((await stop($, true)).block).toBeUndefined()
  expect(calls(host.runs, 'run').length).toBe(1)
})

test('no result line, or a non-JSON one, counts as a crash', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [{ exitCode: 0, stdout: 'warming up\nnot json\n', stderr: 'oops' }]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toMatch(/crashed \(exit 0\).*oops/s)
})

test('an ok:false result blocks with its error', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [{ exitCode: 0, stdout: `${JSON.stringify({ ok: false, command: 'run', error: 'bad config' })}\n` }]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toMatch(/the runner failed: bad config/)
})

test('the Jev key goes to the runner env only, and a stderr leak of it is redacted', { options: { jevApiKey: 'sk-secret-1' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [{ exitCode: 1, stderr: 'auth failed with sk-secret-1' }]
  await start($)
  await edit($, CHECKOUT)
  const { block } = await stop($)
  expect(host.envs[0]).toEqual({ TYPESAFE_API_KEY: 'sk-secret-1' })
  expect(block).not.toContain('sk-secret-1')
  expect(host.runs[0]!.join(' ')).not.toContain('sk-secret-1')
})

test('a missing runner or node only toasts and allows', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runnerExists = false
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.toasts.at(-1)).toMatch(/the runner is missing/)

  host.runnerExists = true
  // A process.run that rejects (here: nothing answers it) is a spawn failure or a timeout.
  host.runner.run = [{ throws: 'spawn node ENOENT' }]
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.toasts.at(-1)).toMatch(/could not run node/)

  host.runner.run = [{ exitCode: 127, stderr: 'node: command not found' }]
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeUndefined()
  expect(host.toasts.at(-1)).toMatch(/node was not found/)
})

test('the node option and maxStopSeconds shape the argv', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { node: '/opt/homebrew/bin/node', maxStopSeconds: 20 })
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  await edit($, CHECKOUT)
  await stop($)
  expect(host.runs[0]!.slice(0, 1)).toEqual(['/opt/homebrew/bin/node'])
  expect(host.runs[0]!.slice(-2)).toEqual(['--budget-ms', '13000'])
})

test('after 2 blocks in a row the gate lets the turn end', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeDefined()
  expect((await stop($, true)).block).toBeDefined()
  expect((await stop($, true)).block).toBeUndefined()
  expect(calls(host.runs, 'run').length).toBe(2)
  expect(host.toasts.at(-1)).toMatch(/still red after 2 blocks/)
})

test('a subagent edit is not the main turn\'s, and a subagent stop is not gated', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  await edit($, CHECKOUT, 'sub1')
  expect((await stop($)).block).toBeUndefined()
  await edit($, CHECKOUT)
  expect((await stop($, false, 'sub1')).block).toBeUndefined()
  expect(host.runs).toEqual([])
})

test('the runner timeout always exceeds its own hard deadline (budget + 5 s)', () => {
  expect(stopBudget(60_000)).toEqual({ budgetMs: 48_000, timeoutMs: 60_000 })
  for (const ms of [1000, 5000, 10_000, 20_000, 60_000, 600_000]) {
    const { budgetMs, timeoutMs } = stopBudget(ms)
    expect(budgetMs).toBeGreaterThanOrEqual(1000)
    expect(timeoutMs).toBeGreaterThan(budgetMs + 5000)
  }
})

test('shadow drift on the Stop path blocks once and the next stop does not re-run the gate', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toContain('/q-pilot accept checkout')
  expect((await stop($, true)).block).toBeUndefined()
  expect(calls(host.runs, 'run').length).toBe(1)
})

test('a drift next to an app-bug keeps the edits so the app-bug can be fixed', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([DRIFT, flow('home', 'app-bug')])]
  await start($)
  await edit($, CHECKOUT)
  expect((await stop($)).block).toBeDefined()
  expect((await stop($, true)).block).toBeDefined()
  expect(calls(host.runs, 'run').length).toBe(2)
})

test('the band counts flaky in shadow, not with trust on', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'flaky')])]
  await start($)
  await edit($, CHECKOUT)
  await stop($)
  expect(host.statuses.at(-1)).toBe('pilot ✗ 1 of 1 flows: checkout flaky')
})

test('trust on: flaky is allowed and the status line stays green', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { trust: 'on' })
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'flaky')])]
  await start($)
  await edit($, CHECKOUT)
  await stop($)
  expect(host.statuses.at(-1)).toBe('pilot ✓ 1/1 flows')
})
