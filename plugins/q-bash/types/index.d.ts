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
  /** Draw the turn summary band above the prompt. */
  band: boolean
  /** Draw a finished Agent call as a summary card. */
  agentPanel: boolean
  /** Draw a TodoWrite call as a progress card. */
  todoPanel: boolean
  /** Replace the line under a Read call with how much of the file was read. */
  readSummary: boolean
}

/** One file Claude touched this session, built by the recorder from Read / Write / Edit / Bash results. */
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

/** Counts for one main-loop turn, shown in the band above the prompt. */
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

export type FilesFilter = 'all' | 'edited' | 'read' | 'agent'

export type TodoItem = { content: string; status: 'pending' | 'in_progress' | 'completed'; activeForm: string }

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
      /** Files touched this session, oldest first. */
      ledger: FileEntry[]
      /** The current or last main-loop turn. */
      turn: TurnStats | null
      /** The last turn that read, changed or ran something; shown while the current one has done nothing. */
      lastTurn: TurnStats | null
      /** Is the turn band hidden until the next turn? */
      bandHidden: boolean
      /** Filter of the files pane. */
      filesFilter: FilesFilter
      /** Subagent id → agent type, learned from finished Agent calls. */
      agentNames: Record<string, string>
      /** Per Agent call: is the report shown? */
      reportOpen: StateFamily<boolean>
    }
  }
}
