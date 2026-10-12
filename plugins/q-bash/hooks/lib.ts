// Pure helpers shared by the q-bash hooks. No `$` access here, so everything is easy to test.

import type { GuardRule, HistoryEntry, BashSettings } from '../types'

export const DEFAULT_SETTINGS: BashSettings = {
  previewLines: 4,
  maxExpandedLines: 400,
  slowMs: 10_000,
  guard: true,
  maskSecrets: true,
  unfoldGroups: true,
  commandBg: '#323334',
  outputBg: '#22282e',
  guardRules: [],
}

/** Built-in destructive patterns. User rules from `/q-bash guard add` are appended. */
export const BUILTIN_RULES: GuardRule[] = [
  { pattern: String.raw`\bgit\s+push\b[^|;&]*\s(--force(?![-\w])|-f\b)`, why: 'force-push rewrites remote history' },
  { pattern: String.raw`\bgit\s+reset\s+[^|;&]*--hard\b`, why: 'git reset --hard discards local changes' },
  { pattern: String.raw`\bgit\s+clean\s+-[a-zA-Z]*f`, why: 'git clean -f deletes untracked files' },
  { pattern: String.raw`\bgit\s+checkout\s+(--\s+)?\.(\s|$)`, why: 'git checkout . discards local changes' },
  { pattern: String.raw`\bgit\s+branch\s+-D\b`, why: 'git branch -D force-deletes a branch' },
  { pattern: String.raw`\brm\s+-[a-zA-Z]*r[a-zA-Z]*\s+(-[a-zA-Z]+\s+)*(\/|~|\$HOME|\*)(\s|$|\/)`, why: 'recursive delete of /, ~ or *' },
  { pattern: String.raw`\b(drop\s+(table|database|schema)|truncate\s+table)\b`, why: 'drops or truncates data' },
]

export type Rule = GuardRule & { re: RegExp }

/** Compiles rules, skipping any pattern that is not a valid regex. */
export const compileRules = (rules: GuardRule[]): Rule[] =>
  rules.flatMap(r => {
    try {
      return [{ ...r, re: new RegExp(r.pattern, 'i') }]
    } catch {
      return []
    }
  })

export const matchRule = (command: string, rules: Rule[]) => rules.find(r => r.re.test(command))

// ANSI CSI / OSC escape sequences.
const ANSI = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(\x07|\x1b\\)|\x1b[@-Z\\-_]/g
export const stripAnsi = (text: string) => text.replace(ANSI, '')

/** Terminal cells a code point takes: 2 for wide East Asian and emoji, 0 for combining marks. */
const cellWidth = (cp: number) => {
  if (cp === 0 || (cp >= 0x300 && cp <= 0x36f) || (cp >= 0x200b && cp <= 0x200f) || cp === 0xfe0f) return 0
  if (
    (cp >= 0x1100 && cp <= 0x115f) ||
    (cp >= 0x2e80 && cp <= 0xa4cf) ||
    (cp >= 0xac00 && cp <= 0xd7a3) ||
    (cp >= 0xf900 && cp <= 0xfaff) ||
    (cp >= 0xfe30 && cp <= 0xfe4f) ||
    (cp >= 0xff00 && cp <= 0xff60) ||
    (cp >= 0xffe0 && cp <= 0xffe6) ||
    (cp >= 0x1f300 && cp <= 0x1faff) ||
    (cp >= 0x20000 && cp <= 0x3fffd)
  )
    return 2
  return 1
}

export const displayWidth = (text: string) => {
  let w = 0
  for (const ch of text) w += cellWidth(ch.codePointAt(0) ?? 0)
  return w
}

/** Cuts a line to `width` terminal cells, ending with `…` when cut. */
export const clip = (line: string, width: number) => {
  if (displayWidth(line) <= width) return line
  const room = Math.max(1, width - 1)
  let w = 0
  let out = ''
  for (const ch of line) {
    const cw = cellWidth(ch.codePointAt(0) ?? 0)
    if (w + cw > room) break
    out += ch
    w += cw
  }
  return out + '…'
}

/** Splits output into lines, dropping trailing blank lines. */
export const lines = (text: string | undefined) => {
  const trimmed = stripAnsi(text ?? '').replace(/\s+$/, '')
  return trimmed === '' ? [] : trimmed.split('\n')
}

export type Line = { t: string; err: boolean }

/**
 * Collapsed preview: the last `n` lines. When both streams have output, stderr
 * gets at most half the room so warnings cannot push the result out of view.
 */
export const previewTail = (stdout: string[], stderr: string[], n: number): Line[] => {
  const errRoom = stdout.length === 0 ? n : Math.min(stderr.length, Math.ceil(n / 2))
  const outRoom = n - errRoom
  return [
    ...stdout.slice(stdout.length - Math.min(outRoom, stdout.length)).map(t => ({ t, err: false })),
    ...stderr.slice(stderr.length - Math.min(errRoom, stderr.length)).map(t => ({ t, err: true })),
  ]
}

