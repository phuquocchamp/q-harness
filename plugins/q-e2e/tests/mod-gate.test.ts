import { expect, test } from 'claude-code/testing'

import { GREEN_CHECKOUT, RED_CHECKOUT, ROOT, edit, fakeHost, jevAnswer, report, seedProject, start, stop } from './host'

const playwrightRuns = (runs: string[][]) => runs.filter(r => r.includes('playwright'))

test('the gate lets the turn end without a run when no UI-relevant file changed', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  await edit($, `${ROOT}/README.md`)
  const r = await stop($)
  expect(r.block).toBeUndefined()
  expect(playwrightRuns(host.runs)).toEqual([])
})

test('the gate skips a project with no playwright.config at the root', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.files.delete(`${ROOT}/playwright.config.ts`)
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(r.block).toBeUndefined()
  expect(playwrightRuns(host.runs)).toEqual([])
})

test('a green run of the affected spec lets the turn end and shows on the status line', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([GREEN_CHECKOUT]), exitCode: 0 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(r.block).toBeUndefined()
  const pw = playwrightRuns(host.runs)
  expect(pw.length).toBe(1)
  expect(pw[0]).toEqual(['npx', 'playwright', 'test', '(?:^|/)tests/checkout\\.spec\\.ts$', '-c', 'playwright.config.ts', '--retries=0', '--reporter=json,line'])
  expect(host.statuses.at(-1)).toMatch(/^e2e ✓ 1\/1 specs/)
  expect((host.store.get('runs') as unknown[]).length).toBe(1)
})

test('the env wrapper and runner prefix the Playwright argv', { options: { envWrapper: 'op run --env-file=.env.e2e --', runner: 'pnpm exec' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([GREEN_CHECKOUT]), exitCode: 0 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await stop($)
  expect(playwrightRuns(host.runs)[0]!.slice(0, 7)).toEqual(['op', 'run', '--env-file=.env.e2e', '--', 'pnpm', 'exec', 'playwright'])
})

test('a red spec that Jev labels app-bug blocks the stop with the spec and line', { options: { jevApiKey: 'sk-test-123' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.jev = { status: 200, text: jevAnswer('app-bug', 0.97) }
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(r.block).toMatch(/tests\/checkout\.spec\.ts:42/)
  expect(r.block).toMatch(/expected 'Paid' got 'Pending'/)
  expect(host.fetches.length).toBe(1)
  expect(host.fetches[0]!.url).toBe('https://api.typesafe.ai/v1/systemone')
  expect(host.fetches[0]!.headers.authorization).toBe('Bearer sk-test-123')
  expect(host.fetches[0]!.body).not.toContain('sk-test-123')
  const decisions = host.store.get('decisions') as { spec: string; label: string; source: string }[]
  expect(decisions).toEqual([expect.objectContaining({ spec: 'tests/checkout.spec.ts:42', label: 'app-bug', source: 'jev' })])
})

test('the Jev key falls back to TYPESAFE_API_KEY from the environment', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.env.set('TYPESAFE_API_KEY', 'env-key')
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  await stop($)
  expect(host.fetches[0]!.headers.authorization).toBe('Bearer env-key')
})

test('without Jev, Haiku classifies; when both fail the red spec is treated as an app bug', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.classify = 'throw'
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(host.fetches).toEqual([])
  expect(r.block).toMatch(/checkout\.spec\.ts:42/)
  expect((host.store.get('decisions') as { source: string }[])[0]!.source).toBe('fallback')
})

test('Haiku env-auth lets the stop through and notifies', { options: { triage: 'on' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  host.classify = 'env-auth'
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(r.block).toBeUndefined()
  expect(host.notes[0]).toMatch(/environment problem/)
})

test("a subagent's stop is not gated", async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($, false, 'a9')
  expect(r.block).toBeUndefined()
  expect(playwrightRuns(host.runs)).toEqual([])
})

test('the gate blocks at most twice, then lets the turn end', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = [{ json: report([RED_CHECKOUT]), exitCode: 1 }]
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  expect((await stop($, false)).block).toBeDefined()
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  expect((await stop($, true)).block).toBeDefined()
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  expect((await stop($, true)).block).toBeUndefined()
  // Two gated stops, each a run plus the re-run of the red file.
  expect(playwrightRuns(host.runs).length).toBe(4)
  expect(host.toasts.some(t => /2 blocks/.test(t))).toBe(true)
})

test('mode off skips the gate', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  expect((await $.command.run({ command: 'q-e2e', args: 'mode off' } as never)).text).toBe('q-e2e mode off.')
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  expect((await stop($)).block).toBeUndefined()
  expect(playwrightRuns(host.runs)).toEqual([])
  expect(host.store.get('mode')).toBe('off')
})

test('a run that times out lets the turn end with a toast', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.playwright = []
  await start($)
  await edit($, `${ROOT}/app/checkout/page.tsx`)
  const r = await stop($)
  expect(r.block).toBeUndefined()
  expect(host.toasts[0]).toMatch(/q-e2e: Playwright did not finish/)
})

test('an edit outside the project (a scratch file) does not trigger the gate', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  await start($)
  await edit($, '/private/tmp/scratch/probe.py')
  expect((await stop($)).block).toBeUndefined()
  expect(playwrightRuns(host.runs)).toEqual([])
})

test('an unmapped UI change runs the smoke tag and passes when no spec carries it', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.files.set(`${ROOT}/src/components/Button.tsx`, 'export const Button = () => null\n')
  host.playwright = [{ json: report([]), exitCode: 0 }]
  await start($)
  await edit($, `${ROOT}/src/components/Button.tsx`)
  expect((await stop($)).block).toBeUndefined()
  expect(playwrightRuns(host.runs)[0]).toEqual(['npx', 'playwright', 'test', '--grep', '@smoke', '-c', 'playwright.config.ts', '--retries=0', '--reporter=json,line', '--pass-with-no-tests'])
})
