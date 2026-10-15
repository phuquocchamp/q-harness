// q-e2e: turns "tests pass" into evidence. It records the files the main loop edits, and when the
// main turn tries to stop after UI-relevant edits it runs the affected Playwright specs. A red spec
// is triaged (Jev, then Haiku, then "app-bug"): an app bug blocks the stop, a drifted locator is
// handed to a guarded Haiku healer in the background, a broken environment only notifies.
// When the classic Stop hook never reaches this module (managed settings can bypass user plugins'
// classic.Stop), the main turn's turn.complete runs the same gate detached and, on red, submits
// the failures as a follow-up prompt. Triage starts in shadow mode: labels are logged, not acted on.
// Every hook and every helper that takes `$` lives in this file (the engine follows `$` only within
// one module); pure helpers are in ./lib.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { E2eHealing, E2eMode, E2eRun, E2eStopSeen, E2eVerdict } from '../types'
import { claimsSuccess } from './lib/claims'
import type { ImpactConfig, ImpactSelection, RunEvidence, SpecResult, TriageLabel, TriageVerdict } from './lib/contract'
import { BINARY_FILE, checkHealDiff, checkHealFiles, diffSnapshots } from './lib/diffguard'
import { isUiRelevant, selectSpecs } from './lib/impact'
import { HAIKU_LABEL_TEXT, JEV_URL, TRIAGE_LABELS, parseTriage, redact, triageRequest } from './lib/jev'
import { blockReason, mergeRerun, parseReport, playwrightArgv, playwrightEnv, specKey, summarize } from './lib/report'

const edits = atom({ plugin: 'q-e2e', key: 'edits' } as const, [] as string[])
const blocks = atom({ plugin: 'q-e2e', key: 'blocksThisTurn' } as const, 0 as number)
const lastRun = atom({ plugin: 'q-e2e', key: 'lastRun' } as const, null as E2eRun | null)
const verdicts = atom({ plugin: 'q-e2e', key: 'verdicts' } as const, {} as Record<string, E2eVerdict>)
const healing = atom({ plugin: 'q-e2e', key: 'healing' } as const, null as E2eHealing | null)
const modeOverride = atom({ plugin: 'q-e2e', key: 'mode' } as const, null as E2eMode | null)
const currentTurn = atom({ plugin: 'q-e2e', key: 'currentTurn' } as const, null as string | null)
const stopSeen = atom({ plugin: 'q-e2e', key: 'stopSeen' } as const, null as E2eStopSeen | null)
const followUps = atom({ plugin: 'q-e2e', key: 'followUps' } as const, 0 as number)
const interactive = atom({ plugin: 'q-e2e', key: 'interactive' } as const, true as boolean)

const TOOL = 'e2e_status'
/** `mcp__q-e2e__e2e_status`, tolerating a namespaced plugin segment (`plugin_q-e2e`, `q-e2e@inline`). */
const TOOL_RE = /^mcp__[\w@.-]*q-e2e[\w@.-]*__e2e_status$/
const CONFIG_FILE = 'q-e2e.config.json'
const REPORT_FILE = '.q-e2e/last-report.json'
const HEALER = 'q-e2e:healer'
/** Store key of the test files' contents as they were when the healer started. */
const HEAL_BASE = 'healBase'
const EXPLORER = 'q-e2e:explorer'
const MAX_BLOCKS = 2
const MAX_FOLLOW_UPS = 2
/** Prompt origins that are the person's own prompt: they reset the follow-up cap. */
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])
const MAX_TRIAGED = 3
const JEV_TIMEOUT_MS = 800
/** Playwright gets this share of maxStopSeconds; triage and a flaky retry use the rest. */
const RUN_SHARE = 0.75
/** The share of maxStopSeconds the red-spec re-run leaves for triage. */
const TRIAGE_RESERVE = 0.1
/** A run started from /q-e2e may take this long (the process.run ceiling). */
const COMMAND_TIMEOUT_MS = 600_000
const HISTORY = 20
const DECISIONS = 200
const SPEC_RE = /\.(spec|test)\.[cm]?[jt]sx?$/
const MAX_SPECS = 300
const MAX_SOURCES = 200
const MAX_SNAPSHOT_FILES = 1000
const SOURCE_CAP = 20_000
const CONTEXT_CAP = 24_000
const DIFF_CAP = 20_000
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const RED = new Set(['failed', 'timedOut', 'interrupted'])
const RED_HEX = '#ff7b6b'
const WARN_HEX = '#ffc04d'

const USAGE = [
  'Usage: /q-e2e <subcommand>',
  '  run              run the specs affected by this turn\'s edits',
  '  run all          run the whole suite',
  '  status           last run, triage verdicts, healer and the triage log summary',
  '  decisions        the triage decision log (shadow agreement) in more detail',
  '  explore "<flow>" spawn the explorer to write a spec for a flow',
  '  heal <spec>      spawn the guarded healer on a spec',
  '  init             preview and write the secrets kit (never overwrites)',
  '  mode off|affected|all',
].join('\n')

/** The plugin's options, coerced: register receives them unchecked. */
type FollowUp = 'auto' | 'suggest' | 'off'
type TriageMode = 'shadow' | 'on'

type Opts = {
  mode: E2eMode
  followUp: FollowUp
  triage: TriageMode
  maxStopMs: number
  runner: string[]
  wrapper: string[]
  jevKey: string
}

const words = (v: unknown) => String(v ?? '').split(/\s+/).filter(Boolean)

const optsOf = (options: PluginOptions): Opts => {
  const mode = String(options.mode ?? 'affected')
  const seconds = Number(options.maxStopSeconds)
  const runner = words(options.runner ?? 'npx')
  const followUp = String(options.followUp ?? 'auto')
  return {
    mode: mode === 'off' || mode === 'all' ? mode : 'affected',
    followUp: followUp === 'suggest' || followUp === 'off' ? followUp : 'auto',
    triage: String(options.triage ?? 'shadow') === 'on' ? 'on' : 'shadow',
    maxStopMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000,
    runner: runner.length > 0 ? runner : ['npx'],
    wrapper: words(options.envWrapper),
    jevKey: String(options.jevApiKey ?? ''),
  }
}