/** Expanded view: everything up to `max`, else the head and the tail around a gap. */
export const headTail = (all: Line[], max: number): { head: Line[]; tail: Line[]; gap: number } => {
  if (all.length <= max) return { head: all, tail: [], gap: 0 }
  const half = Math.floor(max / 2)
  return { head: all.slice(0, half), tail: all.slice(all.length - (max - half)), gap: all.length - max }
}

// Token shapes worth hiding on a shared screen. Display-only: the model's copy is untouched.
const SECRETS: RegExp[] = [
  /\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g,
  /\b(AKIA|ASIA)[A-Z0-9]{16}\b/g,
  /\bsk-[A-Za-z0-9_-]{20,}\b/g,
  /\bxox[abposr]-[A-Za-z0-9-]{10,}\b/g,
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g,
  /\b(npm_[A-Za-z0-9]{30,}|glpat-[A-Za-z0-9_-]{20,})\b/g,
]

export const maskSecrets = (text: string): { text: string; count: number } => {
  let count = 0
  let out = text
  for (const re of SECRETS)
    out = out.replace(re, m => {
      count += 1
      return m.slice(0, 4) + '•'.repeat(8)
    })
  return { text: out, count }
}

export const formatMs = (ms: number) =>
  ms < 1000 ? `${Math.round(ms)}ms` : ms < 60_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.floor(ms / 60_000)}m${Math.round((ms % 60_000) / 1000)}s`

export const formatBytes = (n: number) =>
  n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`

export type TestSummary = { passed: number; failed: number; skipped: number }

/** Recognises the summary line of vitest, jest, pytest, go test and cargo test. */
export const parseTestSummary = (text: string): TestSummary | undefined => {
  const num = (re: RegExp) => Number(re.exec(text)?.[1] ?? 0)
  // vitest / jest: "Tests:  2 failed, 128 passed, 3 skipped" or "Tests  2 failed | 128 passed (133)"
  const jest = /^\s*Tests:?\s+(.*)$/m.exec(text)?.[1]
  if (jest && /\d+\s+(passed|failed)/.test(jest)) {
    const pick = (w: string) => Number(new RegExp(String.raw`(\d+)\s+${w}`).exec(jest)?.[1] ?? 0)
    return { passed: pick('passed'), failed: pick('failed'), skipped: pick('skipped') + pick('todo') }
  }
  // pytest: "==== 2 failed, 128 passed, 3 skipped in 1.2s ===="
  const py = /^=+ (.*\d+ (passed|failed).*) in [\d.]+s/m.exec(text)?.[1]
  if (py) {
    const pick = (w: string) => Number(new RegExp(String.raw`(\d+) ${w}`).exec(py)?.[1] ?? 0)
    return { passed: pick('passed'), failed: pick('failed') + pick('error'), skipped: pick('skipped') }
  }
  // cargo: "test result: ok. 12 passed; 0 failed; 1 ignored"
  if (/test result: (ok|FAILED)\./.test(text))
    return { passed: num(/(\d+) passed;/), failed: num(/(\d+) failed;/), skipped: num(/(\d+) ignored;/) }
  // go test: count "--- PASS" / "--- FAIL" / "--- SKIP"
  const go = (w: string) => (text.match(new RegExp(String.raw`^\s*--- ${w}:`, 'gm')) ?? []).length
  if (go('PASS') + go('FAIL') > 0) return { passed: go('PASS'), failed: go('FAIL'), skipped: go('SKIP') }
  return undefined
}

