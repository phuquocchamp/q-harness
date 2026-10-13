export type BashSettings = {
  /** Lines shown in a collapsed panel. */
  previewLines: number
  /** Ask before destructive commands. */
  guard: boolean
  /** Unfold a "ran N shell commands" group when every call in it is Bash. */
  unfoldGroups: boolean
}

declare module 'claude-code' {
  interface PluginState {
    'q-bash': {
      /** Per Bash call (keyed by tool_use_id): is the panel expanded? */
      open: StateFamily<boolean>
      /** Per Bash call: wall-clock duration in ms, recorded around `tool.call`. */
      duration: StateFamily<number>
      /** Settings, loaded from `$.store` at session start. */
      settings: BashSettings
    }
  }
}
