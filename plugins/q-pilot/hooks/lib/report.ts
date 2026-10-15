// Turns runner results into gate decisions and text. Pure.

import type { Action, PilotFlow, PilotOutcome, RunnerResult, Trust } from './contract'

/** The runner enforces a hard deadline of its --budget-ms plus this much. */
export const RUNNER_GRACE_MS = 5000
/** The runner's share of the stop budget. */
const RUN_SHARE = 0.8

/**
 * The runner's --budget-ms and the process timeout for a stop budget. The timeout always exceeds the
 * runner's own hard deadline (budget + grace), and for a usual budget the deadline stays inside it.
 */
export function stopBudget(maxStopMs: number): { budgetMs: number; timeoutMs: number } {
  const budgetMs = Math.max(1000, Math.min(Math.floor(maxStopMs * RUN_SHARE), maxStopMs - RUNNER_GRACE_MS - 2000))
  return { budgetMs, timeoutMs: Math.max(maxStopMs, budgetMs + RUNNER_GRACE_MS + 2000) }
}

/** Outcomes that leave a band up: the flow is red or its trace is stale. Shadow also blocks on flaky. */
const BAD = new Set<PilotOutcome>(['app-bug', 'blocked', 'error', 'drift', 'env'])

export const isBad = (f: Pick<PilotFlow, 'outcome' | 'accepted'>, trust: Trust = 'on') => (BAD.has(f.outcome) || (trust === 'shadow' && f.outcome === 'flaky')) && !f.accepted