const isRed = (r: SpecResult) => RED.has(r.status)
const cap = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}\n…(truncated)` : text)
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---- small $ helpers -------------------------------------------------------------------------------

/** The repo-relative form of a path the tools give absolute. */
async function relPath($: EngineInterface, path: string): Promise<string | undefined> {
  const root = await $.session.root()
  const base = root.endsWith('/') ? root : `${root}/`
  if (path.startsWith(base)) return path.slice(base.length)
  // A relative path is the project's; an absolute one elsewhere (scratch files, ~/) is not.
  return path.startsWith('/') ? undefined : path.replace(/^\.\//, '')
}

async function effectiveMode($: EngineInterface, o: Opts): Promise<E2eMode> {
  return (await read($, modeOverride)) ?? o.mode
}

/** Forgets `handled` (the snapshot a gate ran on), or every edit; edits made meanwhile stay. */
async function clearEdits($: EngineInterface, handled?: readonly string[]) {
  await update($, edits, list => (handled ? list.filter(p => !handled.includes(p)) : []))
}

/** `q-e2e.config.json` at the project root, or {} when absent or unreadable. */
async function loadConfig($: EngineInterface): Promise<ImpactConfig> {
  try {
    const path = `${await $.session.root()}/${CONFIG_FILE}`
    if (!(await $.fs.exists(path))) return {}
    const parsed = JSON.parse(await $.fs.read(path)) as unknown
    return parsed && typeof parsed === 'object' ? (parsed as ImpactConfig) : {}
  } catch {
    return {}
  }
}

const PLAYWRIGHT_CONFIGS = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map(ext => `playwright.config.${ext}`)

/**
 * The Playwright config at the project root, or undefined. Without one, `playwright test` takes the
 * root as testDir and loads every *.test.ts / *.spec.ts in the repo (unit tests, vendored examples).
 */
async function playwrightConfig($: EngineInterface): Promise<string | undefined> {
  const root = await $.session.root()
  for (const name of PLAYWRIGHT_CONFIGS) {
    if (await $.fs.exists(`${root}/${name}`).catch(() => false)) return name
  }
  return undefined
}

const testDirOf = (cfg: ImpactConfig) => (cfg.testDir ?? 'tests').replace(/^\.\//, '').replace(/\/$/, '')

/** Spec files under the test dir, repo-relative, breadth first, capped. */
async function listSpecs($: EngineInterface, testDir: string): Promise<string[]> {
  const root = await $.session.root()
  const found: string[] = []
  const queue = [testDir]
  while (queue.length > 0 && found.length < MAX_SPECS) {
    const dir = queue.shift()!
    let entries
    try {
      entries = await $.fs.list(`${root}/${dir}`)
    } catch {
      continue
    }
    for (const entry of entries) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const rel = `${dir}/${entry.name}`
      if (entry.kind === 'dir') queue.push(rel)
      else if (entry.kind === 'file' && SPEC_RE.test(entry.name)) found.push(rel)
    }
  }
  return found.sort()
}

async function readSources($: EngineInterface, specs: readonly string[]): Promise<Record<string, string>> {
  const root = await $.session.root()
  const out: Record<string, string> = {}
  for (const spec of specs.slice(0, MAX_SOURCES)) {
    try {
      out[spec] = (await $.fs.read(`${root}/${spec}`)).slice(0, SOURCE_CAP)
    } catch {
      // An unreadable spec is matched by name only.
    }
  }
  return out
}

async function shortCommit($: EngineInterface): Promise<string | undefined> {
  try {
    const r = await $.process.run(['git', 'rev-parse', '--short', 'HEAD'], { cwd: await $.session.root(), timeoutMs: 5000 })
    return r.exitCode === 0 ? r.stdout.trim() || undefined : undefined
  } catch {
    return undefined
  }
}

/** `git diff` of the given files (all when empty), redacted and capped. */
async function gitDiff($: EngineInterface, files: readonly string[], secrets: string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', 'diff', '--no-color', '--', ...files], { cwd: await $.session.root(), timeoutMs: 10_000 })
    return cap(redact(r.stdout, secrets), DIFF_CAP)
  } catch {
    return ''
  }
}

/**
 * Contents of the text files under the test dir (dot entries and node_modules left out), repo-relative.
 * Throws on any list or read error: a guard built on an incomplete snapshot would fail open.
 */
async function snapshotDir($: EngineInterface, testDir: string): Promise<Record<string, string>> {
  const root = await $.session.root()
  const out: Record<string, string> = {}
  const queue = [testDir]
  while (queue.length > 0) {
    const dir = queue.shift()!
    for (const entry of await $.fs.list(`${root}/${dir}`)) {
      if (entry.name === 'node_modules' || entry.name.startsWith('.')) continue
      const rel = `${dir}/${entry.name}`
      if (entry.kind === 'dir') queue.push(rel)
      else if (entry.kind === 'file' && !BINARY_FILE.test(entry.name)) {
        if (Object.keys(out).length >= MAX_SNAPSHOT_FILES) throw new Error(`more than ${MAX_SNAPSHOT_FILES} files under ${testDir}/`)
        out[rel] = await $.fs.read(`${root}/${rel}`)
      }
    }
  }
  return out
}

async function errorContextOf($: EngineInterface, spec: SpecResult, secrets: string[]): Promise<string | undefined> {
  if (!spec.errorContextPath) return undefined
  try {
    const path = spec.errorContextPath.startsWith('/') ? spec.errorContextPath : `${await $.session.root()}/${spec.errorContextPath}`
    if (!(await $.fs.exists(path))) return undefined
    return cap(redact(await $.fs.read(path), secrets), CONTEXT_CAP)
  } catch {
    return undefined
  }
}

async function jevKeyOf($: EngineInterface, o: Opts): Promise<string> {
  if (o.jevKey) return o.jevKey
  try {
    return (await $.env.get('TYPESAFE_API_KEY')) ?? ''
  } catch {
    return ''
  }
}

/** Adds a hidden user-role note the model reads with the next prompt. */
async function note($: EngineInterface, text: string) {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[q-e2e] ${text}` }] } }).catch(() => undefined)
}

// ---- running Playwright ----------------------------------------------------------------------------

type RunOutcome = { run: RunEvidence } | { error: string }

/**
 * Runs `[...envWrapper, ...runner, ...playwrightArgv(sel)]` in the project root with the JSON
 * reporter writing to .q-e2e/last-report.json, and parses that report. Rejections (timeout, a
 * missing runner) and a missing report answer `{ error }`: neither says anything about the app.
 */
