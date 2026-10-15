import { expect, test } from 'claude-code/testing'

import type { RunEvidence, TriageVerdict } from '../hooks/lib/contract'
import { blockReason, mergeRerun, parseReport, playwrightArgv, playwrightEnv, relativeTo, specKey, stripAnsi, summarize } from '../hooks/lib/report'

const META = { id: '1', startedAt: 1, durationMs: 3200, specs: [], reason: 'stop-gate' as const, exitCode: 1 }

const REPORT = {
  config: { rootDir: '/repo/tests', configFile: '/repo/playwright.config.ts' },
  suites: [
    {
      title: 'checkout.spec.ts',
      file: 'checkout.spec.ts',
      specs: [],
      suites: [
        {
          title: 'checkout',
          file: 'checkout.spec.ts',
          specs: [
            {
              title: 'pays an order',
              file: 'checkout.spec.ts',
              line: 42,
              tests: [
                {
                  projectName: 'chromium',
                  status: 'unexpected',
                  results: [
                    {
                      status: 'failed',
                      duration: 1500,
                      retry: 0,
                      error: { message: "\u001b[31mexpect(locator).toHaveText(expected) failed\u001b[39m\nExpected: 'Paid'\nReceived: 'Pending'" },
                      attachments: [{ name: 'error-context', contentType: 'text/markdown', path: '/repo/test-results/checkout-pays/error-context.md' }],
                    },
                    { status: 'timedOut', duration: 1000, retry: 1, error: { message: 'Test timeout of 30000ms exceeded.' }, attachments: [] },
                  ],
                },
              ],
            },
          ],
        },
      ],
    },
    {
      title: 'cart.spec.ts',
      file: 'cart.spec.ts',
      specs: [
        { title: 'adds', file: 'cart.spec.ts', line: 5, tests: [{ status: 'expected', results: [{ status: 'passed', duration: 300 }] }] },
        { title: 'flaky one', file: 'cart.spec.ts', line: 9, tests: [{ status: 'flaky', results: [{ status: 'failed', duration: 100, error: { message: 'boom' } }, { status: 'passed', duration: 90 }] }] },
        { title: 'known bug', file: 'cart.spec.ts', line: 12, tests: [{ status: 'expected', expectedStatus: 'failed', results: [{ status: 'failed', duration: 10 }] }] },
        { title: 'later', file: 'cart.spec.ts', line: 20, tests: [{ status: 'skipped', results: [{ status: 'skipped', duration: 0 }] }] },
      ],
    },
  ],
  errors: [],
  stats: { expected: 2, unexpected: 1, flaky: 1, skipped: 1 },
}

test('flattens suites into spec results with repo-relative paths and outcome-based status', () => {
  const run = parseReport(JSON.stringify(REPORT), META)
  expect(run).toMatchObject({ passed: 2, failed: 1, flaky: 1, skipped: 1, exitCode: 1, id: '1' })
  const [pay, adds, flaky, known, later] = run.results
  expect(pay).toMatchObject({
    file: 'tests/checkout.spec.ts',
    line: 42,
    title: 'checkout › pays an order',
    status: 'timedOut',
    durationMs: 2500,
    retries: 1,
    error: 'Test timeout of 30000ms exceeded.',
  })
  expect(adds).toMatchObject({ file: 'tests/cart.spec.ts', title: 'adds', status: 'passed', retries: 0 })
  expect(adds?.error).toBeUndefined()
  expect(flaky).toMatchObject({ status: 'flaky', retries: 1, error: 'boom' })
  expect(known?.status).toBe('passed')
  expect(later?.status).toBe('skipped')
})

test('error-context path and ANSI-stripped error come from the last failed attempt', () => {
  const one = JSON.parse(JSON.stringify(REPORT)) as typeof REPORT
  one.suites[0]!.suites![0]!.specs[0]!.tests[0]!.results.pop()
  const run = parseReport(JSON.stringify(one), META)
  expect(run.results[0]).toMatchObject({
    status: 'failed',
    error: "expect(locator).toHaveText(expected) failed\nExpected: 'Paid'\nReceived: 'Pending'",
    errorContextPath: 'test-results/checkout-pays/error-context.md',
  })
})

test('an explicit repo root wins over the config folder', () => {
  const run = parseReport(JSON.stringify(REPORT), META, '/repo/tests')
  expect(run.results[0]?.file).toBe('checkout.spec.ts')
  expect(relativeTo('../a/b.ts', '/repo', '/repo/tests')).toBe('a/b.ts')
  expect(relativeTo('/elsewhere/x.ts', '/repo')).toBe('/elsewhere/x.ts')
})

test('several projects put the project name in the title', () => {
  const r = { suites: [{ title: 'a.spec.ts', file: 'a.spec.ts', specs: [{ title: 't', file: 'a.spec.ts', line: 1, tests: [
    { projectName: 'chromium', status: 'expected', results: [{ status: 'passed', duration: 1 }] },
    { projectName: 'firefox', status: 'expected', results: [{ status: 'passed', duration: 1 }] },
  ] }] }] }
  const run = parseReport(JSON.stringify(r), { ...META, exitCode: 0 })
  expect(run.results.map(x => x.title)).toEqual(['[chromium] t', '[firefox] t'])
  expect(run.passed).toBe(2)
})

test('a broken run never reads as green', () => {
  const bad = parseReport('not json', META)
  expect(bad.failed).toBe(1)
  expect(summarize(bad)).toContain('✗')
  const server = parseReport(JSON.stringify({ suites: [], errors: [{ message: 'Error: Timed out waiting 60000ms from config.webServer.' }], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }), META)
  expect(server.failed).toBe(1)
  expect(server.results[0]).toMatchObject({ title: '(run)', status: 'failed' })
  expect(server.results[0]?.error).toContain('webServer')
  const empty = parseReport(JSON.stringify({ suites: [], errors: [], stats: { expected: 0, unexpected: 0, flaky: 0, skipped: 0 } }), META)
  expect(empty.results[0]?.error).toBe('no tests ran (exit code 1)')
  expect(summarize(empty)).toBe('✗ 1 failed · (run)')
})

