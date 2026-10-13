// Pure helpers for the files ledger and the turn summary.
// No `$` access here, so everything is easy to test.

import type { FileEntry, TurnStats } from '../../types'

// ---- paths ----------------------------------------------------------------------------

/** Shows a path relative to the session root when it lies inside it. */
export const relPath = (root: string, path: string) => {
  if (!root) return path
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}

// ---- line ranges: how much of a file has been read ------------------------------------

/** Merges [start, end] ranges (1-based, inclusive) into a sorted, non-overlapping list. */
export const mergeRanges = (ranges: [number, number][]): [number, number][] => {
  const sorted = [...ranges].sort((a, b) => a[0] - b[0])
  const out: [number, number][] = []
  for (const [s, e] of sorted) {
    const last = out[out.length - 1]
    if (last && s <= last[1] + 1) last[1] = Math.max(last[1], e)
    else out.push([s, e])
  }
  return out
}

/** Share of the file's lines that were read, 0..1, or undefined when unknown. */
export const coverage = (f: FileEntry) => {
  if (!f.totalLines) return undefined
  const seen = f.ranges.reduce((n, [s, e]) => n + (e - s + 1), 0)
  return Math.min(1, seen / f.totalLines)
}

/** Counts added and removed lines in structured-patch hunks. */
export const patchStats = (hunks: { lines: string[] }[] | undefined) => {
  let added = 0
  let removed = 0
  for (const h of hunks ?? []) {
    for (const l of h.lines) {
      if (l.startsWith('+')) added++
      else if (l.startsWith('-')) removed++
    }
  }
  return { added, removed }
}

// ---- recording one tool call ---------------------------------------------------------------

export type CallRecord = {
  tool: string
  input: Record<string, unknown>
  result: unknown
  isError: boolean
  agentId?: string
  at: number
}

/** What one call adds to the turn summary. */
export type TurnDelta = Partial<Omit<TurnStats, 'turnId' | 'at' | 'ms' | 'isRunning' | 'files'>> & { files?: string[] }

const blank = (path: string, at: number): FileEntry => ({
  path,
  reads: 0,
  rereads: 0,
  edits: 0,
  writes: 0,
  added: 0,
  removed: 0,
  ranges: [],
  agents: [],
  last: at,
  lastAction: 'read',
})

const touch = (list: FileEntry[], path: string, at: number, fn: (f: FileEntry) => FileEntry) => {
  const i = list.findIndex(f => f.path === path)
  const next = fn({ ...(i >= 0 ? list[i]! : blank(path, at)), last: at })
  return i >= 0 ? list.map((f, j) => (j === i ? next : f)) : [...list, next]
}

const withAgent = (f: FileEntry, agentId?: string) =>
  agentId && !f.agents.includes(agentId) ? { ...f, agents: [...f.agents, agentId] } : f

type ReadResult =
  | { type: 'text'; file: { filePath: string; startLine: number; numLines: number; totalLines: number; truncatedByTokenCap?: boolean } }
  | { type: 'file_unchanged'; file: { filePath: string } }
  | { type: string; file: { filePath?: string } }

type FileChange = { filePath?: string; type?: 'create' | 'update'; structuredPatch?: { lines: string[] }[] }

type BashResult = {
  bashEditDiff?: { files?: { filePath: string; hunks: { lines: string[] }[]; created?: true; deleted?: true }[] }
}

/**
 * Applies one finished tool call to the ledger. Returns the new ledger and what the
 * call adds to the turn summary. Tools the ledger does not track return the ledger as is.
 */
export const recordCall = (ledger: FileEntry[], root: string, c: CallRecord): { ledger: FileEntry[]; delta: TurnDelta } => {
  const { tool, input, result, isError, agentId, at } = c

  if (tool === 'Bash') {
    const delta: TurnDelta = { bash: 1, bashFailed: isError ? 1 : 0 }
    const files = (result as BashResult | undefined)?.bashEditDiff?.files ?? []
    let next = ledger
    let added = 0
    let removed = 0
    for (const f of files) {
      const s = patchStats(f.hunks)
      added += s.added
      removed += s.removed
      next = touch(next, relPath(root, f.filePath), at, e =>
        withAgent({ ...e, edits: e.edits + 1, viaBash: (e.viaBash ?? 0) + 1, added: e.added + s.added, removed: e.removed + s.removed, created: e.created || f.created === true, lastAction: 'bash' }, agentId),
      )
    }
    if (files.length > 0) Object.assign(delta, { edits: files.length, added, removed, files: files.map(f => relPath(root, f.filePath)) })
    return { ledger: next, delta }
  }

  if (tool === 'Agent') return { ledger, delta: { agents: 1 } }
  if (isError) return { ledger, delta: {} }

  if (tool === 'Read') {
    const r = result as ReadResult | undefined
    const raw = r?.file?.filePath ?? (input.file_path as string | undefined)
    if (!raw) return { ledger, delta: {} }
    const path = relPath(root, raw)
    if (r?.type === 'file_unchanged') {
      return {
        ledger: touch(ledger, path, at, f => withAgent({ ...f, reads: f.reads + 1, rereads: f.rereads + 1, lastAction: 'read' }, agentId)),
        delta: { reads: 1, rereads: 1, files: [path] },
      }
    }
    if (r?.type === 'text') {
      const t = r.file as Extract<ReadResult, { type: 'text' }>['file']
      const end = t.startLine + Math.max(0, t.numLines - 1)
      const partial = t.truncatedByTokenCap === true || t.numLines < t.totalLines
      return {
        ledger: touch(ledger, path, at, f =>
          withAgent(
            {
              ...f,
              reads: f.reads + 1,
              totalLines: t.totalLines,
              ranges: t.numLines > 0 ? mergeRanges([...f.ranges, [t.startLine, end]]) : f.ranges,
              lastAction: 'read',
            },
            agentId,
          ),
        ),
        delta: { reads: 1, partial: partial ? 1 : 0, files: [path] },
      }
    }
    // Images, PDFs, notebooks: counted as a read, with no line coverage.
    return { ledger: touch(ledger, path, at, f => withAgent({ ...f, reads: f.reads + 1, lastAction: 'read' }, agentId)), delta: { reads: 1, files: [path] } }
  }

  if (tool === 'Edit' || tool === 'Write' || tool === 'NotebookEdit') {
    const r = (result ?? {}) as FileChange
    const raw = r.filePath ?? (input.file_path as string | undefined) ?? (input.notebook_path as string | undefined)
    if (!raw) return { ledger, delta: {} }
    const path = relPath(root, raw)
    const s = patchStats(r.structuredPatch)
    if (tool === 'Write') {
      const isNew = r.type === 'create'
      return {
        ledger: touch(ledger, path, at, f =>
          withAgent(
            {
              ...f,
              writes: f.writes + 1,
              added: f.added + s.added,
              removed: f.removed + s.removed,
              created: f.created || isNew,
              overwrites: (f.overwrites ?? 0) + (isNew ? 0 : 1),
              lastAction: 'write',
            },
            agentId,
          ),
        ),
        delta: { writes: 1, created: isNew ? 1 : 0, added: s.added, removed: s.removed, files: [path] },
      }
    }
    return {
      ledger: touch(ledger, path, at, f =>
        withAgent({ ...f, edits: f.edits + 1, added: f.added + s.added, removed: f.removed + s.removed, lastAction: 'edit' }, agentId),
      ),
      delta: { edits: 1, added: s.added, removed: s.removed, files: [path] },
    }
  }

  return { ledger, delta: {} }
}

