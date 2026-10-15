// Settings and the /q-graph usage text. Pure, so everything is easy to test.

import type { GraphSettings } from '../../types'

export const DEFAULT_SETTINGS: GraphSettings = { band: true, notify: true }

const KEYS = ['band', 'notify'] as const

/** Takes only the current settings from a stored value, so unknown keys are ignored and bad values defaulted. */
export const pickSettings = (saved: unknown): GraphSettings => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  const next = { ...DEFAULT_SETTINGS }
  for (const k of KEYS) if (typeof s[k] === 'boolean') next[k] = s[k] as boolean
  return next
}

/** Parses `<key> on|off` into a settings patch, or an error message. */
export const parseToggle = (key: string, value: string): Partial<GraphSettings> | string => {
  if (!(KEYS as readonly string[]).includes(key)) return `Unknown setting "${key}". Settings: ${KEYS.join(', ')}.`
  if (!['on', 'off'].includes(value)) return `${key} needs on or off.`
  return { [key]: value === 'on' }
}

/** Arguments each subcommand takes beside its own; the toggles take one value, which `parseToggle` checks. */
const FLAGS: Record<string, readonly string[]> = { open: ['--web'], web: ['stop'], close: [], status: [], config: [], help: [] }

/** The first argument `/q-graph <sub>` does not take, or undefined when all are fine. */
export const unknownArg = (sub: string, rest: readonly string[]): string | undefined =>
  sub === 'band' || sub === 'notify' ? rest[1] : sub in FLAGS ? rest.find(r => !FLAGS[sub]!.includes(r)) : undefined

export const showSettings = (cfg: GraphSettings) => KEYS.map(k => `  ${k.padEnd(8)} ${cfg[k] ? 'on' : 'off'}`).join('\n')

export const USAGE = [
  'Usage: /q-graph [subcommand]',
  '  (none) | open            open the graph pane',
  '  open --web | web         also start the live browser viewer and print its link',
  '  web stop                 stop the live browser viewer',
  '  close                    close it',
  '  status                   one line per agent of this session',
  '  band on|off              the roster band above the prompt',
  '  notify on|off            a notification when an agent waits for you or fails',
  '  config                   show the settings',
  '  help                     this text',
].join('\n')
