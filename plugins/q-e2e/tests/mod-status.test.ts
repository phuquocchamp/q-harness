import { expect, test } from 'claude-code/testing'

import { RED_CHECKOUT, ROOT, edit, fakeHost, jevAnswer, report, run, seedProject, start, stop } from './host'

type Status = {
  mode: string
  lastRun: null | { summary: string; failed: number; commit: string | null; failures: { spec: string; triage: { label: string; source: string } | null }[] }
}

test('the status tool answers no run before the first one', async ($, on) => {
  fakeHost(on)
  await start($)
  const r = await $.tool.call({ tool: 'mcp__q-e2e__e2e_status' } as never)
  expect(typeof r.result).toBe('string')
  expect((JSON.parse(r.result as string) as Status).lastRun).toBeNull()
})

test('the status tool returns the last run with its triage verdicts', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('app-bug') }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await stop($)
  const r = await $.tool.call({ tool: 'mcp__q-e2e__e2e_status' } as never)
  // The host takes a string (or a content array) as a tool result, not an object.
  expect(typeof r.result).toBe('string')
  const s = JSON.parse(r.result as string) as Status
  expect(s.mode).toBe('affected')
  expect(s.lastRun!.failed).toBe(1)
  expect(s.lastRun!.commit).toBe('abc1234')
  expect(s.lastRun!.summary).toMatch(/✗ 1 failed · checkout\.spec\.ts:42/)
  expect(s.lastRun!.failures[0]).toEqual(expect.objectContaining({ spec: 'tests/checkout.spec.ts:42', triage: expect.objectContaining({ label: 'app-bug', source: 'jev' }) }))
  expect((await run($, 'status')).text).toMatch(/tests\/checkout\.spec\.ts:42 pays · app-bug p=0\.91 \(jev\)/)
})

test('/q-e2e run all runs the whole suite and the band shows a red run', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  const r = await run($, 'run all')
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/✗ 1 failed/)
  expect(host.runs.find(a => a.includes('playwright'))).toEqual(['npx', 'playwright', 'test', '-c', 'playwright.config.ts', '--reporter=json,line'])
  const band = await $.ui.mount({ plugin: 'q-e2e', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100 } } as Parameters<typeof $.ui.mount>[0])
  expect(await band.find({ type: 'Text', text: /e2e ✗ 1 failed/ })).toBeDefined()
  await band.unmount()
})