/** Most files the ledger keeps; past it the oldest read-only files go first, so a changed file is the last to leave. */
export const LEDGER_LIMIT = 500

export const capLedger = (list: FileEntry[], max = LEDGER_LIMIT): FileEntry[] => {
  if (list.length <= max) return list
  const byAge = [...list].sort((a, b) => a.last - b.last)
  const drop = new Set([...byAge.filter(f => f.edits + f.writes === 0), ...byAge.filter(f => f.edits + f.writes > 0)].slice(0, list.length - max))
  return list.filter(f => !drop.has(f))
}

// ---- turn summary ---------------------------------------------------------------------------

export const newTurn = (turnId: string, at: number): TurnStats => ({
  turnId,
  at,
  isRunning: true,
  reads: 0,
  rereads: 0,
  partial: 0,
  edits: 0,
  writes: 0,
  created: 0,
  added: 0,
  removed: 0,
  bash: 0,
  bashFailed: 0,
  agents: 0,
  files: [],
})

export const addToTurn = (t: TurnStats, d: TurnDelta): TurnStats => {
  const next = { ...t }
  for (const k of ['reads', 'rereads', 'partial', 'edits', 'writes', 'created', 'added', 'removed', 'bash', 'bashFailed', 'agents'] as const) {
    next[k] = t[k] + (d[k] ?? 0)
  }
  if (d.files) next.files = [...new Set([...t.files, ...d.files])]
  return next
}

/** Did the turn read, change or run anything? */
export const hasActivity = (t: TurnStats) => t.reads + t.edits + t.writes + t.bash + t.agents > 0

/** The parts of the band line, each `{ text, tone }`; empty parts are left out. */
export const turnParts = (t: TurnStats, readFiles: number, changedFiles: number) => {
  const parts: { text: string; tone?: 'green' | 'red' | 'blue' }[] = []
  if (t.reads > 0) {
    const notes = [t.partial > 0 && `${t.partial} partial`, t.rereads > 0 && `${t.rereads} re-read`].filter(Boolean).join(', ')
    parts.push({ text: `read ${readFiles}${notes ? ` (${notes})` : ''}` })
  }
  if (t.edits + t.writes > 0) {
    parts.push({ text: `changed ${changedFiles}` })
    parts.push({ text: `+${t.added}`, tone: 'green' })
    parts.push({ text: `−${t.removed}`, tone: 'red' })
  }
  if (t.created > 0) parts.push({ text: `created ${t.created}`, tone: 'blue' })
  if (t.bash > 0) parts.push({ text: `bash ${t.bash}${t.bashFailed > 0 ? ` (${t.bashFailed} failed)` : ''}`, tone: t.bashFailed > 0 ? 'red' : undefined })
  return parts
}

// ---- files pane -------------------------------------------------------------------------------

const isChanged = (f: FileEntry) => f.edits + f.writes > 0

/** Splits the ledger into changed and read-only files, newest first. */
export const groupFiles = (list: FileEntry[]) => {
  const sorted = [...list].sort((a, b) => b.last - a.last)
  return { changed: sorted.filter(isChanged), readOnly: sorted.filter(f => !isChanged(f)) }
}

/** `+12 −3`, or `new` for a file this session created. */
export const changeLabel = (f: FileEntry) => (f.created ? 'new' : `+${f.added} −${f.removed}`)

/** `40% read` when only part of the file was read, else undefined. */
export const readNote = (f: FileEntry) => {
  const cov = coverage(f)
  return cov !== undefined && cov < 1 ? `${Math.round(cov * 100)}% read` : undefined
}
