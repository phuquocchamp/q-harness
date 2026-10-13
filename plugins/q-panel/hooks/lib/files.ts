// Pure helpers for the file panels (Write, Edit, NotebookEdit). No `$` access here, so everything is easy to test.

/** Tools drawn as a file panel. */
export const FILE_TOOLS = new Set(['Write', 'Edit', 'NotebookEdit'])

/** One row of a file panel's diff: an added, removed or context line, or a hunk header. */
export type DiffLine = { t: string; kind: '+' | '-' | ' ' | '@' }

export type FileChange = {
  path: string
  /** Header verb: `Write`, `Create`, `Edit`, `Edit ×all`, `Insert cell`, … */
  verb: string
  added: number
  removed: number
  /** The diff, hunk headers included; empty while the call runs or when there is nothing to show. */
  diff: DiffLine[]
  /** True when the file was created rather than changed. */
  created: boolean
  /** True when the change was held for review and the file is unchanged. */
  staged: boolean
}

type Hunk = { oldStart: number; oldLines: number; newStart: number; newLines: number; lines: string[] }

type Input = {
  file_path?: string
  notebook_path?: string
  content?: string
  old_string?: string
  new_string?: string
  replace_all?: boolean
  new_source?: string
  edit_mode?: string
}

type Output = {
  type?: 'create' | 'update'
  structuredPatch?: Hunk[]
  content?: string
  staged?: boolean
  old_source?: string
  new_source?: string
  edit_mode?: string
}

const splitLines = (text: string | undefined) => (text ? text.replace(/\n$/, '').split('\n') : [])

const fromHunks = (hunks: Hunk[]): DiffLine[] =>
  hunks.flatMap(h => [
    { t: `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`, kind: '@' as const },
    ...h.lines.map((l): DiffLine => {
      const k = l[0]
      return { t: l.slice(1), kind: k === '+' || k === '-' ? k : ' ' }
    }),
  ])

const fromPair = (before: string | undefined, after: string | undefined): DiffLine[] => [
  ...splitLines(before).map(t => ({ t, kind: '-' as const })),
  ...splitLines(after).map(t => ({ t, kind: '+' as const })),
]

const count = (diff: DiffLine[], kind: '+' | '-') => diff.filter(l => l.kind === kind).length

/**
 * What a Write, Edit or NotebookEdit call changed, from its input and (once resolved) its result.
 * While the call runs, or when it failed, the diff comes from the input so the panel still shows the intent.
 */
export const fileChange = (tool: string, input: unknown, output: unknown): FileChange => {
  const i = (input ?? {}) as Input
  const o = (output && typeof output === 'object' ? output : {}) as Output
  const path = i.file_path ?? i.notebook_path ?? ''

  let verb = tool
  let diff: DiffLine[]
  let created = false

  if (tool === 'NotebookEdit') {
    const mode = o.edit_mode ?? i.edit_mode ?? 'replace'
    verb = mode === 'insert' ? 'Insert cell' : mode === 'delete' ? 'Delete cell' : 'Edit cell'
    diff = fromPair(o.old_source, mode === 'delete' ? undefined : (o.new_source ?? i.new_source))
  } else if (o.structuredPatch && o.structuredPatch.length > 0) {
    diff = fromHunks(o.structuredPatch)
  } else if (tool === 'Write') {
    // A new file has no patch: every line is added.
    diff = splitLines(o.content ?? i.content).map(t => ({ t, kind: '+' as const }))
  } else {
    diff = fromPair(i.old_string, i.new_string)
  }

  if (tool === 'Write') {
    created = o.type === 'create'
    verb = created ? 'Create' : 'Write'
  }
  if (tool === 'Edit' && i.replace_all) verb = 'Edit ×all'

  return { path, verb, added: count(diff, '+'), removed: count(diff, '-'), diff, created, staged: o.staged === true }
}

/** The changed lines a collapsed panel shows: the first `n` added or removed lines. */
export const previewChanges = (diff: DiffLine[], n: number) => diff.filter(l => l.kind === '+' || l.kind === '-').slice(0, n)

/** `path` relative to `root` when it lies inside it. */
export const relativeTo = (path: string, root: string | undefined) => {
  if (!root) return path
  const base = root.endsWith('/') ? root : `${root}/`
  return path.startsWith(base) ? path.slice(base.length) : path
}
