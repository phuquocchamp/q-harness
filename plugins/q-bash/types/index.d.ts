export type BashPanelMode = "collapsed" | "expanded"

declare module 'claude-code' {
  interface PluginState {
    'q-bash': {
      /** Per Bash call (keyed by tool_use_id): is its panel expanded? */
      expanded: StateFamily<boolean>
      /** Set by `/q-bash expand-all`: every panel draws expanded. */
      expandAll: boolean
    }
  }
}