async function runPlaywright($: EngineInterface, o: Opts, sel: ImpactSelection, cfg: ImpactConfig, reason: RunEvidence['reason'], timeoutMs: number): Promise<RunOutcome> {
  const root = await $.session.root()
  // Without a config Playwright takes the root as testDir and loads every *.test.ts in the repo.
  const config = await playwrightConfig($)
  if (!config) return { error: 'no playwright.config at the project root, so there is nothing to run' }
  const reportFile = `${root}/${REPORT_FILE}`
  // The gate retries a flaky spec itself (after triage), so its runs skip the config's retries: a drifted
  // locator waits the whole test timeout, and `retries: 1` would double that past the stop budget.
  const retries = reason === 'stop-gate' ? { retries: 0 } : {}
  const argv = [...o.wrapper, ...o.runner, ...playwrightArgv(sel, { smokeTag: cfg.smokeTag ?? '@smoke', reportFile, config, ...retries })]
  // A project with no smoke-tagged spec has nothing to gate: Playwright otherwise exits 1 ("No tests found").
  if (sel.mode === 'smoke') argv.push('--pass-with-no-tests')
  // A stale report from an earlier run must not pass for this one ($.fs has no delete).
  await $.fs.write(reportFile, '').catch(() => undefined)
  const commit = await shortCommit($)
  const startedAt = await $.clock.now()
  let exitCode: number
  let stderr = ''
  try {
    const r = await $.process.run(argv, { cwd: root, env: playwrightEnv(reportFile), timeoutMs: Math.max(1, Math.min(timeoutMs, COMMAND_TIMEOUT_MS)) })
    exitCode = r.exitCode
    stderr = r.stderr
  } catch (err) {
    return { error: `Playwright did not finish within ${Math.round(timeoutMs / 1000)} s or could not start: ${errMsg(err)}` }
  }
  const durationMs = (await $.clock.now()) - startedAt
  let json = ''
  try {
    json = await $.fs.read(reportFile)
  } catch {
    // Handled below.
  }
  if (!json.trim()) return { error: `no JSON report (exit ${exitCode})${stderr ? `: ${stderr.trim().split('\n').slice(-3).join(' ')}` : ''}` }
  try {
    const run = parseReport(json, { id: `${startedAt}`, startedAt, durationMs, specs: sel.specs, reason, exitCode, ...(commit ? { commit } : {}) }, root)
    return { run }
  } catch (err) {
    return { error: `could not parse the report: ${errMsg(err)}` }
  }
}

/** Keeps a run as the last one, in the history, and on the status line. */
async function recordRun($: EngineInterface, run: RunEvidence) {
  await update($, lastRun, () => run as E2eRun)
  try {
    const old = await $.store.get('runs')
    const history = Array.isArray(old) ? (old as RunEvidence[]) : []
    await $.store.set('runs', [...history, run].slice(-HISTORY))
    await $.store.set('lastRun', run)
  } catch {
    // The evidence stays in state for this session.
  }
  $.ui.status(`e2e ${summarize(run)}`)
  $.ui.invalidate('ui.render')
}

// ---- triage ----------------------------------------------------------------------------------------

/** Shadow-mode decision log: what triage said, by whom, how fast. */
async function logDecision($: EngineInterface, o: Opts, spec: SpecResult, v: TriageVerdict) {
  try {
    const old = await $.store.get('decisions')
    const list = Array.isArray(old) ? old : []
    // In shadow every red spec gates as an app bug, whatever the label.
    const gatedAs = o.triage === 'shadow' || v.source === 'fallback' ? 'app-bug' : v.label
    const entry = { spec: specKey(spec), label: v.label, p: v.p, source: v.source, latencyMs: v.latencyMs ?? null, mode: o.triage, gatedAs, at: await $.clock.now() }
    await $.store.set('decisions', [...list, entry].slice(-DECISIONS))
  } catch {
    // The log is best effort.
  }
}

