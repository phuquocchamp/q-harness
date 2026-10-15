// The turn.complete fallback: when classic.Stop never reached the mod (managed settings can bypass
// it), the main turn's end runs the gate detached and, on red, follows up by the `followUp` option.

import { expect, test } from 'claude-code/testing'

import { GREEN_CHECKOUT, RED_CHECKOUT, ROOT, completeMain, edit, fakeHost, jevAnswer, mainTurn, report, run, seedProject, settle, start, userPrompt } from './host'

const playwrightRuns = (runs: string[][]) => runs.filter(r => r.includes('playwright'))

test('turn.complete without a prior Stop runs Playwright and submits the block as a follow-up', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Changed the label.')
  await settle()
  // The red spec's file is re-run once (the gate runs with --retries=0); still red.
  expect(playwrightRuns(host.runs).length).toBe(2)
  expect(playwrightRuns(host.runs)[1]).toEqual(['npx', 'playwright', 'test', '(?:^|/)tests/checkout\\.spec\\.ts$', '-c', 'playwright.config.ts', '--retries=0', '--reporter=json,line'])
  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]!.text).toMatch(/^E2E: 1 spec\(s\) failed/)
  expect(host.submitted[0]!.text).toMatch(/tests\/checkout\.spec\.ts:42/)
  expect(host.submitted[0]!.origin).toEqual(expect.objectContaining({ kind: 'plugin' }))
})

test('a success claim in the answer leads the follow-up with the contradiction', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done. All tests pass.')
  await settle()
  expect(host.submitted[0]!.text).toMatch(/^You said the tests pass, but q-e2e ran 1 spec\(s\) \(tests\/checkout\.spec\.ts\) after your changes: ✗ 1 failed/)
})

test('"done" without a test claim is quoted as done, not as passing tests', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', "Done. I didn't run anything; specs that look for the old label may need updating.")
  await settle()
  expect(host.submitted[0]!.text).toMatch(/^You said it is done, but q-e2e ran 1 spec\(s\)/)
})

test('a turn whose Stop reached the mod is not gated again at turn.complete', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([GREEN_CHECKOUT]), exitCode: 0 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done.', { stop: true })
  await settle()
  expect(playwrightRuns(host.runs).length).toBe(1)
  expect(host.submitted).toEqual([])
})

test('a green fallback run submits nothing', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([GREEN_CHECKOUT]), exitCode: 0 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done.')
  await settle()
  expect(playwrightRuns(host.runs).length).toBe(1)
  expect(host.submitted).toEqual([])
  expect(host.statuses.at(-1)).toMatch(/^e2e ✓/)
})

test('an aborted turn is not gated', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await $.turn.complete({ answer: '', durationMs: 10, isAborted: true, turnId: 't1', reason: 'aborted' } as never)
  await settle()
  expect(playwrightRuns(host.runs)).toEqual([])
})

test('at most two follow-ups per user prompt; the next user prompt resets the cap', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await userPrompt($, 'change the label')
  for (const t of ['t1', 't2', 't3']) {
    await edit($, `${ROOT}/app/checkout/page.tsx`)
    await mainTurn($, t, 'Done.')
    await settle()
  }
  expect(playwrightRuns(host.runs).length).toBe(6)
  expect(host.submitted.filter(s => (s.origin as { kind: string }).kind === 'plugin').length).toBe(2)
  expect(host.toasts).toContain('q-e2e: still red after 2 follow-ups; not continuing')
  // At the cap the edits were given up: an unrelated prompt with no new edit runs nothing.
  await userPrompt($, 'unrelated question')
  await mainTurn($, 't3b', 'Here is the answer.')
  await settle()
  expect(playwrightRuns(host.runs).length).toBe(6)
  await userPrompt($, 'try again')
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't4', 'Done.')
  await settle()
  expect(host.submitted.filter(s => (s.origin as { kind: string }).kind === 'plugin').length).toBe(3)
})

