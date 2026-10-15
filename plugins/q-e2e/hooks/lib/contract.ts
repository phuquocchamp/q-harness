// q-e2e shared contract: the pure data types and helper signatures that register.tsx (the mod)
// and hooks/lib/*.ts (pure helpers) agree on. No `$`, no Node, no DOM in this folder.

/** One Playwright spec result, flattened from the JSON reporter. */
export interface SpecResult {
  file: string // e.g. "tests/checkout.spec.ts"
  line: number
  title: string // full title path joined with " › "
  status: 'passed' | 'failed' | 'timedOut' | 'skipped' | 'interrupted' | 'flaky'
  durationMs: number
  retries: number // number of retries actually used
  error?: string // first error message, ANSI stripped, max 2000 chars
  errorContextPath?: string // attachment path of error-context.md, if any
}

/** One finished run, as kept in the evidence store. */
export interface RunEvidence {
  id: string // `${startedAt}`
  startedAt: number // ms epoch
  durationMs: number
  commit?: string // `git rev-parse --short HEAD` when known
  specs: string[] // spec files that were asked to run ([] = whole suite)
  reason: 'stop-gate' | 'command' | 'full-suite' | 'heal-verify'
  exitCode: number
  passed: number
  failed: number
  flaky: number
  skipped: number
  results: SpecResult[] // failed / flaky ones always; passed ones may be omitted
}

export type TriageLabel = 'flaky' | 'test-drift' | 'app-bug' | 'env-auth'

export interface TriageVerdict {
  label: TriageLabel
  p: number // probability of the chosen label, 0..1
  probabilities: Partial<Record<TriageLabel, number>>
  touched?: number // noul: did this turn's diff touch the feature under test
  source: 'jev' | 'haiku' | 'fallback' // 'fallback' = triage failed, treated as app-bug
  latencyMs?: number
}

/** User config of the impact map, read from `q-e2e.config.json` at the repo root. */
export interface ImpactConfig {
  /** Glob of app source → spec globs, e.g. { "src/checkout/**": ["tests/checkout*.spec.ts"] } */
  map?: Record<string, string[]>
  /** Where specs live; default "tests" (also reads testDir from the user's answer, not from TS config) */
  testDir?: string
  /** Tag to run when app code changed but nothing mapped; default "@smoke" */
  smokeTag?: string
  /** Files that never trigger the gate (docs, configs); globs */
  ignore?: string[]
}

/** Result of the impact map for one turn. */
export interface ImpactSelection {
  mode: 'none' | 'specs' | 'smoke' | 'all'
  specs: string[] // spec files to pass to `playwright test`
  why: string[] // short human reasons, e.g. "src/checkout/pay.ts → tests/checkout.spec.ts (map)"
}

/** Diff guard verdict for a healer patch. */
export interface DiffGuardVerdict {
  ok: boolean
  reasons: string[] // e.g. "adds test.fixme", "removes expect()", "edits outside tests/"
}

// ---- helper signatures (implemented in the files named) ----

// hooks/lib/impact.ts
//   export function isUiRelevant(path: string, cfg: ImpactConfig): boolean
//   export function selectSpecs(changed: string[], allSpecs: string[], specSources: Record<string, string>, cfg: ImpactConfig): ImpactSelection
//     - pass 1: cfg.map globs; pass 2: route inference (a changed file under app/<route>/ or pages/<route> or src/routes/<route>
//       matches specs whose source contains goto('/<route>'); pass 3: a changed spec file selects itself;
//       nothing matched but UI-relevant app code changed → mode 'smoke'; no UI-relevant change → mode 'none'
//   export function globToRegExp(glob: string): RegExp
//
// hooks/lib/report.ts
//   export function parseReport(json: string, meta: Pick<RunEvidence,'id'|'startedAt'|'durationMs'|'specs'|'reason'|'exitCode'|'commit'>): RunEvidence
//   export function summarize(run: RunEvidence): string            // one line: "✓ 14/14 specs · 3.2 s" or "✗ 2 failed · checkout.spec.ts:42"
//   export function mergeRerun(first: RunEvidence, again: RunEvidence): RunEvidence  // a red spec green on the re-run → 'flaky'
//   export function blockReason(run: RunEvidence, verdicts: Record<string, TriageVerdict>): string  // text for classic.Stop {block}
//   export function playwrightArgv(sel: ImpactSelection, opts: { smokeTag: string; reportFile: string }): string[]
//     - returns argv after the runner, e.g. ['playwright','test',...specs,'--reporter=json,line'] ; env PLAYWRIGHT_JSON_OUTPUT_NAME carries reportFile
//
// hooks/lib/jev.ts
//   export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
//   export function triageRequest(input: { spec: SpecResult; errorContext?: string; turnDiff?: string; model?: string }): string  // JSON body; redacts secrets; trims state to ~24k chars
//   export function parseTriage(responseText: string): TriageVerdict | undefined  // validates probabilities (finite, 0..1, sum≈1±0.02, choice = argmax), source 'jev'
//   export function redact(text: string, extraSecrets?: string[]): string  // cookies, Authorization/Bearer, set-cookie, password=..., known secret values
//   export const TRIAGE_LABELS: TriageLabel[]
//   export const HAIKU_LABEL_TEXT: Record<TriageLabel, string>  // descriptions for $.model.classify fallback
//
// hooks/lib/diffguard.ts
//   export function checkHealDiff(unifiedDiff: string, testDir: string): DiffGuardVerdict
//     - reject: added test.fixme / test.skip / .only; removed or commented-out expect(; loosened assertions
//       (toBe/toEqual/toHaveText → toBeTruthy/toBeDefined, or adding { timeout } > 30000 ); edits outside testDir
//
// hooks/lib/claims.ts
//   export function claimsSuccess(answer: string): boolean   // "tests pass", "all green", "done", "fixed", "ALL PASSED" (en), not when negated
