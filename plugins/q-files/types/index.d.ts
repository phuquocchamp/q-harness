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

export type FilesSettings = {
  /** Draw the turn line above the prompt. */
  band: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'q-files': {
      /** Files touched this session, oldest first. */
      ledger: FileEntry[]
      /** The current main-loop turn. */
      turn: TurnStats | null
      /** The last turn that read, changed or ran something; shown while the current one has not. */
      lastTurn: TurnStats | null
      /** Loaded from `$.store` at session start. */
      settings: FilesSettings
    }
  }
}