test('a dropped follow-up falls back to a suggestion and a note', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.submitDrop = 'not now'
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await completeMain($, 't1', 'Done.')
  await settle()
  expect(host.toasts).toContain('q-e2e: follow-up not submitted (not now)')
  expect(host.suggested[0]).toMatch(/^Fix the failing e2e spec\(s\): tests\/checkout\.spec\.ts:42 pays/)
  expect(host.appended.some(t => /^\[q-e2e\] [\s\S]*E2E: 1 spec\(s\) failed/.test(t))).toBe(true)
})

test('followUp suggest proposes the fix in the prompt box and never submits', { options: { followUp: 'suggest' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.suggestShown = false
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done.')
  await settle()
  expect(host.submitted).toEqual([])
  expect(host.suggested.length).toBe(1)
  // The suggestion was refused, so the box is filled instead.
  expect(host.filled[0]).toMatch(/^Fix the failing e2e spec\(s\)/)
  expect(host.appended.some(t => /^\[q-e2e\] [\s\S]*E2E: 1 spec\(s\) failed/.test(t))).toBe(true)
})

test('followUp off only notes the failures for the next prompt', { options: { followUp: 'off' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done.')
  await settle()
  expect(host.submitted).toEqual([])
  expect(host.suggested).toEqual([])
  expect(host.appended.some(t => /^\[q-e2e\] [\s\S]*E2E: 1 spec\(s\) failed/.test(t))).toBe(true)
})

test('shadow triage logs test-drift but gates it as an app bug and never spawns the healer', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('test-drift', 0.98) }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done.')
  await settle()
  expect(host.spawned).toEqual([])
  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]!.text).toMatch(/tests\/checkout\.spec\.ts:42/)
  // The label-independent re-run only: no flaky retry or heal-verify in shadow.
  expect(playwrightRuns(host.runs).length).toBe(2)
  const decisions = host.store.get('decisions') as { label: string; mode: string; gatedAs: string }[]
  expect(decisions).toEqual([expect.objectContaining({ label: 'test-drift', mode: 'shadow', gatedAs: 'app-bug' })])
  const band = await $.ui.mount({ plugin: 'q-e2e', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } } as Parameters<typeof $.ui.mount>[0])
  expect(await band.find({ type: 'Text', text: /\(shadow\) jev: test-drift 0\.98/ })).toBeDefined()
  await band.unmount()
  const status = (await run($, 'status')).text
  expect(status).toMatch(/triage: shadow · follow-up: auto/)
  expect(status).toMatch(/agrees with the gate: 0\/1 \(0%\)/)
  expect((await run($, 'decisions')).text).toMatch(/tests\/checkout\.spec\.ts:42 · jev: test-drift 0\.98 → gated app-bug \(shadow\)/)
})

test('shadow triage also gates the classic Stop path as an app bug', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('test-drift', 0.98) }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const { stopped } = await mainTurn($, 't1', 'Done.', { stop: true })
  await settle()
  expect(stopped!.block).toMatch(/tests\/checkout\.spec\.ts:42/)
  expect(host.spawned).toEqual([])
  expect(host.submitted).toEqual([])
})

test('a red spec that passes on the re-run counts as flaky: no follow-up, even in shadow', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [
    { json: report([RED_CHECKOUT]), exitCode: 1 },
    { json: report([GREEN_CHECKOUT]), exitCode: 0 },
  ]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done. All tests pass.')
  await settle()
  expect(playwrightRuns(host.runs).length).toBe(2)
  expect(host.submitted).toEqual([])
  expect(host.store.get('decisions')).toBeUndefined()
  expect(host.statuses.at(-1)).toMatch(/^e2e ✓ 1\/1 specs · 1 flaky/)
})

test('an edit made while the detached gate runs is kept for the next turn', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.files.set(`${ROOT}/app/cart/page.tsx`, 'export default function Page() { return null }\n')
  host.playwright = [{ json: report([GREEN_CHECKOUT]), exitCode: 0 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await mainTurn($, 't1', 'Done.')
  // Lands before the detached gate clears its snapshot.
  await edit($, `${ROOT}/app/cart/page.tsx`)
  await settle()
  const status = (await run($, 'status')).text
  expect(status).toMatch(/pending edits: 1/)
})
