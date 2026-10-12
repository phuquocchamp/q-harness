/** A panel's own open/closed choice, valid until the next `/q-bash expand-all | collapse-all`. */
export type PanelView = { open: boolean; epoch: number }

/** The global view set by `/q-bash expand-all | collapse-all`; each command bumps `epoch`. */
export type PanelMode = { open: boolean; epoch: number }

export type GuardRule = { pattern: string; why: string }

export type BashSettings = {
  /** Lines shown in a collapsed panel. */
  previewLines: number
  /** Lines drawn in an expanded panel before the head/tail split. */
  maxExpandedLines: number
  /** A command slower than this draws its duration in amber. */
  slowMs: number
  /** Ask before destructive commands. */
  guard: boolean
  /** Hide token-like strings in panels. */
  maskSecrets: boolean
  /** Unfold "ran N shell commands" groups so each Bash call gets its panel. */
  unfoldGroups: boolean
  commandBg: string
  outputBg: string
  /** User rules added with `/q-bash guard add`. */
  guardRules: GuardRule[]
}

export type HistoryStatus = 'running' | 'done' | 'failed' | 'interrupted' | 'background' | 'denied'

export type HistoryEntry = {
  id: string
  command: string
  status: HistoryStatus
  at: number
  ms?: number
}

export type HistoryFilter = 'all' | 'failed'

declare module 'claude-code' {
  interface PluginState {
    'q-bash': {
      /** Per Bash call (keyed by tool_use_id): the panel's own choice, null when it has none. */
      panel: StateFamily<PanelView | null>
      /** Set by `/q-bash expand-all | collapse-all`. */
      mode: PanelMode
      /** Per Bash call: wall-clock duration in ms, recorded around `tool.call`. */
      duration: StateFamily<number>
      /** Per Bash call: is the changed-files diff shown? */
      diffOpen: StateFamily<boolean>
      /** Per Bash call: are masked secrets revealed? */
      revealed: StateFamily<boolean>
      /** BashSettings, loaded from `$.store` at session start. */
      settings: BashSettings
      /** Bash calls of this session, newest last. */
      history: HistoryEntry[]
      /** Filter of the history pane. */
      historyFilter: HistoryFilter
    }
  }
}
