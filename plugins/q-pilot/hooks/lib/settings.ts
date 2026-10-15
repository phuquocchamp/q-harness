// q-pilot's settings, set with `/q-pilot config <key> <value>` and kept in the plugin store across sessions.
// Pure, so everything is easy to test. Only the Jev API key stays a plugin option (it is a secret).

export type Helper = 'haiku' | 'sonnet' | 'opus' | 'session'

export type PilotSettings = {
  /** The Claude model that answers Jev's help requests first; `session` hands them straight to the chat. */
  helper: Helper
  vision: 'off' | 'gated' | 'always'
  visionModel: 'jev-1.13.0' | 'jev-1.14.0'
  box: boolean
  inspector: 'on' | 'pause' | 'off'
  mode: 'off' | 'affected' | 'all'
  cdpUrl: string
  node: string
  trust: 'shadow' | 'on'
  followUp: 'auto' | 'suggest' | 'off'
  maxStopSeconds: number
  maxTestSeconds: number
  maxTaskSeconds: number
}

export const DEFAULT_SETTINGS: PilotSettings = {
  helper: 'haiku',
  vision: 'gated',
  visionModel: 'jev-1.13.0',
  box: false,
  inspector: 'on',
  mode: 'affected',
  cdpUrl: '',
  node: 'node',
  trust: 'shadow',
  followUp: 'auto',
  maxStopSeconds: 60,
  maxTestSeconds: 120,
  maxTaskSeconds: 300,
}

type Key = keyof PilotSettings
type Spec =
  | { kind: 'enum'; values: readonly string[]; help: string; advanced?: true }
  | { kind: 'bool'; help: string; advanced?: true }
  | { kind: 'string'; help: string; advanced?: true }
  | { kind: 'number'; min: number; max: number; help: string; advanced?: true }

export const SPECS: Record<Key, Spec> = {
  helper: { kind: 'enum', values: ['haiku', 'sonnet', 'opus', 'session'], help: 'Claude model that answers when Jev (and its vision) is stuck; session: your chat answers' },
  vision: { kind: 'enum', values: ['off', 'gated', 'always'], help: 'Jev sees the screenshot: never, when unsure, every step' },
  visionModel: { kind: 'enum', values: ['jev-1.13.0', 'jev-1.14.0'], help: 'Jev model that answers with the screenshot' },
  box: { kind: 'bool', help: 'Box rescue: Jev 1.14 finds the control on the screenshot when stuck' },
  inspector: { kind: 'enum', values: ['on', 'pause', 'off'], help: 'live inspector in your browser for each task (pause: hold before step 1)' },
  mode: { kind: 'enum', values: ['off', 'affected', 'all'], help: 'stop gate: which saved flows run when a turn ends' },
  cdpUrl: { kind: 'string', help: 'run in your own Chrome (e.g. http://127.0.0.1:9222); off: launch Chromium' },
  node: { kind: 'string', help: 'Node 18+ command that runs the runner' },
  trust: { kind: 'enum', values: ['shadow', 'on'], help: 'on: accept drift the turn diff explains', advanced: true },
  followUp: { kind: 'enum', values: ['auto', 'suggest', 'off'], help: 'red gate without the classic Stop hook', advanced: true },
  maxStopSeconds: { kind: 'number', min: 10, max: 600, help: 'stop gate budget', advanced: true },
  maxTestSeconds: { kind: 'number', min: 20, max: 600, help: 'pilot_test budget', advanced: true },
  maxTaskSeconds: { kind: 'number', min: 30, max: 600, help: 'pilot_run budget (paused time counts)', advanced: true },
}

const KEYS = Object.keys(SPECS) as Key[]

