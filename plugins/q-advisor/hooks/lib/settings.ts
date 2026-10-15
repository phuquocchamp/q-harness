// Settings resolution: defaults < plugin options < overrides stored by /q-advisor commands. Pure.
import type { AdviceKind, Mode, Settings, Thresholds } from './contract'
import { ADVICE_KINDS } from './contract'

export const DEFAULT_SETTINGS: Settings = {
  mode: 'shadow',
  focusCompact: true,
  jev: true,
  jevModel: 'jev-latest',
  compactAt: 60,
  urgentAt: 80,
  focusAt: 70,
  newTaskAt: 30,
  freshAfter: 3,
  rateLimitAt: 80,
  quietTurns: 3,
  minPromptChars: 25,
  thresholds: { relation: 0.9, size: 0.7, finished: 0.7, keep: 0.5 },
  muted: [],
}

const MODES: Mode[] = ['shadow', 'on', 'off']
const NUMBER_RANGES: Record<string, [number, number]> = {
  compactAt: [1, 99],
  urgentAt: [1, 99],
  focusAt: [1, 99],
  newTaskAt: [1, 99],
  rateLimitAt: [1, 99],
  freshAfter: [1, 20],
  quietTurns: [0, 20],
  minPromptChars: [0, 500],
}
const THRESHOLD_KEYS = ['relation', 'size', 'finished', 'keep'] as const
const THRESHOLD_RANGE: [number, number] = [0.5, 0.99]

const inRange = (v: unknown, [lo, hi]: [number, number]): v is number => typeof v === 'number' && Number.isFinite(v) && v >= lo && v <= hi
const onOff = (v: unknown): boolean | undefined => (v === 'on' || v === true ? true : v === 'off' || v === false ? false : undefined)

/** Writes the valid entries of `source` into `out`; records which keys were set in `from`. */
function layer(out: Settings, source: Record<string, unknown>, from: Record<string, string>, label: string): void {
  const set = (key: string, apply: () => void) => {
    apply()
    from[key] = label
  }
  if (typeof source.mode === 'string' && MODES.includes(source.mode as Mode)) set('mode', () => (out.mode = source.mode as Mode))
  const fc = onOff(source.focusCompact)
  if (fc !== undefined) set('focusCompact', () => (out.focusCompact = fc))
  const jev = onOff(source.jev)
  if (jev !== undefined) set('jev', () => (out.jev = jev))
  if (typeof source.jevModel === 'string' && source.jevModel.trim()) set('jevModel', () => (out.jevModel = (source.jevModel as string).trim()))
  for (const [key, range] of Object.entries(NUMBER_RANGES)) {
    const v = source[key]
    if (inRange(v, range)) set(key, () => ((out as unknown as Record<string, number>)[key] = v))
  }
  const nested = source.thresholds && typeof source.thresholds === 'object' ? (source.thresholds as Record<string, unknown>) : {}
  for (const t of THRESHOLD_KEYS) {
    const v = source[`thresholds.${t}`] ?? nested[t]
    if (inRange(v, THRESHOLD_RANGE)) set(`thresholds.${t}`, () => (out.thresholds[t] = v))
  }
  if (Array.isArray(source.muted)) {
    const muted = source.muted.filter((k): k is AdviceKind => ADVICE_KINDS.includes(k as AdviceKind))
    set('muted', () => (out.muted = [...new Set(muted)]))
  }
}

const fresh = (): Settings => ({ ...DEFAULT_SETTINGS, thresholds: { ...DEFAULT_SETTINGS.thresholds }, muted: [] })

function resolve(options: Record<string, unknown>, overrides: Record<string, unknown>): { settings: Settings; from: Record<string, string> } {
  const settings = fresh()
  const from: Record<string, string> = {}
  layer(settings, options, from, 'option')
  layer(settings, overrides, from, 'override')
  return { settings, from }
}

/** Settings from plugin options (mode, focusCompact) and stored overrides (/q-advisor config); unknown keys and bad values ignored. */
export function resolveSettings(options: Record<string, unknown>, overrides: Record<string, unknown>): Settings {
  return resolve(options, overrides).settings
}

const VALID_KEYS = [...Object.keys(NUMBER_RANGES), 'jev', 'jevModel', 'focusCompact', ...THRESHOLD_KEYS.map(t => `thresholds.${t}`)]

/** Applies `/q-advisor config <key> <value>` to the overrides; returns the new overrides and a one-line message (or an error message and the same overrides). */
export function applyConfig(overrides: Record<string, unknown>, key: string, value: string): { overrides: Record<string, unknown>; message: string } {
  const fail = (why: string) => ({ overrides, message: `${why}. Keys: ${VALID_KEYS.join(', ')}` })
  if (!VALID_KEYS.includes(key)) return fail(`Unknown key "${key}"`)
  const v = value.trim()
  if (v === 'reset') {
    const next = { ...overrides }
    delete next[key]
    if (key.startsWith('thresholds.') && next.thresholds && typeof next.thresholds === 'object') {
      const { [key.slice('thresholds.'.length)]: _drop, ...rest } = next.thresholds as Record<string, unknown>
      next.thresholds = rest
    }
    return { overrides: next, message: `${key} reset to default` }
  }
  let parsed: unknown
  if (key === 'jev' || key === 'focusCompact') {
    parsed = onOff(v)
    if (parsed === undefined) return fail(`${key} must be on or off`)
  } else if (key === 'jevModel') {
    if (!v) return fail('jevModel must not be empty')
    parsed = v
  } else {
    const range = key.startsWith('thresholds.') ? THRESHOLD_RANGE : NUMBER_RANGES[key]!
    const n = v === '' ? NaN : Number(v)
    if (!inRange(n, range)) return fail(`${key} must be a number from ${range[0]} to ${range[1]}`)
    parsed = n
  }
  const next = { ...overrides }
  next[key] = parsed
  return { overrides: next, message: `${key} set to ${typeof parsed === 'boolean' ? (parsed ? 'on' : 'off') : parsed}` }
}

/** Lists every setting with its value and where it came from (default / option / override). */
export function showSettings(options: Record<string, unknown>, overrides: Record<string, unknown>): string {
  const { settings: s, from } = resolve(options, overrides)
  const rows: [string, string][] = [
    ['mode', s.mode],
    ['focusCompact', s.focusCompact ? 'on' : 'off'],
    ['jev', s.jev ? 'on' : 'off'],
    ['jevModel', s.jevModel],
    ...Object.keys(NUMBER_RANGES).map((k): [string, string] => [k, String((s as unknown as Record<string, number>)[k])]),
    ...THRESHOLD_KEYS.map((t): [string, string] => [`thresholds.${t}`, String(s.thresholds[t as keyof Thresholds])]),
    ['muted', s.muted.length ? s.muted.join(', ') : 'none'],
  ]
  return rows.map(([k, v]) => `${k} ${v} (${from[k] ?? 'default'})`).join('\n')
}
