// Diff guard for healer patches: a heal may fix a locator, but must not hide a failure.

import type { DiffGuardVerdict } from './contract'

interface FileDiff {
  oldPath?: string // undefined for a new file
  newPath?: string // undefined for a deleted file
  added: string[]
  removed: string[]
}

const stripPrefix = (p: string) => p.replace(/^"|"$/g, '').replace(/^[ab]\//, '')

/** Splits a unified diff (git or plain) into files with their added and removed lines. */
export function parseUnifiedDiff(diff: string): FileDiff[] {
  const files: FileDiff[] = []
  let cur: FileDiff | undefined
  let inHunk = false
  const lines = diff.split('\n')
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    const git = /^diff --git (\S+) (\S+)/.exec(line)
    if (git) {
      cur = { oldPath: stripPrefix(git[1]!), newPath: stripPrefix(git[2]!), added: [], removed: [] }
      files.push(cur)
      inHunk = false
      continue
    }
    // A file header is `--- old` + `+++ new` + `@@`; checking all three keeps a removed `-- x` line from looking like one.
    if (line.startsWith('--- ') && (!inHunk || (lines[i + 1]?.startsWith('+++ ') && lines[i + 2]?.startsWith('@@')))) {
      inHunk = false
      const p = line.slice(4).split('\t')[0]!.trim()
      if (!cur || cur.added.length || cur.removed.length) {
        cur = { added: [], removed: [] }
        files.push(cur)
      }
      cur.oldPath = p === '/dev/null' ? undefined : stripPrefix(p)
      continue
    }
    if (!inHunk && line.startsWith('+++ ') && cur) {
      const p = line.slice(4).split('\t')[0]!.trim()
      cur.newPath = p === '/dev/null' ? undefined : stripPrefix(p)
      continue
    }
    if (!cur) continue
    if (/^new file mode/.test(line)) cur.oldPath = undefined
    else if (/^deleted file mode/.test(line)) cur.newPath = undefined
    else if (/^rename from /.test(line)) cur.oldPath = line.slice('rename from '.length).trim()
    else if (/^rename to /.test(line)) cur.newPath = line.slice('rename to '.length).trim()
    else if (line.startsWith('@@')) inHunk = true
    else if (inHunk && line.startsWith('+')) cur.added.push(line.slice(1))
    else if (inHunk && line.startsWith('-')) cur.removed.push(line.slice(1))
  }
  return files
}

/** Slashes forward, `.` and `..` segments resolved; an absolute path stays absolute. */
const norm = (p: string) => {
  const abs = p.replace(/\\/g, '/').startsWith('/')
  const out: string[] = []
  for (const seg of p.replace(/\\/g, '/').split('/')) {
    if (seg === '' || seg === '.') continue
    if (seg === '..' && out.length > 0 && out.at(-1) !== '..') out.pop()
    else out.push(seg)
  }
  return (abs ? '/' : '') + out.join('/')
}
const inside = (p: string, dir: string) => {
  const d = norm(dir)
  const n = norm(p)
  if (n.startsWith('/') || n === '..' || n.startsWith('../')) return false
  return d === '' || d === '.' || n.startsWith(`${d}/`)
}

const isComment = (l: string) => /^\s*(\/\/|\/\*|\*)/.test(l)
const count = (lines: string[], re: RegExp) => lines.reduce((n, l) => n + (l.match(re)?.length ?? 0), 0)

