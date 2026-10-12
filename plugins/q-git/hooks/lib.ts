// Pure helpers for q-git: parsing `git status` and turning git operations into timeline events.

import type { GitEvent, GitStatus } from '../types'

export const STATUS_ARGV = ['git', 'status', '--porcelain=v2', '--branch', '--show-stash'] as const
/** `--show-stash` needs git 2.35; older versions reject it, so retry without. */
export const STATUS_ARGV_OLD = ['git', 'status', '--porcelain=v2', '--branch'] as const

/** Parses `git status --porcelain=v2 --branch [--show-stash]`. */
export const parseStatus = (text: string): GitStatus => {
  const s: GitStatus = { branch: '', detached: false, ahead: 0, behind: 0, staged: 0, modified: 0, untracked: 0, conflicts: 0, stash: 0 }
  let oid = ''
  for (const line of text.split('\n')) {
    if (line.startsWith('# branch.oid ')) oid = line.slice(13)
    else if (line.startsWith('# branch.head ')) s.branch = line.slice(14)
    else if (line.startsWith('# branch.upstream ')) s.upstream = line.slice(18)
    else if (line.startsWith('# branch.ab ')) {
      const m = /\+(\d+) -(\d+)/.exec(line)
      s.ahead = Number(m?.[1] ?? 0)
      s.behind = Number(m?.[2] ?? 0)
    } else if (line.startsWith('# stash ')) s.stash = Number(line.slice(8)) || 0
    else if (line.startsWith('1 ') || line.startsWith('2 ')) {
      // "1 XY ..." : X is the index (staged) state, Y the worktree state; "." means unchanged.
      const xy = line.slice(2, 4)
      if (xy[0] !== '.') s.staged += 1
      if (xy[1] !== '.') s.modified += 1
    } else if (line.startsWith('u ')) s.conflicts += 1
    else if (line.startsWith('? ')) s.untracked += 1
  }
  if (s.branch === '(detached)') {
    s.detached = true
    s.branch = oid.slice(0, 7)
  }
  return s
}

export const isDirty = (s: GitStatus) => s.staged + s.modified + s.untracked + s.conflicts > 0

/** One-line summary, also used as the band's text. */
export const statusLine = (s: GitStatus) =>
  [
    `${s.detached ? '⎇ detached at' : '⎇'} ${s.branch}`,
    s.upstream ? `→ ${s.upstream}` : '(no upstream)',
    s.ahead || s.behind ? `↑${s.ahead} ↓${s.behind}` : '',
    s.staged ? `●${s.staged} staged` : '',
    s.modified ? `✚${s.modified} modified` : '',
    s.untracked ? `?${s.untracked} untracked` : '',
    s.conflicts ? `✖${s.conflicts} conflicts` : '',
    !isDirty(s) ? '✓ clean' : '',
    s.stash ? `stash ${s.stash}` : '',
  ]
    .filter(Boolean)
    .join('  ')

/** The engine's classification of git/gh activity in a Bash call (`result.gitOperation`). */
export type GitOperation = {
  commit?: { sha: string; kind: string; branch?: string }
  push?: { branch: string }
  branch?: { ref: string; action: string }
  pr?: { number: number; url?: string; action: string }
}

export const toEvents = (op: GitOperation, command: string, at: number): GitEvent[] => {
  const out: GitEvent[] = []
  if (op.commit)
    out.push({
      at,
      kind: 'commit',
      label: `${op.commit.kind} ${op.commit.sha.slice(0, 7)}${op.commit.branch ? ` on ${op.commit.branch}` : ''}`,
      sha: op.commit.sha,
      command,
    })
  if (op.push) out.push({ at, kind: 'push', label: `pushed ${op.push.branch}`, command })
  if (op.branch)
    out.push({ at, kind: op.branch.action === 'rebased' ? 'rebase' : 'merge', label: `${op.branch.action} ${op.branch.ref}`, command })
  if (op.pr) out.push({ at, kind: 'pr', label: `PR #${op.pr.number} ${op.pr.action}`, url: op.pr.url, command })
  return out
}

/** Does this shell command possibly change what `git status` reports? */
export const touchesGit = (command: string) => /(^|[\s;&|(])(git|gh)\s/.test(command)

export const GLYPH: Record<GitEvent['kind'], string> = { commit: '⎇', push: '↑', merge: '⑂', rebase: '⤴', pr: '◆' }
