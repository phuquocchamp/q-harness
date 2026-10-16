// q-pilot's settings, layered like Claude Code's: cli > env > local file > project file > user (the plugin store) > default.
// Set with `/q-pilot config set <key> <value> [--scope user|project|local]`. Pure, so everything is easy to test.
// Only the Jev API key stays a plugin option (it is a secret, and never goes in a settings file).

export type Helper = 'haiku' | 'sonnet' | 'opus' | 'session'

export type PilotSettings = {
  /** The Claude model that answers Jev's help requests first; `session` hands them straight to the chat. */
  helper: Helper
  vision: 'off' | 'gated' | 'always'
  visionModel: 'jev-1.13.0' | 'jev-1.14.0'
  box: boolean
  inspector: 'on' | 'pause' | 'off'
  dashboard: boolean
  /** How the q-pilot Dashboard opens: its own app window, or a tab in the default browser. */
  dashboardWindow: 'app' | 'tab'
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
  dashboard: false,
  dashboardWindow: 'app',
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
/** `personal`: runs a command or opens a connection, so a repo file must not set it (only user, env and cli may). */
type Spec =
  | { kind: 'enum'; values: readonly string[]; help: string; advanced?: true; personal?: true }
  | { kind: 'bool'; help: string; advanced?: true; personal?: true }
  | { kind: 'string'; help: string; advanced?: true; personal?: true }
  | { kind: 'number'; min: number; max: number; help: string; advanced?: true; personal?: true }

export const SPECS: Record<Key, Spec> = {
  helper: { kind: 'enum', values: ['haiku', 'sonnet', 'opus', 'session'], help: 'Claude model that answers when Jev (and its vision) is stuck; session: your chat answers' },
  vision: { kind: 'enum', values: ['off', 'gated', 'always'], help: 'Jev sees the screenshot: never, when unsure, every step (tasks and tests; not stop-gate replay)' },
  visionModel: { kind: 'enum', values: ['jev-1.13.0', 'jev-1.14.0'], help: 'Jev model that answers with the screenshot' },
  box: { kind: 'bool', help: 'Box rescue: Jev 1.14 finds the control on the screenshot when stuck' },
  inspector: { kind: 'enum', values: ['on', 'pause', 'off'], help: 'q-pilot Dashboard for each run, opened for tasks (pause: hold before step 1)' },
  dashboard: { kind: 'bool', help: 'show runs in the Playwright Dashboard (playwright-cli show); pause in the inspector before taking control' },
  dashboardWindow: { kind: 'enum', values: ['app', 'tab'], help: 'q-pilot Dashboard opens as its own app window (app) or a tab in your default browser (tab)' },
  mode: { kind: 'enum', values: ['off', 'affected', 'all'], help: 'stop gate: which saved flows run when a turn ends' },
  cdpUrl: { kind: 'string', help: 'run in your own Chrome (e.g. http://127.0.0.1:9222); off: launch Chromium', personal: true },
  node: { kind: 'string', help: 'Node 18+ command that runs the runner', personal: true },
  trust: { kind: 'enum', values: ['shadow', 'on'], help: 'on: accept drift the turn diff explains', advanced: true, personal: true },
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

/** Takes the known, valid keys of a stored value; everything else is dropped. */
export const pickSettings = (saved: unknown): Partial<PilotSettings> => {
  const s = (saved && typeof saved === 'object' ? saved : {}) as Record<string, unknown>
  const out: Partial<PilotSettings> = {}
  for (const k of KEYS) {
    const v = s[k] === undefined ? undefined : fit(k, s[k])
    if (v !== undefined) (out as Record<string, unknown>)[k] = v
  }
  return out
}

/** The key a person typed, case-insensitive (`visionmodel` is visionModel). */
export const keyOf = (typed: string): Key | undefined => KEYS.find(k => k.toLowerCase() === typed.toLowerCase())

// ---- scopes ----------------------------------------------------------------------------------------

/** Highest first. `user` is the plugin store; `local` and `project` are `.q-pilot/settings.local.json` and `settings.json`. */
export const SCOPES = ['cli', 'env', 'local', 'project', 'user'] as const
export type Scope = (typeof SCOPES)[number]
/** The scopes `/q-pilot config set` writes to (env and cli are never stored). */
export const WRITE_SCOPES = ['user', 'project', 'local'] as const
export type WriteScope = (typeof WRITE_SCOPES)[number]
/** What a repo file may not set: it is committed (or force-committed) by someone else. */
const FILE_SCOPES: readonly string[] = ['project', 'local']

/** One scope's raw settings object, as read (not yet checked). */
export type Layer = Record<string, unknown>
export type Layers = Partial<Record<Scope, unknown>>

export type Source = { scope: Scope | 'default'; overridden: { scope: Scope; value: unknown }[] }
export type Resolved = { values: PilotSettings; sources: Record<Key, Source>; warnings: string[] }

/** The environment variables that are a scope of their own: only the ones the runner already reads. */
export const ENV_VARS: Partial<Record<Key, string>> = { cdpUrl: 'Q_PILOT_CDP_URL' }

/** The env layer from the variables' values: an empty one is unset. */
export const envLayer = (env: Record<string, string | undefined>): Layer => {
  const out: Layer = {}
  for (const [k, name] of Object.entries(ENV_VARS)) {
    const raw = env[name]?.trim()
    if (raw) out[k] = raw
  }
  return out
}

const SECRET_KEY = /api.?key|token|secret|passw(or)?d|credential|auth/i
const SECRET_VALUE = /\b(sk-[\w-]{10,}|gh[pousr]_\w{20,}|xox[abp]-[\w-]+|AKIA\w{12,}|eyJ[\w-]{20,}\.)/
const looksSecret = (key: string, value: unknown) => SECRET_KEY.test(key) || (typeof value === 'string' && SECRET_VALUE.test(value))

/** One scope's valid values, and a warning for everything dropped (unknown key, secret, personal key in a repo file, bad value). */
function checkLayer(scope: Scope, raw: unknown): { values: Partial<PilotSettings>; warnings: string[] } {
  const values: Record<string, unknown> = {}
  const warnings: string[] = []
  if (raw === undefined || raw === null) return { values, warnings }
  if (typeof raw !== 'object' || Array.isArray(raw)) return { values, warnings: [`${scope}: settings must be a JSON object; ignored`] }
  for (const [key, value] of Object.entries(raw)) {
    const k = keyOf(key)
    if (looksSecret(key, value)) warnings.push(`${scope}: "${key}" looks like a secret; ignored (secrets never go in settings; the Jev key is the plugin option)`)
    else if (!k) warnings.push(`${scope}: unknown setting "${key}"; ignored`)
    else if (SPECS[k].personal && FILE_SCOPES.includes(scope)) warnings.push(`${scope}: "${k}" is personal (it runs a command or opens a connection) and is only read from user, env or cli; ignored`)
    else {
      const v = fit(k, value)
      if (v === undefined) warnings.push(`${scope}: ${k} must be ${valuesOf(k)}; ignored`)
      else values[k] = v
    }
  }
  return { values, warnings }
}

/** Defaults, then every scope's checked values, lowest first; each setting remembers where it came from and what it overrides. */
export function resolveSettings(layers: Layers): Resolved {
  const checked = SCOPES.map(scope => ({ scope, ...checkLayer(scope, layers[scope]) }))
  const values = { ...DEFAULT_SETTINGS }
  const sources = {} as Record<Key, Source>
  for (const k of KEYS) {
    const hits = checked.filter(c => k in c.values).map(c => ({ scope: c.scope, value: (c.values as Record<string, unknown>)[k] }))
    const [win, ...rest] = hits
    if (win) (values as Record<string, unknown>)[k] = win.value
    sources[k] = { scope: win?.scope ?? 'default', overridden: rest }
  }
  return { values, sources, warnings: checked.flatMap(c => c.warnings) }
}

/**
 * Parses `/q-pilot config set <key> <value>` into the next settings of one scope's layer, or an error. `default` removes
 * the key; `off` or `none` clears a text setting. Values are case-sensitive except enum and on/off. A personal key
 * is refused in a repo file. Keys the layer already holds are kept as they are.
 */
export function applyConfig(layer: Layer, typedKey: string, value: string, scope: WriteScope = 'user'): Layer | string {
  const key = keyOf(typedKey)
  if (!key) return `Unknown setting "${typedKey}". Settings: ${KEYS.join(', ')}.`
  const spec = SPECS[key]
  if (spec.personal && scope !== 'user') return personalRefusal(key, scope)
  const next = { ...layer }
  if (value === '') return `${key} needs a value: ${valuesOf(key)}.`
  if (value.toLowerCase() === 'default') {
    delete next[key]
    return next
  }
  if (spec.kind !== 'string' && /\s/.test(value)) return `${key} takes one value: ${valuesOf(key)}.`
  const raw = spec.kind === 'string' ? (['off', 'none'].includes(value.toLowerCase()) ? '' : value) : spec.kind === 'number' ? value : value.toLowerCase()
  const v = fit(key, raw)
  if (v === undefined) return `${key} must be ${valuesOf(key)}.`
  if (looksSecret(key, v)) return `${key} looks like a secret; secrets never go in settings.`
  next[key] = v
  return next
}

/** `/q-pilot config unset <key>`: the key leaves the layer. */
export function unsetConfig(layer: Layer, typedKey: string): Layer | string {
  const key = keyOf(typedKey)
  if (!key) return `Unknown setting "${typedKey}". Settings: ${KEYS.join(', ')}.`
  const next = { ...layer }
  delete next[key]
  return next
}

const personalRefusal = (key: Key, scope: WriteScope) => `${key} is personal (it runs a command or opens a connection), so it is not read from the ${scope} file: a repo could set it for you. Use --scope user.`

const valuesOf = (key: Key) => {
  const spec = SPECS[key]
  if (spec.kind === 'enum') return spec.values.join('|')
  if (spec.kind === 'bool') return 'on|off'
  if (spec.kind === 'number') return `a number from ${spec.min} to ${spec.max}`
  return key === 'cdpUrl' ? 'a URL, or off' : 'a command'
}

const shown = (v: unknown) => (typeof v === 'boolean' ? (v ? 'on' : 'off') : v === '' ? 'off' : String(v))

const overrides = (s: Source) => (s.overridden.length ? s.overridden.map(o => `${o.scope}=${shown(o.value)}`).join(', ') : '-')

/** `/q-pilot config`: the settings with their value, the scope it came from, what it overrides, and the warnings. Without `all`, only those that differ from the default. */
export function showSettings(r: Resolved, all = true): string {
  const row = (k: Key) => `  ${(SPECS[k].personal ? `${k}*` : k).padEnd(16)} ${shown(r.values[k]).padEnd(12)} ${r.sources[k].scope.padEnd(8)} ${overrides(r.sources[k]).padEnd(22)} ${SPECS[k].help} (${valuesOf(k)})`
  const head = `  ${'key'.padEnd(16)} ${'value'.padEnd(12)} ${'source'.padEnd(8)} ${'overrides'.padEnd(22)} help`
  const listed = KEYS.filter(k => all || r.sources[k].scope !== 'default')
  const basic = listed.filter(k => !SPECS[k].advanced)
  const advanced = listed.filter(k => SPECS[k].advanced)
  const atDefault = KEYS.length - listed.length
  return [
    'q-pilot settings, highest scope first: cli > env (Q_PILOT_CDP_URL) > local > project > user > default',
    ...(listed.length ? [head] : []),
    ...basic.map(row),
    ...(advanced.length ? ['  advanced:', ...advanced.map(row)] : []),
    ...(all ? [] : [`  ${atDefault} settings at default · --all to see every setting`]),
    ...(listed.some(k => SPECS[k].personal) ? ['  * personal: read only from user, env and cli, never from the project or local file'] : []),
    ...(r.warnings.length ? ['warnings:', ...r.warnings.map(w => `  ! ${w}`)] : []),
    'Change: /q-pilot config set <key> <value> [--scope user|project|local] · unset <key> [--scope …] · explain <key> · reset [--scope …]',
  ].join('\n')
}

/** `/q-pilot config explain <key>`: every scope's value and which one wins. */
export function explainSetting(typedKey: string, r: Resolved): string {
  const key = keyOf(typedKey)
  if (!key) return `Unknown setting "${typedKey}". Settings: ${KEYS.join(', ')}.`
  const src = r.sources[key]
  const held = new Map<string, unknown>([[src.scope, r.values[key]], ...src.overridden.map(o => [o.scope, o.value] as [string, unknown])])
  const rows = [...SCOPES, 'default' as const].map(scope => {
    const value = scope === 'default' ? DEFAULT_SETTINGS[key] : held.get(scope)
    const text = scope === 'default' || held.has(scope) ? shown(value) : '-'
    return `  ${scope.padEnd(8)} ${text.padEnd(14)} ${scope === src.scope ? '<- wins' : ''}`.trimEnd()
  })
  return [`${key}: ${shown(r.values[key])} (${src.scope})`, `  ${SPECS[key].help} (${valuesOf(key)})`, ...(SPECS[key].personal ? ['  personal: only user, env and cli are read'] : []), ...rows, ...(ENV_VARS[key] ? [`  env variable: ${ENV_VARS[key]}`] : [])].join('\n')
}

// ---- rows for the Dashboard's Settings page ------------------------------------------------------------

/** The Settings page's sections. */
const GROUPS: Record<Key, 'Runs' | 'Jev vision' | 'Helper' | 'Dashboard' | 'Browser' | 'Flows'> = {
  helper: 'Helper',
  vision: 'Jev vision',
  visionModel: 'Jev vision',
  box: 'Jev vision',
  inspector: 'Dashboard',
  dashboard: 'Dashboard',
  dashboardWindow: 'Dashboard',
  mode: 'Flows',
  cdpUrl: 'Browser',
  node: 'Browser',
  trust: 'Flows',
  followUp: 'Flows',
  maxStopSeconds: 'Flows',
  maxTestSeconds: 'Runs',
  maxTaskSeconds: 'Runs',
}

/** One setting as the Settings page shows it: the effective value, where it came from, and how it may be changed. */
export type Row = {
  key: string
  value: unknown
  source: Scope | 'default'
  overridden: { scope: string; value: unknown }[]
  help: string
  kind: 'enum' | 'bool' | 'string' | 'number' | 'list'
  options?: string[]
  scopes: WriteScope[]
  personal: boolean
  group: (typeof GROUPS)[Key]
}

export function settingRows(r: Resolved): Row[] {
  return KEYS.map(k => {
    const spec = SPECS[k]
    return {
      key: k,
      value: r.values[k],
      source: r.sources[k].scope,
      overridden: r.sources[k].overridden,
      help: spec.help,
      kind: spec.kind,
      ...(spec.kind === 'enum' ? { options: [...spec.values] } : spec.kind === 'bool' ? { options: ['on', 'off'] } : {}),
      scopes: spec.personal ? ['user'] : [...WRITE_SCOPES],
      personal: spec.personal === true,
      group: GROUPS[k],
    }
  })
}
