// Playwright JSON reporter → RunEvidence, plus the one-line summary, the Stop block text and the runner argv.
// JSON shape: { config: { rootDir, configFile }, suites: [{ title, file, specs, suites }], errors, stats }
// where spec = { title, file, line, tests: [{ projectName, status: outcome, results: [{ status, duration, retry, error, errors, attachments }] }] }.

import type { ImpactSelection, RunEvidence, SpecResult, TriageVerdict } from './contract'

type Meta = Pick<RunEvidence, 'id' | 'startedAt' | 'durationMs' | 'specs' | 'reason' | 'exitCode' | 'commit'>

interface JsonError { message?: string; stack?: string; value?: string }
interface JsonAttachment { name?: string; path?: string; contentType?: string }
interface JsonResult { status?: string; duration?: number; retry?: number; error?: JsonError; errors?: JsonError[]; attachments?: JsonAttachment[] }
interface JsonTest { projectName?: string; status?: string; expectedStatus?: string; results?: JsonResult[] }
interface JsonSpec { title?: string; file?: string; line?: number; tests?: JsonTest[] }
interface JsonSuite { title?: string; file?: string; specs?: JsonSpec[]; suites?: JsonSuite[] }
interface JsonReport {
  config?: { rootDir?: string; configFile?: string }
  suites?: JsonSuite[]
  errors?: JsonError[]
  stats?: { expected?: number; unexpected?: number; flaky?: number; skipped?: number }
}

export const MAX_ERROR = 2000

const ANSI = /\u001b\[[0-?]*[ -/]*[@-~]|\u001b\][^\u0007]*\u0007/g
export const stripAnsi = (s: string): string => s.replace(ANSI, '')

const cleanError = (e: JsonError | undefined): string | undefined => {
  const text = e?.message ?? e?.value ?? e?.stack
  if (!text) return undefined
  const s = stripAnsi(text).trim()
  return s.length > MAX_ERROR ? s.slice(0, MAX_ERROR) : s
}

const slash = (p: string) => p.replace(/\\/g, '/')
const dirname = (p: string) => slash(p).replace(/\/[^/]*$/, '')

/** Resolves `.` and `..` segments of a `/`-separated path. */
const normalize = (p: string): string => {
  const abs = p.startsWith('/')
  const out: string[] = []
  for (const s of p.split('/')) {
    if (!s || s === '.') continue
    if (s === '..' && out.length && out[out.length - 1] !== '..') out.pop()
    else if (s === '..' && abs) continue
    else out.push(s)
  }
  return (abs ? '/' : '') + out.join('/')
}

const isAbsolute = (p: string) => p.startsWith('/') || /^[A-Za-z]:\//.test(p)

/** Makes `p` (absolute, or relative to `base`) relative to `root`; left as is when outside `root`. */
export function relativeTo(p: string, root: string | undefined, base?: string): string {
  let full = slash(p)
  if (!isAbsolute(full) && base) full = `${slash(base)}/${full}`
  full = normalize(full)
  if (!root) return full
  const r = normalize(slash(root))
  if (full === r) return '.'
  return full.startsWith(`${r}/`) ? full.slice(r.length + 1) : full
}

/** Key of one spec in verdict maps: `tests/checkout.spec.ts:42`. register.tsx must use the same key. */
export const specKey = (r: Pick<SpecResult, 'file' | 'line'>): string => `${r.file}:${r.line}`

const RUN_STATUS = new Set(['passed', 'failed', 'timedOut', 'skipped', 'interrupted'])

function specStatus(t: JsonTest): SpecResult['status'] {
  const results = t.results ?? []
  const last = results[results.length - 1]?.status
  switch (t.status) {
    case 'flaky': return 'flaky'
    case 'skipped': return 'skipped'
    case 'expected': return 'passed' // also covers test.fail() tests that failed as expected
    default: {
      // 'unexpected': the last attempt's own status; a test.fail() that passed shows as 'passed' there.
      if (last === 'passed' || last === 'skipped' || !last || !RUN_STATUS.has(last)) return 'failed'
      return last as SpecResult['status']
    }
  }
}

/**
 * Parses the JSON report. Never throws: an unreadable report, global errors (webServer, config) or an empty
 * run with a non-zero exit code all come back as a failed run with a synthetic result.
 * `repoRoot` makes paths repo-relative; it defaults to the folder of `config.configFile`.
 */