const cap = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}…` : text)

/** The runner prints exactly one result line last; progress goes to stderr, but tolerate stray lines before it. */
export function parseResult(stdout: string): RunnerResult | undefined {
  const lines = stdout.split('\n').map(l => l.trim()).filter(Boolean)
  const last = lines.at(-1)
  if (!last) return undefined
  try {
    const parsed = JSON.parse(last) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && typeof (parsed as RunnerResult).ok === 'boolean') return parsed as RunnerResult
  } catch {
    // Not a result line.
  }
  return undefined
}

/** The last few stderr lines, secrets removed. */
export function stderrTail(stderr: string, secrets: readonly string[] = [], lines = 5): string {
  let text = stderr.trim().split('\n').slice(-lines).join('\n')
  for (const s of secrets) if (s) text = text.split(s).join('[redacted]')
  return cap(text, 800)
}

/** What the gate does with one flow, by outcome and trust. `touched`: the turn's diff mentions the drifted element. */
export function actionFor(f: Pick<PilotFlow, 'outcome' | 'recorded'>, trust: Trust, touched: boolean): Action {
  switch (f.outcome) {
    case 'pass':
      return f.recorded ? 'note' : 'ok'
    case 'flaky':
      return trust === 'on' ? 'ok' : 'block'
    case 'drift':
      return trust === 'on' && touched ? 'accept' : 'block'
    case 'env':
      return trust === 'on' ? 'notify' : 'block'
    case 'untraced':
    case 'needs-verify':
    case 'skipped':
      return 'note'
    default:
      return 'block'
  }
}

type El = { op?: string; role?: string; name?: string }
export const describeEl = (e: El | undefined) => (e ? [e.op, e.role, e.name === undefined ? undefined : `"${e.name}"`].filter(Boolean).join(' ') : '(unknown)')

/** The names a drifted flow's diff must mention: per diverged step, the old and the new element name. */
export const driftNames = (f: Pick<PilotFlow, 'diverged'>): string[][] =>
  (f.diverged ?? []).map(d => [d.was?.name, d.now?.name].filter((n): n is string => typeof n === 'string' && n.length >= 2))

/**
 * Deterministic `touched`: every diverged step has its old or its new element name in the diff.
 * No diverged step, or a step without a usable name, is never touched.
 */
export function isTouched(f: Pick<PilotFlow, 'diverged'>, diff: string): boolean {
  const names = driftNames(f)
  return names.length > 0 && names.every(pair => pair.some(n => diff.includes(n)))
}

const show = (v: unknown) => (v === null || v === undefined ? 'not found' : typeof v === 'string' ? JSON.stringify(v) : JSON.stringify(v))

/** The lines that say why one flow blocks. */
export function flowBlock(f: PilotFlow, trust: Trust, touched: boolean): string[] {
  const out: string[] = []
  const last = f.steps.length > 0 ? `after step ${f.steps.length} (${describeEl(f.steps.at(-1))})` : 'before its first step'
  switch (f.outcome) {
    case 'drift': {
      out.push(`- ${f.id}: drift. The recorded steps no longer match the page, so the runner re-picked them; verify passed.`)
      for (const d of f.diverged) out.push(`    step ${d.step}: ${describeEl(d.was)} → ${describeEl(d.now)}${d.p === undefined ? '' : ` (p ${d.p})`}`)
      out.push(
        trust === 'on' && !touched
          ? "    Not accepted automatically: this turn's diff mentions neither element name."
          : '    Tell the user. Do not accept it yourself.',
      )
      out.push(`    If the UI change is intended, the user accepts it with /q-pilot accept ${f.id}; otherwise restore the old element.`)
      break
    }
    case 'app-bug':
      out.push(`- ${f.id}: app-bug. verify failed, and failed again on a re-run in a fresh browser (${last}).`)
      for (const v of f.verifyFails) out.push(`    ✗ ${JSON.stringify(v.check)} → found ${show(v.actual)}`)
      break
    case 'flaky':
      out.push(`- ${f.id}: flaky. verify failed once and passed on the re-run; trust is shadow, so it blocks.`)
      for (const v of f.verifyFails) out.push(`    ✗ ${JSON.stringify(v.check)} → found ${show(v.actual)}`)
      break
    case 'blocked':
      out.push(`- ${f.id}: blocked ${last}: ${f.error ?? 'no reason given'}`)
      for (const d of f.diverged) out.push(`    step ${d.step}: ${describeEl(d.was)} was not found`)
      break
    case 'env':
      out.push(`- ${f.id}: env problem (server down, login page, or a missing $env: fixture): ${f.error ?? 'no reason given'}`)
      break
    default:
      out.push(`- ${f.id}: ${f.outcome}${f.error ? `: ${f.error}` : ''}`)
  }
  if (f.screenshot) out.push(`    screenshot: ${f.screenshot}`)
  return out
}

/** The block text: a header and one entry per blocking flow. */
export function blockText(runId: string | undefined, entries: string[][]): string {
  const n = entries.length
  return [
    `q-pilot: ${n} flow${n === 1 ? '' : 's'} need${n === 1 ? 's' : ''} attention after your changes${runId ? ` (run ${runId})` : ''}.`,
    ...entries.flat(),
    'Fix the app code (never a flow\'s verify block), then finish your turn again.',
  ].join('\n')
}

/** One line for the status line and the band. */
export function summarize(flows: readonly PilotFlow[], trust: Trust = 'on'): string {
  const bad = flows.filter(f => isBad(f, trust))
  const good = flows.length - bad.length
  if (bad.length === 0) return `✓ ${good}/${flows.length} flows`
  return `${bad.some(f => f.outcome !== 'drift') ? '✗' : '≈'} ${bad.length} of ${flows.length} flows: ${bad.slice(0, 3).map(f => `${f.id} ${f.outcome}`).join(', ')}`
}

/** One line per flow for /q-pilot run and record. */
export function flowLine(f: PilotFlow & { suggestedVerify?: unknown }, trust: Trust = 'on'): string {
  const extra =
    f.outcome === 'drift'
      ? ` · ${f.diverged.map(d => `step ${d.step}: ${describeEl(d.was)} → ${describeEl(d.now)}`).join('; ')}`
      : f.verifyFails.length > 0
        ? ` · ${f.verifyFails.map(v => `${JSON.stringify(v.check)} found ${show(v.actual)}`).join('; ')}`
        : f.error
          ? ` · ${f.error}`
          : ''
  return `  ${isBad(f, trust) ? '✗' : '✓'} ${f.id}: ${f.outcome}${f.recorded ? ' (recorded)' : ''} ${f.durationMs} ms${extra}`
}