/** Jev within 800 ms, else Haiku classify, else app-bug ('fallback'). Never throws. */
async function triage($: EngineInterface, o: Opts, spec: SpecResult, errorContext: string | undefined, turnDiff: string): Promise<TriageVerdict> {
  const t0 = await $.clock.now()
  const key = await jevKeyOf($, o)
  const secrets = key ? [key] : []
  const done = async (v: TriageVerdict) => {
    const verdict = { ...v, latencyMs: (await $.clock.now().catch(() => t0)) - t0 }
    await logDecision($, o, spec, verdict)
    return verdict
  }
  if (key) {
    try {
      const body = triageRequest({ spec, secrets, ...(errorContext ? { errorContext } : {}), ...(turnDiff ? { turnDiff } : {}) })
      const res = await Promise.race([
        $.http.fetch(JEV_URL, { method: 'POST', headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' }, body }),
        $.clock.sleep(JEV_TIMEOUT_MS).then(() => undefined),
      ])
      const v = res?.ok ? parseTriage(res.text) : undefined
      if (v) return done(v)
    } catch {
      // Refused by policy, network down: Haiku decides.
    }
  }
  try {
    const text = [
      'Classify this failed Playwright end-to-end test. Labels:',
      ...TRIAGE_LABELS.map(l => `- ${l}: ${HAIKU_LABEL_TEXT[l]}`),
      '',
      `Spec: ${specKey(spec)} ${spec.title} (status ${spec.status}, retries ${spec.retries})`,
      `Error: ${redact(spec.error ?? '(none)', secrets)}`,
      errorContext ? `Page context:\n${errorContext.slice(0, 6000)}` : '',
      turnDiff ? `Diff of this turn:\n${turnDiff.slice(0, 6000)}` : '',
    ].join('\n')
    const label = await $.model.classify(text, TRIAGE_LABELS, { model: 'haiku' })
    if (label && (TRIAGE_LABELS as readonly string[]).includes(label)) {
      // classify gives no probability; 0.5 marks a single-sample answer.
      return done({ label: label as TriageLabel, p: 0.5, probabilities: { [label]: 0.5 }, source: 'haiku' })
    }
  } catch {
    // Falls through to app-bug.
  }
  return done({ label: 'app-bug', p: 1, probabilities: { 'app-bug': 1 }, source: 'fallback' })
}

// ---- healer and explorer ---------------------------------------------------------------------------

const healerPrompt = (spec: SpecResult, testDir: string, errorContext: string | undefined) =>
  [
    `A Playwright spec started failing because the UI changed, not because the app broke (triage: test-drift).`,
    `Spec: ${spec.file}:${spec.line} — ${spec.title}`,
    `Error:\n${spec.error ?? '(none)'}`,
    errorContext ? `Error context (aria snapshot at failure):\n${errorContext}` : '',
    '',
    'Fix the locators only, so the spec passes against the current UI.',
    `- Edit only ${spec.file} (inside ${testDir}/). Never edit app code.`,
    '- Never add test.fixme, test.skip or .only; never remove, comment out or loosen an expect.',
    '- Prefer getByRole / getByLabel / getByText locators.',
    'q-e2e checks your diff and re-runs the spec when you finish; a patch that breaks these rules is rejected.',
  ]
    .filter(Boolean)
    .join('\n')

/** Starts the healer on one spec; answers the reason when it could not start. */
async function spawnHealer($: EngineInterface, spec: SpecResult, testDir: string, errorContext: string | undefined): Promise<string | undefined> {
  const current = await read($, healing)
  if (current && (current.status === 'running' || current.status === 'verifying')) return `the healer is already working on ${current.spec}`
  // The baseline its patch is judged against, taken before it can edit anything.
  try {
    await $.store.set(HEAL_BASE, await snapshotDir($, testDir))
  } catch (err) {
    return `could not snapshot ${testDir}/ for the diff guard: ${errMsg(err)}`
  }
  const r = await $.agent.spawn({
    prompt: healerPrompt(spec, testDir, errorContext),
    description: `heal ${spec.file}`,
    subagentType: HEALER,
    model: 'haiku',
    name: 'q-e2e-healer',
  })
  if (r.deny || !r.agentId) return r.deny ?? 'the healer did not start'
  const agentId = r.agentId
  const startedAt = await $.clock.now()
  await update($, healing, () => ({ agentId, spec: spec.file, line: spec.line, startedAt, status: 'running' as const, files: [], reasons: [] }))
  $.ui.invalidate('ui.render')
  return undefined
}

/** After the healer's turn: guard its diff, re-run the spec, and tell the model either way. */
async function verifyHeal($: EngineInterface, o: Opts, heal: E2eHealing) {
  const cfg = await loadConfig($)
  const testDir = testDirOf(cfg)
  const finish = async (status: E2eHealing['status'], reasons: string[]) => {
    await update($, healing, cur => (cur && cur.agentId === heal.agentId ? { ...cur, status, reasons } : cur))
    $.ui.invalidate('ui.render')
  }
  if (heal.files.length === 0) {
    await finish('failed', ['the healer made no edit'])
    await note($, `The healer made no change to ${heal.spec}:${heal.line}. Treat the failure as an app bug and investigate it.`)
    return
  }
  // Judged on the test files' contents before and after, not on `git diff` (blind to untracked and
  // ignored files, and capped). Any file outside the test dir or any unreadable snapshot rejects the patch.
  const guard = checkHealFiles(heal.files, testDir)
  try {
    const before = (await $.store.get(HEAL_BASE)) as Record<string, string> | undefined
    if (!before || typeof before !== 'object') throw new Error('no baseline of the test files')
    const verdict = checkHealDiff(diffSnapshots(before, await snapshotDir($, testDir)), testDir)
    for (const reason of verdict.reasons) if (!guard.reasons.includes(reason)) guard.reasons.push(reason)
  } catch (err) {
    guard.reasons.push(`could not check the patch: ${errMsg(err)}`)
  }
  if (guard.reasons.length > 0) {
    await finish('rejected', guard.reasons)
    $.ui.toast(`q-e2e: healer patch of ${heal.spec} rejected`, { timeoutMs: 8000 })
    await note(
      $,
      `The healer's patch of ${heal.spec} was REJECTED (${guard.reasons.join('; ')}). The patch is still in the working tree (${heal.files.join(', ')}): revert it, and treat ${heal.spec}:${heal.line} as an app bug to fix in the app code.`,
    )
    return
  }
  await finish('verifying', [])
  const outcome = await runPlaywright($, o, { mode: 'specs', specs: [heal.spec], why: ['heal-verify'] }, cfg, 'heal-verify', o.maxStopMs)
  if ('error' in outcome) {
    await finish('failed', [outcome.error])
    await note($, `The healer patched ${heal.spec}, but its re-run did not complete: ${outcome.error}`)
    return
  }
  await recordRun($, outcome.run)
  const green = outcome.run.failed === 0
  await finish(green ? 'passed' : 'failed', [summarize(outcome.run)])
  await note(
    $,
    green
      ? `The healer fixed the locators of ${heal.spec} (${heal.files.join(', ')}); the re-run is green: ${summarize(outcome.run)}.`
      : `The healer patched ${heal.spec}, but the re-run is still red: ${summarize(outcome.run)}. Treat it as an app bug.`,
  )
}

// ---- the stop gate ---------------------------------------------------------------------------------

type GateResult = { block?: string; run?: RunEvidence; changed?: string[] }

/**
 * `stopHookActive`: the classic Stop input's flag (a stop right after a block). `fallback`: called
 * from turn.complete, which keeps its own follow-up cap, so the Stop path's block counter is left alone.
 */
type GateCall = { stopHookActive: boolean; fallback?: boolean }

/** Runs the specs this turn's edits affect and decides whether the main loop may stop. */
async function gate($: EngineInterface, o: Opts, call: GateCall): Promise<GateResult | undefined> {
  if (!call.fallback && !call.stopHookActive) await update($, blocks, () => 0)
  const mode = await effectiveMode($, o)
  if (mode === 'off') return void (await clearEdits($))
  const changed = await read($, edits)
  const cfg = await loadConfig($)
  if (!changed.some(p => isUiRelevant(p, cfg))) return void (await clearEdits($, changed))
  // Not a Playwright project (or not set up yet): nothing to gate.
  if (!(await playwrightConfig($))) return void (await clearEdits($, changed))
  if (!call.fallback && (await read($, blocks)) >= MAX_BLOCKS) {
    $.ui.toast(`q-e2e: still red after ${MAX_BLOCKS} blocks; letting the turn end`, { timeoutMs: 8000 })
    return void (await clearEdits($, changed))
  }

  const testDir = testDirOf(cfg)
  let sel: ImpactSelection
  if (mode === 'all') sel = { mode: 'all', specs: [], why: ['mode all'] }
  else {
    const specs = await listSpecs($, testDir)
    sel = selectSpecs(changed, specs, await readSources($, specs), cfg)
  }
  if (sel.mode === 'none') return void (await clearEdits($, changed))

  const t0 = await $.clock.now()
  $.ui.status(`e2e running ${sel.mode === 'specs' ? `${sel.specs.length} spec(s)` : sel.mode}…`)
  const outcome = await runPlaywright($, o, sel, cfg, 'stop-gate', o.maxStopMs * RUN_SHARE)
  if ('error' in outcome) {
    $.ui.status(`e2e ⚠ ${cap(outcome.error, 80)}`)
    $.ui.toast(`q-e2e: ${outcome.error}`, { timeoutMs: 8000 })
    return void (await clearEdits($, changed))
  }
  let run = outcome.run
  // The gate runs with --retries=0, so a red spec gets one label-independent re-run of its file while
  // the budget lasts: green there means flaky, not red (shadow mode included). A re-run that fails
  // to finish keeps the first run's evidence.
  const redFiles = [...new Set(run.results.filter(isRed).map(r => r.file).filter(Boolean))]
  const left = o.maxStopMs * (1 - TRIAGE_RESERVE) - ((await $.clock.now()) - t0)
  if (redFiles.length > 0 && left > 5000) {
    const again = await runPlaywright($, o, { mode: 'specs', specs: redFiles, why: ['re-run red'] }, cfg, 'stop-gate', left)
    if (!('error' in again)) run = mergeRerun(run, again.run)
  }
  await recordRun($, run)
  const red = run.results.filter(isRed)
  if (run.failed === 0 || red.length === 0) {
    await update($, verdicts, () => ({}))
    await clearEdits($, changed)
    return { run }
  }
  const shadow = o.triage === 'shadow'

  // Triage the first few red specs.
  const key = await jevKeyOf($, o)
  const secrets = key ? [key] : []
  const turnDiff = await gitDiff($, changed, secrets)
  const found: Record<string, TriageVerdict> = {}
  const drift: { spec: SpecResult; errorContext?: string }[] = []
  const envAuth: SpecResult[] = []
  for (const spec of red.slice(0, MAX_TRIAGED)) {
    const errorContext = await errorContextOf($, spec, secrets)
    let v = await triage($, o, spec, errorContext, turnDiff)
    if (shadow) {
      // Shadow: the label is logged and shown, never acted on (no retry, no healer, no pass).
      found[specKey(spec)] = v
      continue
    }
    if (v.label === 'flaky') {
      // Flaky: one retry at layer 0 while the budget lasts; red again counts as an app bug.
      const left = o.maxStopMs - ((await $.clock.now()) - t0)
      const again = left > 5000 && spec.file ? await runPlaywright($, o, { mode: 'specs', specs: [spec.file], why: ['flaky retry'] }, cfg, 'stop-gate', left) : undefined
      const stillRed = !again || 'error' in again || again.run.failed > 0
      if (!stillRed) {
        found[specKey(spec)] = v
        continue
      }
      v = { ...v, label: 'app-bug', probabilities: { ...v.probabilities } }
    }
    found[specKey(spec)] = v
    if (v.label === 'test-drift' && spec.file) drift.push({ spec, ...(errorContext ? { errorContext } : {}) })
    else if (v.label === 'env-auth') envAuth.push(spec)
  }
  await update($, verdicts, () => found as Record<string, E2eVerdict>)
  $.ui.invalidate('ui.render')

  // blockReason lists app bugs, fallbacks and red specs past the triage cap (no verdict); empty: no block.
  // In shadow no verdict counts, so every red spec blocks.
  const reason = blockReason(run, shadow ? {} : found)
  if (reason) {
    if (!call.fallback) await update($, blocks, n => n + 1)
    return { block: reason, run, changed }
  }
  if (envAuth.length > 0) {
    const what = envAuth.map(specKey).join(', ')
    await $.ui.notify(`e2e environment problem (server down or login expired): ${what}`, { title: 'q-e2e' }).catch(() => undefined)
  }
  if (drift.length > 0) {
    const first = drift[0]!
    const why = await spawnHealer($, first.spec, testDir, first.errorContext).catch(err => errMsg(err))
    if (why) $.ui.toast(`q-e2e: healer not started (${why})`, { timeoutMs: 8000 })
  }
  await clearEdits($, changed)
  return { run }
}

/** What ran, in words: "1 spec", "the @smoke specs", "the whole suite". */
const ranWhat = (run: RunEvidence) => (run.specs.length > 0 ? `${run.specs.length} spec(s) (${run.specs.join(', ')})` : 'the whole suite or the smoke tag')

/** The block text, led by a contradiction line when the answer claimed success. */
function followUpText(block: string, run: RunEvidence | undefined, answer: string): string {
  if (!run || !claimsSuccess(answer)) return block
  // "the tests pass" only when a sentence that itself claims success talks about passing; "Done. I ran no tests" is "it is done".
  const testsClaim = answer.split(/(?<=[.!?])\s+|\n+/).some(x => /\b(?:pass(?:es|ed|ing)?|green)\b/i.test(x) && claimsSuccess(x))
  const said = testsClaim ? 'the tests pass' : 'it is done'
  return `You said ${said}, but q-e2e ran ${ranWhat(run)} after your changes: ${summarize(run)}.\n\n${block}`
}

/** One line for the prompt box's suggestion: the red specs, not the whole block text. */
const suggestionOf = (run: RunEvidence | undefined) =>
  `Fix the failing e2e spec(s): ${(run?.results.filter(isRed) ?? []).slice(0, 3).map(r => `${specKey(r)} ${r.title}`).join('; ') || 'see /q-e2e status'}`

/**
 * The fallback when classic.Stop did not run for the main turn: the same gate, then by `followUp`
 * a follow-up prompt (auto), a suggestion in the prompt box (suggest), or a note the model reads
 * with the next prompt (off, or when the others are refused).
 */
async function fallbackGate($: EngineInterface, o: Opts, answer: string) {
  const g = await gate($, o, { stopHookActive: false, fallback: true })
  if (!g?.block) return
  const text = followUpText(g.block, g.run, answer)
  const count = await read($, followUps)
  if (count >= MAX_FOLLOW_UPS) {
    $.ui.toast(`q-e2e: still red after ${MAX_FOLLOW_UPS} follow-ups; not continuing`, { timeoutMs: 8000 })
    // Like the Stop path's block cap: give up on these edits, so the next turn gates only new ones.
    await clearEdits($, g.changed)
    await note($, text)
    return
  }
  if (o.followUp === 'auto') {
    // Counted before the submit: our own prompt passes our prompt.submit hook too, and must not reset it.
    await update($, followUps, n => n + 1)
    let refused: string
    try {
      const r = await $.prompt.submit({ text })
      if (!r.drop) return
      refused = r.drop
    } catch (err) {
      refused = errMsg(err)
    }
    await update($, followUps, n => Math.max(0, n - 1))
    $.ui.toast(`q-e2e: follow-up not submitted (${cap(refused, 80)})`, { timeoutMs: 8000 })
  }
  if (o.followUp !== 'off') {
    const shown = await $.prompt.suggest({ text: suggestionOf(g.run) }).catch(() => ({ isShown: false }))
    if (!shown.isShown) {
      const filled = await $.prompt.fill({ text: suggestionOf(g.run) }).catch(() => ({ isFilled: false }))
      if (!filled.isFilled) $.ui.toast(`q-e2e: ${cap(g.block.split('\n')[0] ?? '', 120)}`, { timeoutMs: 8000 })
    }
  } else $.ui.toast(`q-e2e: ${cap(g.block.split('\n')[0] ?? '', 120)}`, { timeoutMs: 8000 })
  // Whatever the person sends next, the model reads the failures with it.
  await note($, text)
}

// ---- /q-e2e ----------------------------------------------------------------------------------------

async function statusJson($: EngineInterface, o: Opts) {
  const run = await read($, lastRun)
  const v = await read($, verdicts)
  const heal = await read($, healing)
  const now = await $.clock.now()
  return {
    mode: await effectiveMode($, o),
    pendingEdits: (await read($, edits)).length,
    lastRun: run
      ? {
          summary: summarize(run as RunEvidence),
          ageSeconds: Math.round((now - run.startedAt) / 1000),
          commit: run.commit ?? null,
          reason: run.reason,
          specs: run.specs.length > 0 ? run.specs : 'whole suite',
          passed: run.passed,
          failed: run.failed,
          flaky: run.flaky,
          skipped: run.skipped,
          durationMs: run.durationMs,
          exitCode: run.exitCode,
          triageMode: o.triage,
          failures: run.results.filter(isRed).map(r => ({
            spec: specKey(r),
            title: r.title,
            status: r.status,
            error: r.error ? cap(r.error, 500) : null,
            triage: v[specKey(r)] ? { label: v[specKey(r)]!.label, p: v[specKey(r)]!.p, source: v[specKey(r)]!.source, applied: o.triage === 'on' } : null,
          })),
        }
      : null,
    healing: heal ? { spec: `${heal.spec}:${heal.line}`, status: heal.status, reasons: heal.reasons } : null,
    note: run ? 'Evidence from a real Playwright run; quote it instead of claiming tests pass.' : 'No e2e run recorded yet. Run /q-e2e run or finish a turn with UI edits.',
  }
}

type Decision = { spec: string; label: string; p: number; source: string; latencyMs: number | null; mode?: string; gatedAs?: string; at: number }

const tally = (xs: string[]) =>
  Object.entries(xs.reduce<Record<string, number>>((m, x) => ((m[x] = (m[x] ?? 0) + 1), m), {}))
    .sort((a, b) => b[1] - a[1])
    .map(([k, n]) => `${k} ${n}`)
    .join(', ')

/**
 * The triage log in a few lines. "Agrees with the gate" counts the decisions whose label is the
 * one the gate acted on (app-bug in shadow): the rest are where `triage: on` would have gated differently.
 */
async function decisionsSummary($: EngineInterface, detail: boolean): Promise<string> {
  let list: Decision[] = []
  try {
    const raw = await $.store.get('decisions')
    if (Array.isArray(raw)) list = raw as Decision[]
  } catch {
    // An unreadable log reads as empty.
  }
  if (list.length === 0) return 'triage log: no decisions yet'
  const agree = list.filter(d => d.label === (d.gatedAs ?? 'app-bug')).length
  const latencies = list.map(d => d.latencyMs).filter((n): n is number => typeof n === 'number')
  const meanP = list.reduce((a, d) => a + d.p, 0) / list.length
  const lines = [
    `triage log: ${list.length} decision(s) · ${tally(list.map(d => d.mode ?? 'on'))}`,
    `  labels: ${tally(list.map(d => d.label))} · sources: ${tally(list.map(d => d.source))}`,
    `  agrees with the gate: ${agree}/${list.length} (${Math.round((agree / list.length) * 100)}%) · mean p ${meanP.toFixed(2)}${latencies.length ? ` · mean latency ${Math.round(latencies.reduce((a, n) => a + n, 0) / latencies.length)} ms` : ''}`,
  ]
  if (detail) for (const d of list.slice(-10)) lines.push(`  ${d.spec} · ${d.source}: ${d.label} ${d.p.toFixed(2)} → gated ${d.gatedAs ?? 'app-bug'}${d.mode ? ` (${d.mode})` : ''}`)
  return lines.join('\n')
}

async function describeStatus($: EngineInterface, o: Opts): Promise<string> {
  const s = await statusJson($, o)
  const lines = [`mode: ${s.mode} · pending edits: ${s.pendingEdits}`]
  if (s.lastRun) {
    lines.push(`last run: ${s.lastRun.summary} · ${s.lastRun.reason} · ${s.lastRun.ageSeconds}s ago${s.lastRun.commit ? ` · ${s.lastRun.commit}` : ''}`)
    for (const f of s.lastRun.failures) lines.push(`  ✗ ${f.spec} ${f.title}${f.triage ? ` · ${f.triage.label} p=${f.triage.p.toFixed(2)} (${f.triage.source})` : ''}`)
  } else lines.push('last run: none')
  if (s.healing) lines.push(`healer: ${s.healing.spec} · ${s.healing.status}${s.healing.reasons.length ? ` · ${s.healing.reasons.join('; ')}` : ''}`)
  lines.push(`triage: ${o.triage} · follow-up: ${o.followUp}`)
  lines.push(await decisionsSummary($, false))
  return lines.join('\n')
}

async function commandRun($: EngineInterface, o: Opts, all: boolean): Promise<{ text: string; exitCode?: number }> {
  if (!(await playwrightConfig($))) return { text: 'q-e2e: no playwright.config.ts at the project root, so there is nothing to run. Run /q-e2e init to scaffold one.', exitCode: 1 }
  const cfg = await loadConfig($)
  let sel: ImpactSelection
  if (all) sel = { mode: 'all', specs: [], why: ['/q-e2e run all'] }
  else {
    const specs = await listSpecs($, testDirOf(cfg))
    sel = selectSpecs(await read($, edits), specs, await readSources($, specs), cfg)
    if (sel.mode === 'none') return { text: 'No UI-relevant edits pending, so no affected specs. Use /q-e2e run all for the whole suite.' }
  }
  $.ui.status(`e2e running ${sel.mode === 'specs' ? `${sel.specs.length} spec(s)` : sel.mode}…`)
  const outcome = await runPlaywright($, o, sel, cfg, all ? 'full-suite' : 'command', COMMAND_TIMEOUT_MS)
  if ('error' in outcome) {
    $.ui.status(`e2e ⚠ ${cap(outcome.error, 80)}`)
    return { text: `q-e2e: ${outcome.error}`, exitCode: 1 }
  }
  await recordRun($, outcome.run)
  const failures = outcome.run.results.filter(isRed).map(r => `  ✗ ${specKey(r)} ${r.title}${r.error ? `\n    ${cap(r.error.split('\n')[0] ?? '', 200)}` : ''}`)
  return { text: [summarize(outcome.run), ...sel.why.map(w => `  · ${w}`), ...failures].join('\n'), exitCode: outcome.run.failed > 0 ? 1 : 0 }
}

async function commandHeal($: EngineInterface, target: string): Promise<{ text: string; exitCode?: number }> {
  if (!target) return { text: 'Usage: /q-e2e heal <spec>', exitCode: 2 }
  const cfg = await loadConfig($)
  const run = await read($, lastRun)
  const hit = run?.results.find(r => isRed(r) && (r.file === target || r.file.endsWith(`/${target}`) || specKey(r) === target))
  const spec: SpecResult = hit ?? { file: target.replace(/:\d+$/, ''), line: Number(target.match(/:(\d+)$/)?.[1] ?? 0), title: '(no failure recorded)', status: 'failed', durationMs: 0, retries: 0 }
  const errorContext = hit ? await errorContextOf($, hit, []) : undefined
  const why = await spawnHealer($, spec, testDirOf(cfg), errorContext)
  return why ? { text: `q-e2e: healer not started: ${why}`, exitCode: 1 } : { text: `Healer started on ${spec.file}. q-e2e checks its diff and re-runs the spec when it finishes.` }
}

async function commandExplore($: EngineInterface, flow: string): Promise<{ text: string; exitCode?: number }> {
  if (!flow) return { text: 'Usage: /q-e2e explore "<flow>"', exitCode: 2 }
  const cfg = await loadConfig($)
  const testDir = testDirOf(cfg)
  const r = await $.agent.spawn({
    prompt: [
      `Explore this user flow in the running app and write a Playwright spec for it: ${flow}`,
      `Start from ${testDir}/seed.spec.ts if it exists (it is logged in through storageState).`,
      `Write the new spec under ${testDir}/ with getByRole locators and real assertions (toMatchAriaSnapshot where it fits).`,
      'Stay on the app\'s own origin. Never type credentials; never edit app code.',
    ].join('\n'),
    description: `explore ${cap(flow, 40)}`,
    subagentType: EXPLORER,
    model: 'haiku',
    name: 'q-e2e-explorer',
  })
  if (r.deny || !r.agentId) return { text: `q-e2e: explorer not started: ${r.deny ?? 'no agent id'}`, exitCode: 1 }
  return { text: `Explorer started on "${flow}". Its spec lands under ${testDir}/.` }
}

/** Maps a template's path to where it goes in the project: templates/ mirrors the target tree, dotfiles ship without the dot. */
const templateDest = (rel: string) =>
  rel
    .split('/')
    .map(part => (part === 'env.e2e' ? '.env.e2e' : part === 'gitignore' ? '.gitignore' : part))
    .join('/')

/** Templates the person merges by hand (shown, never copied): the folder's README and every `*.snippet*`. */
const isManualTemplate = (rel: string) => rel === 'README.md' || (rel.split('/').pop() ?? '').includes('.snippet')

async function commandInit($: EngineInterface): Promise<{ text: string; exitCode?: number }> {
  const src = `${$.plugin.root}/templates`
  if (!(await $.fs.exists(src))) return { text: 'q-e2e: no templates folder in the plugin.', exitCode: 1 }
  const root = await $.session.root()
  const files: string[] = []
  const queue = ['']
  while (queue.length > 0 && files.length < 50) {
    const dir = queue.shift()!
    for (const entry of await $.fs.list(dir ? `${src}/${dir}` : src)) {
      const rel = dir ? `${dir}/${entry.name}` : entry.name
      if (entry.kind === 'dir') queue.push(rel)
      else if (entry.kind === 'file') files.push(rel)
    }
  }
  const plan: { from: string; to: string; exists: boolean }[] = []
  const manual: string[] = []
  for (const rel of files.sort()) {
    if (isManualTemplate(rel)) {
      if (rel === 'README.md') continue
      const text = await $.fs.read(`${src}/${rel}`).catch(() => '')
      manual.push(`--- ${rel} (merge by hand) ---\n${cap(text.trim(), 1500)}`)
      continue
    }
    const to = templateDest(rel)
    plan.push({ from: rel, to, exists: await $.fs.exists(`${root}/${to}`) })
  }
  const fresh = plan.filter(p => !p.exists)
  const listing = plan.map(p => `  ${p.exists ? '· keep' : '+ write'} ${p.to}`).join('\n')
  const snippets = manual.length ? `\n\n${manual.join('\n\n')}` : ''
  if (fresh.length === 0) return { text: `q-e2e init: every file exists already; nothing written.\n${listing}${snippets}` }
  let answer: string
  try {
    answer = await $.ui.ask(`Write ${fresh.length} q-e2e file(s)? Existing files are kept.\n${listing}${snippets}`, ['Write', 'Cancel'])
  } catch {
    return { text: `q-e2e init: not confirmed; nothing written.\n${listing}${snippets}` }
  }
  if (answer !== 'Write') return { text: `q-e2e init cancelled; nothing written.\n${listing}${snippets}` }
  const written: string[] = []
  const failed: string[] = []
  for (const p of fresh) {
    try {
      // Checked again right before writing: never overwrite.
      if (await $.fs.exists(`${root}/${p.to}`)) continue
      await $.fs.write(`${root}/${p.to}`, await $.fs.read(`${src}/${p.from}`))
      written.push(p.to)
    } catch (err) {
      failed.push(`${p.to} (${errMsg(err)})`)
    }
  }
  return {
    text: [
      `q-e2e init wrote ${written.length} file(s):`,
      ...written.map(w => `  + ${w}`),
      ...(failed.length ? ['Not written:', ...failed.map(f => `  ✗ ${f}`)] : []),
      manual.length ? `Merge these by hand (.gitignore, .claude/settings.json):${snippets}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
    ...(failed.length ? { exitCode: 1 } : {}),
  }
}

// ---- register --------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const o = optsOf(options)
  /** A fallback run in flight: a second one, or /q-e2e run, must not share the report file. */
  let busy = false

  on('session.start', async ($, e, next) => {
    await update($, interactive, () => e.isInteractive !== false).catch(() => undefined)
    try {
      const saved = await $.store.get('lastRun')
      if (saved && typeof saved === 'object') {
        await update($, lastRun, () => saved as E2eRun)
        $.ui.status(`e2e ${summarize(saved as RunEvidence)}`)
      }
      const mode = await $.store.get('mode')
      if (mode === 'off' || mode === 'affected' || mode === 'all') await update($, modeOverride, () => mode)
    } catch {
      // Defaults stand when the store cannot be read.
    }
    await $.command.register({
      name: 'q-e2e',
      description: 'Run, triage and heal the Playwright specs a change affects',
      argumentHint: 'run [all] | status | decisions | explore "<flow>" | heal <spec> | init | mode off|affected|all',
    })
    await $.tool.register({
      name: TOOL,
      description:
        'The last real end-to-end (Playwright) run of this project: pass/fail per spec, triage labels, commit, age. Call it before saying UI tests pass, and quote it.',
      inputSchema: { type: 'object', properties: {} },
    })
    return next(e)
  })

  // ---- the model's evidence tool -------------------------------------------------------------------

  // The host takes a string or a content array as a tool result, never an object.
  on('tool.call', { tool: TOOL_RE }, async $ => ({ result: JSON.stringify(await statusJson($, o)) })).catch(() => ({
    result: JSON.stringify({ error: 'q-e2e could not read its evidence store' }),
  }))

  // ---- edit recorder -------------------------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!EDIT_TOOLS.has(e.tool) || r.deny || r.isError) return r
    const raw = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof raw !== 'string' || !raw) return r
    const path = await relPath($, raw)
    if (e.agentId) {
      // A subagent's edit: the healer's are kept for its diff guard, whatever the path (one outside the
      // project is kept as given, and rejected there); none count as the main turn's.
      const kept = path ?? raw
      const heal = await read($, healing)
      if (heal && heal.agentId === e.agentId && heal.status === 'running') {
        await update($, healing, cur => (cur && cur.agentId === e.agentId && !cur.files.includes(kept) ? { ...cur, files: [...cur.files, kept] } : cur))
      }
      return r
    }
    if (!path) return r
    await update($, edits, list => (list.includes(path) ? list : [...list, path]))
    return r
  }).catch(($, e, next) => next(e))

  // ---- the stop gate -------------------------------------------------------------------------------

  on('classic.Stop', async ($, e, next) => {
    // Marked first: the turn.complete fallback skips a turn whose Stop reached this hook, gated or not.
    if (!e.agent_id) {
      const turnId = await read($, currentTurn)
      const at = await $.clock.now()
      await update($, stopSeen, () => ({ turnId, at }))
    }
    const r = await next(e)
    // A subagent's stop, or another hook already blocking: not ours to gate.
    if (e.agent_id || r.block) return r
    const g = await gate($, o, { stopHookActive: e.stop_hook_active === true })
    return g?.block ? { ...r, block: followUpText(g.block, g.run, e.last_assistant_message ?? '') } : r
  }).catch(($, e, next) => {
    $.ui.toast('q-e2e: the stop gate failed; letting the turn end', { timeoutMs: 8000 })
    return next(e)
  })

  // ---- the fallback gate: turn tracking and the follow-up cap ---------------------------------------

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await update($, currentTurn, () => e.turnId)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // The person's own prompt resets the cap; our follow-ups (origin plugin) do not.
    if (USER_ORIGINS.has(e.origin?.kind)) await update($, followUps, () => 0)
    return next(e)
  }).catch(($, e, next) => next(e))

  // ---- turn end: the fallback gate (main loop) and the healer's end (subagent) ---------------------

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (!e.agentId) {
      const seen = await read($, stopSeen)
      await update($, stopSeen, () => null)
      if (e.isAborted || e.reason !== 'answer') return r
      const now = await $.clock.now()
      // By turn id when turn.start gave one, else by time: a Stop within this turn's span.
      const handled = !!seen && (seen.turnId ? seen.turnId === e.turnId : now - seen.at <= e.durationMs + 1000)
      if (handled || busy) return r
      busy = true
      const job = fallbackGate($, o, e.answer)
        .catch(err => $.ui.toast(`q-e2e: the fallback gate failed: ${errMsg(err)}`, { timeoutMs: 8000 }))
        .finally(() => {
          busy = false
        })
      // Detached under a person, so the turn ends at once; awaited in -p / SDK runs, which exit after the turn.
      if (await read($, interactive)) void job
      else await job
      return r
    }
    const heal = await read($, healing)
    if (!heal || heal.agentId !== e.agentId || heal.status !== 'running') return r
    // Claim it before the detached verify, so a second turn of the healer does not verify twice.
    await update($, healing, cur => (cur && cur.agentId === heal.agentId ? { ...cur, status: 'verifying' as const } : cur))
    void verifyHeal($, o, heal).catch(async err => {
      await update($, healing, cur => (cur && cur.agentId === heal.agentId ? { ...cur, status: 'failed' as const, reasons: [errMsg(err)] } : cur)).catch(() => undefined)
      $.ui.toast(`q-e2e: heal check failed: ${errMsg(err)}`, { timeoutMs: 8000 })
    })
    return r
  }).catch(($, e, next) => next(e))

  // ---- /q-e2e --------------------------------------------------------------------------------------

  on('command.run', { command: 'q-e2e' }, async ($, e) => {
    const args = e.args.trim()
    const [sub = 'status', ...rest] = args.split(/\s+/).filter(Boolean)
    const tail = args.slice(sub.length).trim()
    switch (sub) {
      case 'run':
        if (busy) return { text: 'q-e2e: a gate run is in progress; try again when it ends.', exitCode: 1 }
        return commandRun($, o, rest[0] === 'all')
      case 'decisions':
        return { text: await decisionsSummary($, true) }
      case 'status':
        return { text: await describeStatus($, o) }
      case 'explore':
        return commandExplore($, tail.replace(/^["']|["']$/g, ''))
      case 'heal':
        return commandHeal($, tail)
      case 'init':
        return commandInit($)
      case 'mode': {
        const m = rest[0]
        if (m !== 'off' && m !== 'affected' && m !== 'all') return { text: `mode is ${await effectiveMode($, o)}. Usage: /q-e2e mode off|affected|all`, exitCode: 2 }
        await update($, modeOverride, () => m)
        await $.store.set('mode', m).catch(() => undefined)
        return { text: `q-e2e mode ${m}.` }
      }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  })

  // ---- band above the prompt: only while red or healing --------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const run = await read($, lastRun)
    const heal = await read($, healing)
    const isHealing = !!heal && (heal.status === 'running' || heal.status === 'verifying')
    const isRedRun = !!run && run.failed > 0
    if (!isHealing && !isRedRun) return next(e)
    const v = await read($, verdicts)
    const firstRed = run?.results.find(isRed)
    const verdict = firstRed ? v[specKey(firstRed)] : undefined
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        {isRedRun && run && (
          <Text key="red" wrap="truncate" color={RED_HEX}>
            {`e2e ${summarize(run as RunEvidence)}${verdict ? (o.triage === 'shadow' ? ` · (shadow) ${verdict.source}: ${verdict.label} ${verdict.p.toFixed(2)}` : ` · ${verdict.label} p=${verdict.p.toFixed(2)}`) : ''}`}
          </Text>
        )}
        {isHealing && heal && (
          <Text key="healing" wrap="truncate" color={WARN_HEX}>
            {`${heal.status === 'verifying' ? 'verifying' : 'healing'} ${heal.spec}`}
          </Text>
        )}
      </Box>
    )
  })
}