/** One value checked against its key's spec: the parsed value, or undefined when it does not fit. */
function fit(key: Key, raw: unknown): PilotSettings[Key] | undefined {
  const spec = SPECS[key]
  if (spec.kind === 'enum') return typeof raw === 'string' && spec.values.includes(raw) ? (raw as PilotSettings[Key]) : undefined
  if (spec.kind === 'bool') return typeof raw === 'boolean' ? raw : raw === 'on' ? true : raw === 'off' ? false : undefined
  if (spec.kind === 'string') return typeof raw === 'string' ? raw.trim() : undefined
  const n = Number(raw)
  return raw !== '' && raw !== null && Number.isFinite(n) && n >= spec.min && n <= spec.max ? n : undefined
}

/** Takes the known, valid keys of a stored value (or legacy plugin options); everything else is dropped. */
export const pickSettings = (saved: unknown): Partial<PilotSettings> => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  const out: Partial<PilotSettings> = {}
  for (const k of KEYS) {
    // The legacy plugin option for Box rescue was called visionBox.
    const raw = k === 'box' && s.box === undefined ? s.visionBox : s[k]
    const v = raw === undefined || raw === '' ? undefined : fit(k, raw)
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** Only the values that differ from the defaults (a host fills declared plugin options with their defaults). */
export const withoutDefaults = (s: Partial<PilotSettings>): Partial<PilotSettings> =>
  Object.fromEntries(Object.entries(s).filter(([k, v]) => DEFAULT_SETTINGS[k as keyof PilotSettings] !== v)) as Partial<PilotSettings>

/** Defaults, then the legacy plugin options, then what `/q-pilot config` stored. */
export const effective = (legacy: Partial<PilotSettings>, stored: Partial<PilotSettings>): PilotSettings => ({ ...DEFAULT_SETTINGS, ...legacy, ...stored })

/** The key a person typed, case-insensitive (`visionmodel` is visionModel). */
export const keyOf = (typed: string): Key | undefined => KEYS.find(k => k.toLowerCase() === typed.toLowerCase())

/**
 * Parses `/q-pilot config <key> <value>` into the next stored settings, or an error. `default` removes the key
 * (back to its default); `off` or `none` clears a text setting. Values are case-sensitive except enum and on/off.
 */
export function applyConfig(stored: Partial<PilotSettings>, typedKey: string, value: string): Partial<PilotSettings> | string {
  const key = keyOf(typedKey)
  if (!key) return `Unknown setting "${typedKey}". Settings: ${KEYS.join(', ')}.`
  const spec = SPECS[key]
  const next = { ...stored }
  if (value === '') return `${key} needs a value: ${valuesOf(key)}.`
  if (value.toLowerCase() === 'default') {
    delete next[key]
    return next
  }
  if (spec.kind !== 'string' && /\s/.test(value)) return `${key} takes one value: ${valuesOf(key)}.`
  const raw = spec.kind === 'string' ? (['off', 'none'].includes(value.toLowerCase()) ? '' : value) : spec.kind === 'number' ? value : value.toLowerCase()
  const v = fit(key, raw)
  if (v === undefined) return `${key} must be ${valuesOf(key)}.`
  ;(next as Record<string, unknown>)[key] = v
  return next
}

const valuesOf = (key: Key) => {
  const spec = SPECS[key]
  if (spec.kind === 'enum') return spec.values.join('|')
  if (spec.kind === 'bool') return 'on|off'
  if (spec.kind === 'number') return `a number from ${spec.min} to ${spec.max}`
  return key === 'cdpUrl' ? 'a URL, or off' : 'a command'
}

const shown = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? 'off' : String(v))

/** `/q-pilot config`: every setting, its value, and whether it was set or is the default. */
export function showSettings(s: PilotSettings, stored: Partial<PilotSettings>): string {
  const row = (k: Key) => `  ${k.padEnd(15)} ${shown(s[k]).padEnd(12)} ${k in stored ? '*' : ' '} ${SPECS[k].help} (${valuesOf(k)})`
  return [
    'q-pilot settings (* set by you; /q-pilot config <key> <value>, <key> default, or reset):',
    ...KEYS.filter(k => !SPECS[k].advanced).map(row),
    '  advanced:',
    ...KEYS.filter(k => SPECS[k].advanced).map(row),
  ].join('\n')
}
