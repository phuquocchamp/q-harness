// Settings and the /q-panel usage text. Pure, so everything is easy to test.

import type { PanelSettings } from '../../types'

export const DEFAULT_SETTINGS: PanelSettings = {
  band: true,
  git: true,
  files: true,
  guard: true,
  unfoldGroups: true,
  previewLines: 4,
}

const BOOLEAN = ['band', 'git', 'files', 'guard', 'unfoldGroups'] as const
const NUMERIC = ['previewLines'] as const

/** Takes only the current settings from a stored value, so unknown keys are ignored and bad values defaulted. */
export const pickSettings = (saved: unknown): PanelSettings => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  const next = { ...DEFAULT_SETTINGS }
  for (const k of BOOLEAN) if (typeof s[k] === 'boolean') next[k] = s[k] as boolean
  if (Number.isInteger(s.previewLines) && (s.previewLines as number) > 0) next.previewLines = s.previewLines as number
  return next
}

/** Parses `<key> <value>` into a settings patch, or an error message. */
export const parseConfig = (key: string, value: string): Partial<PanelSettings> | string => {
  if ((NUMERIC as readonly string[]).includes(key)) {
    const n = Number(value)
    if (!Number.isInteger(n) || n < 1) return `${key} needs a whole number of 1 or more.`
    return { [key]: n }
  }
  if ((BOOLEAN as readonly string[]).includes(key)) {
    if (!['on', 'off', 'true', 'false'].includes(value)) return `${key} needs on or off.`
    return { [key]: value === 'on' || value === 'true' }
  }
  return `Unknown setting "${key}". Settings: ${[...BOOLEAN, ...NUMERIC].join(', ')}.`
}

export const showSettings = (cfg: PanelSettings) =>
  [...BOOLEAN, ...NUMERIC].map(k => `  ${k.padEnd(14)} ${typeof cfg[k] === 'boolean' ? (cfg[k] ? 'on' : 'off') : String(cfg[k])}`).join('\n')

export const USAGE = [
  'Usage: /q-panel <subcommand>',
  '  files                      open the files this session read and changed',
  '  timeline                   open this session’s commits, pushes and PRs',
  '  status                     print the repository status',
  '  clear                      forget the files and turn counts recorded so far',
  '  band on|off                show or hide the row above the prompt',
  '  guard on|off               ask before destructive commands',
  '  config                     show the settings',
  '  config <key> <value>       change a setting (band, git, files, guard, unfoldGroups, previewLines)',
  '  config reset               restore the defaults',
  '  help                       this text',
].join('\n')
