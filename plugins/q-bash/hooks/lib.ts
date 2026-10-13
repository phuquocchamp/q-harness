// Pure helpers shared by the q-bash hooks. No `$` access here, so everything is easy to test.

import type { BashSettings } from '../types'

export const DEFAULT_SETTINGS: BashSettings = {
  previewLines: 4,
  guard: true,
  unfoldGroups: true,
}

/** Fixed limits; not settings, to keep the surface small. */
export const MAX_EXPANDED_LINES = 400
export const SLOW_MS = 10_000

/** Takes only the current settings from a stored value, so keys left by older versions are ignored. */
export const pickSettings = (saved: unknown): BashSettings => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  return {
    previewLines: Number.isInteger(s.previewLines) && (s.previewLines as number) > 0 ? (s.previewLines as number) : DEFAULT_SETTINGS.previewLines,
    guard: typeof s.guard === 'boolean' ? s.guard : DEFAULT_SETTINGS.guard,
    unfoldGroups: typeof s.unfoldGroups === 'boolean' ? s.unfoldGroups : DEFAULT_SETTINGS.unfoldGroups,
  }
}

export type GuardRule = { pattern: string; why: string }

/** Destructive patterns the guard asks about. Extra patterns belong in Claude Code's `permissions.ask` rules. */
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

// ---- Bash result record -------------------------------------------------------------

export type BashInput = {
  command?: string
  description?: string
  run_in_background?: boolean
  dangerouslyDisableSandbox?: boolean
}

export type DiffFile = { filePath: string; hunks: { lines: string[] }[] }

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
  '  config                     show the settings',
  '  config <key> <value>       change a setting (previewLines, guard, unfoldGroups)',
  '  config reset               restore the defaults',
  '  help                       this text',
].join('\n')

const NUMERIC = ['previewLines'] as const
const BOOLEAN = ['guard', 'unfoldGroups'] as const

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
  return `Unknown setting "${key}". Settings: ${[...NUMERIC, ...BOOLEAN].join(', ')}.`
}

export const showSettings = (cfg: BashSettings) =>
  [...NUMERIC, ...BOOLEAN].map(k => `  ${k.padEnd(14)} ${typeof cfg[k] === 'boolean' ? (cfg[k] ? 'on' : 'off') : String(cfg[k])}`).join('\n')