export function parseReport(json: string, meta: Meta, repoRoot?: string): RunEvidence {
  const run: RunEvidence = { ...meta, passed: 0, failed: 0, flaky: 0, skipped: 0, results: [] }
  let report: JsonReport
  try {
    report = JSON.parse(json) as JsonReport
    if (!report || typeof report !== 'object') throw new Error('not an object')
  } catch {
    run.failed = 1
    run.results.push(globalFailure('could not read the Playwright JSON report'))
    return run
  }

  const rootDir = report.config?.rootDir
  const root = repoRoot ?? (report.config?.configFile ? dirname(report.config.configFile) : undefined)
  const counts = { passed: 0, failed: 0, flaky: 0, skipped: 0 }

  const visit = (suite: JsonSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      const tests = spec.tests ?? []
      const projects = new Set(tests.map(t => t.projectName ?? ''))
      for (const t of tests) {
        const results = t.results ?? []
        const status = specStatus(t)
        const failedAttempt = [...results].reverse().find(r => r.status !== 'passed' && r.status !== 'skipped')
        const error = cleanError(failedAttempt?.error ?? failedAttempt?.errors?.[0])
        const ctx = (failedAttempt?.attachments ?? []).find(a => a.name === 'error-context' && a.path)
        const project = projects.size > 1 && t.projectName ? `[${t.projectName}] ` : ''
        const r: SpecResult = {
          file: relativeTo(spec.file ?? suite.file ?? '', root, rootDir),
          line: spec.line ?? 0,
          title: project + [...titles, spec.title ?? ''].filter(Boolean).join(' › '),
          status,
          durationMs: Math.round(results.reduce((n, x) => n + (x.duration ?? 0), 0)),
          retries: Math.max(0, results.length - 1),
        }
        if (error && status !== 'passed' && status !== 'skipped') r.error = error
        if (ctx?.path && status !== 'passed') r.errorContextPath = relativeTo(ctx.path, root, rootDir)
        run.results.push(r)
        if (status === 'passed') counts.passed++
        else if (status === 'flaky') counts.flaky++
        else if (status === 'skipped') counts.skipped++
        else counts.failed++
      }
    }
    for (const child of suite.suites ?? []) visit(child, [...titles, child.title ?? ''])
  }
  // A top-level suite is a file; its title is the file path, so it is left out of the title path.
  for (const top of report.suites ?? []) visit(top, [])

  const s = report.stats
  run.passed = s?.expected ?? counts.passed
  run.failed = s?.unexpected ?? counts.failed
  run.flaky = s?.flaky ?? counts.flaky
  run.skipped = s?.skipped ?? counts.skipped

  const globalErrors = (report.errors ?? []).map(cleanError).filter((e): e is string => !!e)
  if (globalErrors.length > 0) {
    run.results.push(globalFailure(globalErrors.join('\n\n').slice(0, MAX_ERROR)))
    run.failed++
  } else if (meta.exitCode !== 0 && run.failed === 0) {
    const ran = run.passed + run.flaky
    run.results.push(globalFailure(ran === 0 ? `no tests ran (exit code ${meta.exitCode})` : `Playwright exited with code ${meta.exitCode}`))
    run.failed++
  }
  return run
}

const globalFailure = (error: string): SpecResult => ({ file: '', line: 0, title: '(run)', status: 'failed', durationMs: 0, retries: 0, error })

const RED = new Set<SpecResult['status']>(['failed', 'timedOut', 'interrupted'])
export const failedResults = (run: RunEvidence): SpecResult[] => run.results.filter(r => RED.has(r.status))

