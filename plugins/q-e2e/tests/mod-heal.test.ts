// The test kit answers a plugin's own $.agent.spawn with `{ model }` alone (no agentId: it starts no
// Agent tool), so the healer's turn.complete cannot be matched here. These tests cover the hand-off;
// the diff guard itself is covered by lib-diffguard.test.ts.

import { expect, test } from 'claude-code/testing'

import { RED_CHECKOUT, ROOT, edit, fakeHost, jevAnswer, report, seedProject, start, stop } from './host'

test('test-drift lets the stop through and asks for the Haiku healer on that spec', { options: { jevApiKey: 'k', triage: 'on' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('test-drift', 0.96) }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(r.block).toBeUndefined()
  expect(host.spawned).toEqual([expect.objectContaining({ model: 'haiku', description: 'heal tests/checkout.spec.ts' })])
  expect(host.spawned[0]!.prompt).toMatch(/tests\/checkout\.spec\.ts:42/)
  expect(host.spawned[0]!.prompt).toMatch(/Never add test\.fixme/)
  // The edits were handed over: the next stop has nothing to run.
  expect((await stop($)).block).toBeUndefined()
  // The gate's run and the re-run of the red file; the second stop runs nothing.
  expect(host.runs.filter(a => a.includes('playwright')).length).toBe(2)
})

test('a refused healer spawn is reported, and the stop still goes through', { options: { jevApiKey: 'k', triage: 'on' } }, async ($, on) => {
  const host = fakeHost(on)
  host.spawnDeny = 'agent type disabled'
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('test-drift', 0.96) }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  expect((await stop($)).block).toBeUndefined()
  expect(host.toasts).toContain('q-e2e: healer not started (agent type disabled)')
})

test('/q-e2e explore asks for the explorer with the flow', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await $.command.run({ command: 'q-e2e', args: 'explore "guest checkout"' } as never)
  expect(host.spawned[0]).toEqual(expect.objectContaining({ model: 'haiku', description: 'explore guest checkout' }))
  expect(host.spawned[0]!.prompt).toMatch(/guest checkout/)
})

test('the healer starts from a snapshot of the test files, taken before it is spawned', { options: { jevApiKey: 'k', triage: 'on' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('test-drift', 0.96) }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await stop($)
  // The verify step judges the patch against this, not against `git diff`.
  expect(host.store.get('healBase')).toEqual({ 'tests/checkout.spec.ts': host.files.get(`${ROOT}/tests/checkout.spec.ts`) })
})