const EXPECT = /\bexpect(?:\.soft|\.poll)?\s*\(/g
const SOFT = /\bexpect\.soft\s*\(/g
const STRONG = /\.(?:toBe|toEqual|toStrictEqual|toHaveText|toContainText|toHaveValue|toHaveValues|toHaveURL|toHaveTitle|toHaveCount|toHaveAttribute|toMatchAriaSnapshot)\s*\(/g
const WEAK = /\.(?:toBeTruthy|toBeDefined|toBeAttached|toBeVisible|toBeEnabled)\s*\(|\.not\.(?:toBeNull|toBeUndefined)\s*\(/g
// A match-anything regex literal (`/.*/`, `/.+/`, `/^.*$/`) or constructor call as an expected value.
const ANY_REGEX = /\/\^?\.[*+]\$?\/[a-z]*|new RegExp\(\s*['"]\^?\.[*+]\$?['"]/g
// `.catch(() => {})` and friends: an error swallowed on purpose.
const SWALLOW = /\.catch\s*\(\s*(?:\(\s*\w*\s*\)|\w+)\s*=>\s*(?:\{\s*\}|undefined|null|void 0)\s*\)/g
const MARKERS: [RegExp, string][] = [
  [/\b(?:test\.describe|test|describe)\.fixme\s*\(/, 'adds test.fixme'],
  [/\b(?:test\.describe|test|describe|it)\.skip\s*\(/, 'adds test.skip'],
  [/\btest(?:\.describe)?\.fail\s*\(/, 'adds test.fail'],
  [/\b(?:test|describe|it)(?:\.describe)?\.only\s*\(/, 'adds .only'],
  [/\btest\.slow\s*\(/, 'adds test.slow'],
]
export const MAX_TIMEOUT = 30_000
// `timeout:`, `actionTimeout:`, `navigationTimeout:`, `test.setTimeout(n)`, `page.setDefault(Navigation)Timeout(n)`.
const TIMEOUT = /(?:timeout["']?\s*:\s*|set(?:Default(?:Navigation)?)?Timeout\s*\(\s*)(\d[\d_]*)/gi

/** Rejects a heal that skips, deletes, weakens or comments out checks, or edits outside `testDir`. */
export function checkHealDiff(unifiedDiff: string, testDir: string): DiffGuardVerdict {
  const reasons: string[] = []
  const add = (r: string) => {
    if (!reasons.includes(r)) reasons.push(r)
  }
  for (const f of parseUnifiedDiff(unifiedDiff)) {
    const paths = [f.oldPath, f.newPath].filter((p): p is string => !!p)
    for (const p of paths) if (!inside(p, testDir)) add(`edits outside ${norm(testDir) || '.'}/: ${p}`)
    if (f.oldPath && !f.newPath && /\.(?:spec|test)\.[cm]?[jt]sx?$/.test(f.oldPath)) add(`deletes spec ${f.oldPath}`)

    const code = f.added.filter(l => !isComment(l))
    const removedCode = f.removed.filter(l => !isComment(l))
    for (const [re, reason] of MARKERS) {
      if (code.filter(l => re.test(l)).length > removedCode.filter(l => re.test(l)).length) add(reason)
    }
    if (f.added.some(l => isComment(l) && /\bexpect(?:\.soft|\.poll)?\s*\(/.test(l))) add('comments out expect()')
    if (count(removedCode, EXPECT) > count(code, EXPECT)) add('removes expect()')
    if (count(code, SOFT) > count(removedCode, SOFT)) add('softens expect() to expect.soft()')
    if (count(removedCode, STRONG) > count(code, STRONG) && count(code, WEAK) > count(removedCode, WEAK)) {
      add('loosens assertions (e.g. toHaveText → toBeTruthy)')
    }
    if (count(code, ANY_REGEX) > count(removedCode, ANY_REGEX)) add('matches anything (/.*/) instead of a value')
    if (count(code, SWALLOW) > count(removedCode, SWALLOW)) add('swallows errors with .catch(() => {})')
    for (const l of code) {
      for (const m of l.matchAll(TIMEOUT)) {
        const ms = Number(m[1]!.replace(/_/g, ''))
        if (ms > MAX_TIMEOUT) add(`raises a timeout to ${ms} ms (max ${MAX_TIMEOUT})`)
      }
    }
  }
  return { ok: reasons.length === 0, reasons }
}

/** Binary files the healer's text tools cannot change: left out of a snapshot. */
export const BINARY_FILE = /\.(?:png|jpe?g|gif|webp|ico|pdf|zip|mp4|webm|woff2?)$/i

/**
 * A unified-diff text of two file snapshots (path → content), for `checkHealDiff`. Lines are compared
 * as multisets, so moved lines are not changes; there is no size cap.
 */
export function diffSnapshots(before: Record<string, string>, after: Record<string, string>): string {
  const out: string[] = []
  for (const path of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const old = before[path]
    const now = after[path]
    if (old === now) continue
    const oldLines = old === undefined ? [] : old.split('\n')
    const newLines = now === undefined ? [] : now.split('\n')
    const pool = new Map<string, number>()
    for (const l of newLines) pool.set(l, (pool.get(l) ?? 0) + 1)
    const removed: string[] = []
    for (const l of oldLines) {
      const n = pool.get(l) ?? 0
      if (n > 0) pool.set(l, n - 1)
      else removed.push(l)
    }
    const kept = new Map<string, number>()
    for (const l of oldLines) kept.set(l, (kept.get(l) ?? 0) + 1)
    const added: string[] = []
    for (const l of newLines) {
      const n = kept.get(l) ?? 0
      if (n > 0) kept.set(l, n - 1)
      else added.push(l)
    }
    out.push(
      `diff --git a/${path} b/${path}`,
      `--- ${old === undefined ? '/dev/null' : `a/${path}`}`,
      `+++ ${now === undefined ? '/dev/null' : `b/${path}`}`,
      '@@ -1 +1 @@',
      ...removed.map(l => `-${l}`),
      ...added.map(l => `+${l}`),
    )
  }
  return out.join('\n')
}

/** Rejects edited files outside `testDir` and rewritten snapshot baselines (text diffs cannot show these). */
export function checkHealFiles(files: readonly string[], testDir: string): DiffGuardVerdict {
  const reasons: string[] = []
  const outside = files.filter(f => !inside(f, testDir))
  if (outside.length > 0) reasons.push(`edits outside ${norm(testDir) || '.'}/: ${outside.join(', ')}`)
  const baselines = files.filter(f => /(^|\/)[^/]*-snapshots\/|\.aria\.ya?ml$/.test(f))
  if (baselines.length > 0) reasons.push(`updates snapshot baselines: ${baselines.join(', ')}`)
  return { ok: reasons.length === 0, reasons }
}
