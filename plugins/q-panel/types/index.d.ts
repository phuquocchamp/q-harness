export type PanelSettings = {
  /** Draw the row above the prompt at all. */
  band: boolean
  /** The git segment of the row (branch, ahead/behind, changes). */
  git: boolean
  /** The turn segment of the row (read, changed, bash). */
  files: boolean
  /** Ask before destructive Bash commands. */
  guard: boolean
  /** Unfold a "ran N shell commands" group when every call in it is Bash. */
  unfoldGroups: boolean
  /** Lines shown in a collapsed Bash panel. */
  previewLines: number
}

export type GitStatus = {
  branch: string
  /** True when HEAD is not on a branch; `branch` is then the short commit id. */
  detached: boolean
  upstream?: string
  ahead: number
  behind: number
  staged: number
  modified: number
  untracked: number
  conflicts: number
  stash: number
}

export type GitEventKind = 'commit' | 'push' | 'merge' | 'rebase' | 'pr'

export type GitEvent = {
  at: number
  kind: GitEventKind
  /** One-line description, e.g. `committed 9f3e21a on main`. */
  label: string
  sha?: string
  url?: string
  command: string
}

/** One file Claude touched this session, built from Read / Write / Edit / NotebookEdit / Bash results. */
export type FileEntry = {
  /** Relative to the session root when inside it. */
  path: string
  reads: number
  /** Reads that came back `file_unchanged`. */
  rereads: number
  edits: number
  writes: number
  added: number
  removed: number
  /** Line ranges read so far, merged, 1-based inclusive. */
  ranges: [number, number][]
  totalLines?: number
  created?: boolean
  /** Writes that replaced an existing file. */
  overwrites?: number
  /** Changes made by a Bash command (`sed -i`, a formatter, …). */
  viaBash?: number
  /** Subagent ids that touched the file. */
  agents: string[]
  last: number
  lastAction: 'read' | 'edit' | 'write' | 'bash'
}

/** Counts for one main-loop turn, shown in the row above the prompt. */
export type TurnStats = {
  turnId: string
  at: number
  ms?: number
  isRunning: boolean
  reads: number
  rereads: number
  partial: number
  edits: number
  writes: number
  created: number
  added: number
  removed: number
  bash: number
  bashFailed: number
  agents: number
  /** Distinct files read or changed this turn. */
  files: string[]
}

declare module 'claude-code' {
  interface PluginState {
    'q-panel': {
      /** Loaded from `$.store` at session start; the only value kept across sessions. */
      settings: PanelSettings
      /** `[ hide ]` on the row: hidden for this session only. */
      hidden: boolean
      /** Per Bash call (keyed by tool_use_id): is the panel expanded? */
      open: StateFamily<boolean>
      /** Per Bash call: wall-clock duration in ms, recorded around `tool.call`. */
      duration: StateFamily<number>
      /** The repository status, null outside a git repository. */
      status: GitStatus | null
      /** Commits, pushes, merges and PRs made by Bash calls in this session, oldest first. */
      timeline: GitEvent[]
      /** Files touched this session, oldest first. */
      ledger: FileEntry[]
      /** The current main-loop turn. */
      turn: TurnStats | null
      /** The last turn that read, changed or ran something; shown while the current one has not. */
      lastTurn: TurnStats | null
    }
  }
}
