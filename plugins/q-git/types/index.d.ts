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

declare module 'claude-code' {
  interface PluginState {
    'q-git': {
      /** The repository status, null outside a git repository. */
      status: GitStatus | null
      /** Commits, pushes, merges and PRs made by Bash calls in this session, oldest first. */
      timeline: GitEvent[]
      /** Whether the status band above the prompt is shown. */
      band: boolean
    }
  }
}