const basename = (p: string) => p.replace(/^.*\//, '')

export const formatDuration = (ms: number): string => {
  if (ms < 1000) return `${Math.round(ms)} ms`
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)} s`
  const m = Math.floor(ms / 60_000)
  return `${m} min ${Math.round((ms % 60_000) / 1000)} s`
}

const where = (r: SpecResult) => (r.file ? `${basename(r.file)}:${r.line}` : r.title)

/**
 * Folds a re-run of the red spec files into the first run: a red spec that passed on the re-run
 * becomes 'flaky' (as Playwright's own retry would have marked it). Specs absent from the re-run,
 * and run-level failures (no file), stay red.
 */
export function mergeRerun(first: RunEvidence, again: RunEvidence): RunEvidence {
  const id = (r: SpecResult) => `${r.file}:${r.line} ${r.title}`
  const green = new Set(again.results.filter(r => r.status === 'passed' || r.status === 'flaky').map(id))
  let recovered = 0
  const results = first.results.map(r => {
    if (!RED.has(r.status) || !r.file || !green.has(id(r))) return r
    recovered++
    return { ...r, status: 'flaky' as const, retries: r.retries + 1 }
  })
  if (recovered === 0) return { ...first, durationMs: first.durationMs + again.durationMs }
  const failed = Math.max(0, first.failed - recovered)
  const stillRed = results.some(r => RED.has(r.status))
  return {
    ...first,
    results,
    failed,
    flaky: first.flaky + recovered,
    durationMs: first.durationMs + again.durationMs,
    exitCode: failed === 0 && !stillRed ? 0 : first.exitCode,
  }
}

/** One line: "✓ 14/14 specs · 3.2 s" or "✗ 2 failed · checkout.spec.ts:42". ✓ only when the run really passed. */
export function summarize(run: RunEvidence): string {
  const red = failedResults(run)
  if (run.exitCode === 0 && run.failed === 0 && red.length === 0) {
    const ran = run.passed + run.flaky
    if (ran === 0) return `– no specs ran · ${formatDuration(run.durationMs)}`
    const flaky = run.flaky ? ` · ${run.flaky} flaky` : ''
    return `✓ ${ran}/${ran} specs${flaky} · ${formatDuration(run.durationMs)}`
  }
  const n = Math.max(run.failed, red.length, 1)
  const first = red[0]
  return first ? `✗ ${n} failed · ${where(first)}` : `✗ ${n} failed · exit code ${run.exitCode}`
}

const firstLine = (s: string | undefined) => (s ?? '').split('\n').map(l => l.trim()).find(Boolean) ?? 'failed'

const BLOCKING = (v: TriageVerdict | undefined) => !v || v.source === 'fallback' || v.label === 'app-bug'
export const MAX_BLOCK_SPECS = 5

/**
 * Text for `classic.Stop {block}`: the failed specs whose verdict is app-bug, fallback or missing.
 * Verdicts are keyed by `specKey`. Flaky outcomes never block. Empty string when nothing should block.
 */
export function blockReason(run: RunEvidence, verdicts: Record<string, TriageVerdict>): string {
  const blocking = failedResults(run).filter(r => BLOCKING(verdicts[specKey(r)]))
  if (blocking.length === 0) return ''
  const lines = blocking.slice(0, MAX_BLOCK_SPECS).map(r => {
    const v = verdicts[specKey(r)]
    const label = v && v.source !== 'fallback' ? ` [${v.label} ${v.p.toFixed(2)}]` : ''
    const at = r.file ? `${specKey(r)} ${r.title}` : r.title
    return `- ${at}: ${firstLine(r.error)}${label}`
  })
  if (blocking.length > MAX_BLOCK_SPECS) lines.push(`- and ${blocking.length - MAX_BLOCK_SPECS} more`)
  const files = [...new Set(blocking.filter(r => r.file).map(specKey))]
  const rerun = files.length ? `\nRe-run: npx playwright test ${files.join(' ')}` : ''
  return `E2E: ${blocking.length} spec(s) failed after this turn's changes. Fix before finishing.\n${lines.join('\n')}${rerun}`
}

/** Playwright reads a file argument as a regex on the path: escape it and pin both ends (`a.spec.ts` must not match `a.spec.tsx`). */
const specFilter = (spec: string) => `(?:^|/)${spec.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`

/**
 * argv after the runner (`npx`), e.g. ['playwright','test','tests/a.spec.ts','--reporter=json,line'].
 * The JSON report path goes through the environment (see `playwrightEnv`). Mode 'none' gives [].
 */
export function playwrightArgv(sel: ImpactSelection, opts: { smokeTag: string; reportFile: string; retries?: number; config?: string }): string[] {
  if (sel.mode === 'none') return []
  const argv = ['playwright', 'test']
  if (sel.mode === 'specs') argv.push(...sel.specs.map(specFilter))
  if (sel.mode === 'smoke') argv.push('--grep', opts.smokeTag)
  if (opts.config) argv.push('-c', opts.config)
  if (opts.retries !== undefined) argv.push(`--retries=${opts.retries}`)
  argv.push('--reporter=json,line')
  return argv
}

/** Environment that sends the JSON reporter to `reportFile`. FILE wins over NAME on newer Playwright; NAME covers older ones. */
export const playwrightEnv = (reportFile: string): Record<string, string> => ({
  PLAYWRIGHT_JSON_OUTPUT_NAME: reportFile,
  PLAYWRIGHT_JSON_OUTPUT_FILE: reportFile,
})
