export type PanelSettings = {
  /** Draw Write, Edit and NotebookEdit calls as bordered panels with their diff. */
  filePanels: boolean
  /** Unfold a tool group when every call in it is drawn as a panel (Bash, Write, Edit, NotebookEdit). */
  unfoldGroups: boolean
  /** Lines shown in a collapsed Bash or file panel. */
  previewLines: number
  /** Draw fenced code blocks in replies as framed, highlighted blocks that collapse on press. */
  codeBlocks: boolean
  /** Code blocks longer than this start collapsed. */
  codeFoldLines: number
}

declare module 'claude-code' {
  interface PluginState {
    'q-panel': {
      /** Loaded from `$.store` at session start; the only value kept across sessions. */
      settings: PanelSettings
      /** Per Bash or file call (keyed by tool_use_id): is the panel expanded? */
      open: StateFamily<boolean>
      /** Per Bash call: wall-clock duration in ms, recorded around `tool.call`. */
      duration: StateFamily<number>
      /** Per code block in a reply (keyed by `<requestId>#<index>`): expanded or collapsed by a press; null until pressed. */
      codeOpen: StateFamily<boolean | null>
    }
  }
}