/** Builds a unified diff text from the engine's per-file hunks, for a `Code format="diff"`. */
export const toUnifiedDiff = (file: {
  filePath: string
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
}) =>
  [
    `--- a/${file.filePath}`,
    `+++ b/${file.filePath}`,
    ...file.hunks.flatMap(h => [`@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, ...h.lines]),
  ].join('\n')

export const diffStats = (files: { hunks: { lines: string[] }[] }[]) => {
  let added = 0
  let removed = 0
  for (const f of files)
    for (const h of f.hunks)
      for (const l of h.lines) {
        if (l.startsWith('+')) added += 1
        else if (l.startsWith('-')) removed += 1
      }
  return { added, removed }
}

export const summarizeHistory = (list: HistoryEntry[]) => {
  const done = list.filter(h => h.status !== 'running')
  const failed = done.filter(h => h.status === 'failed' || h.status === 'denied').length
  const total = done.reduce((s, h) => s + (h.ms ?? 0), 0)
  const slowest = [...done].sort((a, b) => (b.ms ?? 0) - (a.ms ?? 0)).slice(0, 5)
  const counts = new Map<string, number>()
  for (const h of done) {
    const head = h.command.trim().split(/\s+/).slice(0, 2).join(' ')
    counts.set(head, (counts.get(head) ?? 0) + 1)
  }
  const top = [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 5)
  return { count: done.length, failed, total, slowest, top }
}

// ---- Bash result record -------------------------------------------------------------

export type BashInput = {
  command?: string
  description?: string
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

export type DiffFile = {
  filePath: string
  hunks: { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }[]
  created?: true
  deleted?: true
}

/** The fields of the Bash result record the panel reads. */
export type BashOutput = {
  stdout?: string
  stderr?: string
  interrupted?: boolean
  isImage?: boolean
  backgroundTaskId?: string
  backgroundedByUser?: boolean
  timedOutAfterMs?: number
  returnCodeInterpretation?: string
  persistedOutputPath?: string
  persistedOutputSize?: number
  gitOperation?: {
    commit?: { sha: string; kind: string; branch?: string }
    push?: { branch: string }
    branch?: { ref: string; action: string }
    pr?: { number: number; url?: string; action: string }
  }
  bashEditDiff?: { files: DiffFile[]; moreFiles: number; unavailable?: true; skipped?: true }
}

/** A row's output: the result record, or the error text the model read when the call failed. */
export const readOutput = (output: unknown): BashOutput =>
  typeof output === 'string' ? { stderr: output } : ((output ?? {}) as BashOutput)

/** Header label and border color for a Bash call. */
export const statusOf = (
  p: { isRunning: boolean; isInterrupted: boolean; isErrored: boolean },
  out: BashOutput,
): [string, string] =>
  p.isRunning
    ? ['running…', 'yellow']
    : out.backgroundTaskId
      ? [`⧗ background ${out.backgroundTaskId}`, 'blue']
      : out.timedOutAfterMs
        ? [`⏱ timed out after ${formatMs(out.timedOutAfterMs)}`, 'blue']
        : p.isInterrupted || out.interrupted
          ? ['interrupted', 'yellow']
          : p.isErrored
            ? ['failed', 'red']
            : ['done', 'green']

/** Short labels for git activity the engine detected in the command. */
export const gitBadges = (out: BashOutput) => {
  const g = out.gitOperation
  if (!g) return []
  return [
    g.commit && `⎇ ${g.commit.kind} ${g.commit.sha.slice(0, 7)}${g.commit.branch ? ` on ${g.commit.branch}` : ''}`,
    g.push && `↑ pushed ${g.push.branch}`,
    g.branch && `⑂ ${g.branch.action} ${g.branch.ref}`,
    g.pr && `PR #${g.pr.number} ${g.pr.action}`,
  ].filter((b): b is string => typeof b === 'string')
}

// ---- /q-bash command parsing --------------------------------------------------------

export const USAGE = [
  'Usage: /q-bash <subcommand>',
  '  expand-all | collapse-all     open or close every Bash panel',
  '  history                       open the command history pane',
  '  stats                         summary of the recorded commands',
  '  config [<key> <value>]        show or change a setting',
  '  config reset                  restore the defaults',
  '  guard on | off | list         destructive-command guard',
  '  guard add <regex> [reason]    add a guard rule',
  '  guard remove <n>              remove one of your rules by its number',
].join('\n')

const NUMERIC = ['previewLines', 'maxExpandedLines', 'slowMs'] as const
const BOOLEAN = ['guard', 'maskSecrets', 'unfoldGroups'] as const
const COLOR = ['commandBg', 'outputBg'] as const

/** Parses `/q-bash config <key> <value>` into a settings patch, or an error message. */
export const parseConfig = (key: string, value: string): Partial<BashSettings> | string => {
  if ((NUMERIC as readonly string[]).includes(key)) {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) return `${key} needs a whole number of 1 or more.`
    return { [key]: n }
  }
  if ((BOOLEAN as readonly string[]).includes(key)) {
    if (!['on', 'off', 'true', 'false'].includes(value)) return `${key} needs on or off.`
    return { [key]: value === 'on' || value === 'true' }
  }
  if ((COLOR as readonly string[]).includes(key)) {
    if (!/^(#[0-9a-fA-F]{6}|[a-zA-Z]+)$/.test(value)) return `${key} needs a #rrggbb color or a color name.`
    return { [key]: value }
  }
  return `Unknown setting "${key}". BashSettings: ${[...NUMERIC, ...BOOLEAN, ...COLOR].join(', ')}.`
}

/** Splits `/q-bash guard add` arguments: a pattern, optionally quoted, then a free-text reason. */
export const parseRuleArgs = (text: string): { pattern: string; why: string } => {
  const quoted = /^\s*(['"])(.+?)\1\s*(.*)$/.exec(text)
  if (quoted) return { pattern: quoted[2] ?? '', why: (quoted[3] ?? '').trim() }
  const [pattern = '', ...why] = text.trim().split(/\s+/)
  return { pattern, why: why.join(' ') }
}

export const showSettings = (cfg: BashSettings) =>
  [...NUMERIC, ...BOOLEAN, ...COLOR].map(k => `  ${k.padEnd(18)} ${String(cfg[k])}`).join('\n')