test('stripAnsi removes colour and cursor codes', () => {
  expect(stripAnsi('\u001b[2m\u001b[31mred\u001b[39m\u001b[22m \u001b[1A\u001b[2Kok')).toBe('red ok')
})

const run = (over: Partial<RunEvidence>): RunEvidence => ({ ...META, exitCode: 0, passed: 0, failed: 0, flaky: 0, skipped: 0, results: [], ...over })

test('summary line', () => {
  expect(summarize(run({ passed: 14 }))).toBe('✓ 14/14 specs · 3.2 s')
  expect(summarize(run({ passed: 13, flaky: 1, durationMs: 800 }))).toBe('✓ 14/14 specs · 1 flaky · 800 ms')
  expect(summarize(run({}))).toBe('– no specs ran · 3.2 s')
  const red = parseReport(JSON.stringify(REPORT), META)
  expect(summarize(red)).toBe('✗ 1 failed · checkout.spec.ts:42')
})

test('block reason lists only app-bug, fallback or untriaged failures', () => {
  const red = parseReport(JSON.stringify(REPORT), META)
  expect(specKey(red.results[0]!)).toBe('tests/checkout.spec.ts:42')
  const text = blockReason(red, {})
  expect(text).toContain('E2E: 1 spec(s) failed')
  expect(text).toContain('- tests/checkout.spec.ts:42 checkout › pays an order: Test timeout of 30000ms exceeded.')
  expect(text).toContain('Re-run: npx playwright test tests/checkout.spec.ts:42')
  expect(text).not.toContain('flaky one')
  const bug: TriageVerdict = { label: 'app-bug', p: 0.97, probabilities: { 'app-bug': 0.97 }, source: 'jev' }
  expect(blockReason(red, { 'tests/checkout.spec.ts:42': bug })).toContain('[app-bug 0.97]')
  const drift: TriageVerdict = { label: 'test-drift', p: 1, probabilities: {}, source: 'jev' }
  expect(blockReason(red, { 'tests/checkout.spec.ts:42': drift })).toBe('')
  const fallback: TriageVerdict = { label: 'test-drift', p: 0, probabilities: {}, source: 'fallback' }
  expect(blockReason(red, { 'tests/checkout.spec.ts:42': fallback })).not.toBe('')
})

test('playwright argv per mode', () => {
  const opts = { smokeTag: '@smoke', reportFile: '/tmp/r.json' }
  expect(playwrightArgv({ mode: 'specs', specs: ['tests/a.spec.ts'], why: [] }, opts)).toEqual(['playwright', 'test', '(?:^|/)tests/a\\.spec\\.ts$', '--reporter=json,line'])
  expect(playwrightArgv({ mode: 'smoke', specs: [], why: [] }, opts)).toEqual(['playwright', 'test', '--grep', '@smoke', '--reporter=json,line'])
  expect(playwrightArgv({ mode: 'all', specs: [], why: [] }, { ...opts, retries: 1 })).toEqual(['playwright', 'test', '--retries=1', '--reporter=json,line'])
  expect(playwrightArgv({ mode: 'all', specs: [], why: [] }, { ...opts, config: 'playwright.config.ts' })).toEqual(['playwright', 'test', '-c', 'playwright.config.ts', '--reporter=json,line'])
  // Specs are anchored regexes with the dots escaped: a.spec.ts must not pick up a.spec.tsx or xa.spec.ts.
  const filter = new RegExp(playwrightArgv({ mode: 'specs', specs: ['tests/a.spec.ts'], why: [] }, opts)[2]!, 'i')
  expect(filter.test('/repo/tests/a.spec.ts')).toBe(true)
  expect(filter.test('/repo/tests/a.spec.tsx')).toBe(false)
  expect(filter.test('/repo/tests/aXspec.ts')).toBe(false)
  expect(filter.test('/repo/tests/xa.spec.ts')).toBe(false)
  expect(playwrightArgv({ mode: 'none', specs: [], why: [] }, opts)).toEqual([])
  expect(playwrightEnv('/tmp/r.json').PLAYWRIGHT_JSON_OUTPUT_NAME).toBe('/tmp/r.json')
})

test('mergeRerun marks a red spec that passed on the re-run as flaky and keeps the others red', () => {
  const spec = (file: string, status: 'passed' | 'failed') => ({ file, line: 4, title: 't', status, durationMs: 10, retries: 0 })
  const first: RunEvidence = { ...META, passed: 0, failed: 2, flaky: 0, skipped: 0, results: [spec('tests/a.spec.ts', 'failed'), spec('tests/b.spec.ts', 'failed')] }
  const again: RunEvidence = { ...META, durationMs: 100, passed: 1, failed: 1, flaky: 0, skipped: 0, results: [spec('tests/a.spec.ts', 'passed'), spec('tests/b.spec.ts', 'failed')] }
  const m = mergeRerun(first, again)
  expect(m.results.map(r => r.status)).toEqual(['flaky', 'failed'])
  expect([m.failed, m.flaky, m.exitCode, m.durationMs]).toEqual([1, 1, 1, 3300])
  const allGreen = mergeRerun({ ...first, failed: 1, results: [spec('tests/a.spec.ts', 'failed')] }, again)
  expect([allGreen.failed, allGreen.flaky, allGreen.exitCode]).toEqual([0, 1, 0])
  expect(summarize(allGreen)).toMatch(/^✓ 1\/1 specs · 1 flaky/)
})
