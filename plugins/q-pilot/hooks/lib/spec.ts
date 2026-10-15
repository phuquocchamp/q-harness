// Prompt-mode spec: what Claude passes to pilot_test. Pure.

const NAME = /^[a-z0-9-]+$/
const KEYS = ['name', 'baseURL', 'start', 'goal', 'fixtures', 'checks', 'softChecks', 'budget'] as const
const MAX_SOFT = 5
/** A path on the base origin: never `//host` or `/\\host`. */
const START = /^\/(?![/\\])/

export type Spec = Record<(typeof KEYS)[number], unknown>

/** Picks the spec's keys out of a tool call's arguments and checks what the mod can check before the runner does. */
export function validateSpec(input: Record<string, unknown>): { spec: Spec } | { error: string } {
  const spec: Record<string, unknown> = {}
  for (const k of KEYS) if (input[k] !== undefined) spec[k] = input[k]
  if (spec.name !== undefined && (typeof spec.name !== 'string' || !NAME.test(spec.name))) return { error: 'name must match [a-z0-9-]+' }
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) return { error: 'goal is required: the task in plain words, ending with when to stop' }
  if (spec.start !== undefined && (typeof spec.start !== 'string' || !START.test(spec.start))) return { error: 'start must be a path on the app\'s own origin: it begins with a single / (not // or /\\)' }
  if (!Array.isArray(spec.checks) || spec.checks.length === 0) return { error: 'checks must be a non-empty array: the pass or fail comes from them' }
  if (spec.checks.some(c => !c || typeof c !== 'object' || Array.isArray(c))) return { error: 'every check must be an object such as { "testid": "total", "text": "€12.00" }' }
  if (spec.softChecks !== undefined && (!Array.isArray(spec.softChecks) || spec.softChecks.length > MAX_SOFT || spec.softChecks.some(q => typeof q !== 'string'))) {
    return { error: `softChecks must be at most ${MAX_SOFT} yes/no questions` }
  }
  if (spec.fixtures !== undefined && (!spec.fixtures || typeof spec.fixtures !== 'object' || Array.isArray(spec.fixtures))) return { error: 'fixtures must be an object of key to value' }
  return { spec: spec as Spec }
}

const TASK_KEYS = ['name', 'url', 'baseURL', 'start', 'goal', 'fixtures', 'checks', 'softChecks', 'budget'] as const
export type TaskSpec = Record<(typeof TASK_KEYS)[number], unknown>

/** Task mode (pilot_run): any browser task. Like a spec, but `url` may be a full http(s) URL and checks are optional. */
export function validateTask(input: Record<string, unknown>): { spec: TaskSpec } | { error: string } {
  const spec: Record<string, unknown> = {}
  for (const k of TASK_KEYS) if (input[k] !== undefined) spec[k] = input[k]
  if (spec.name !== undefined && (typeof spec.name !== 'string' || !NAME.test(spec.name))) return { error: 'name must match [a-z0-9-]+' }
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) return { error: 'goal is required: the task in plain words, ending with when to stop' }
  if (spec.url !== undefined && (typeof spec.url !== 'string' || !/^https?:\/\//i.test(spec.url))) return { error: 'url must be a full http(s) URL, e.g. https://www.google.com/travel/flights' }
  if (spec.start !== undefined && (typeof spec.start !== 'string' || !START.test(spec.start))) return { error: 'start must be a path on the app\'s own origin: it begins with a single / (not // or /\\)' }
  if (spec.checks !== undefined && (!Array.isArray(spec.checks) || spec.checks.some(c => !c || typeof c !== 'object' || Array.isArray(c)))) {
    return { error: 'checks must be an array of objects such as { "role": "status", "text": "Order confirmed" }' }
  }
  if (spec.softChecks !== undefined && (!Array.isArray(spec.softChecks) || spec.softChecks.length > MAX_SOFT || spec.softChecks.some(q => typeof q !== 'string'))) {
    return { error: `softChecks must be at most ${MAX_SOFT} yes/no questions` }
  }
  if (spec.fixtures !== undefined && (!spec.fixtures || typeof spec.fixtures !== 'object' || Array.isArray(spec.fixtures))) return { error: 'fixtures must be an object of key to value' }
  return { spec: spec as TaskSpec }
}

const HELP_OPS = new Set(['click', 'fill', 'select', 'press', 'scroll', 'wait'])
const HELP_KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'])
const HELP_THEN = new Set(['observe', 'resume', 'done', 'stop'])
const MAX_HELP_ACTIONS = 8
const RUN_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/

export type HelpAnswer = { actions: Record<string, unknown>[]; then: string; note?: string }

/**
 * pilot_help's input: the run it answers and Claude's answer, the same rules the runner checks again (help.mjs
 * parseAnswer). Without `then` and actions it only waits for the run's next event.
 */
export function validateHelp(input: Record<string, unknown>): { runId: string; answer: HelpAnswer | null } | { error: string } {
  const runId = input.runId
  if (typeof runId !== 'string' || !RUN_ID.test(runId)) return { error: 'runId is the run id pilot_run answered (e.g. 20261015-122547-253c)' }
  if (input.then === undefined && input.actions === undefined) return { runId, answer: null }
  const then = input.then ?? 'observe'
  if (typeof then !== 'string' || !HELP_THEN.has(then)) return { error: `then must be one of ${[...HELP_THEN].join(', ')}` }
  const actions = input.actions ?? []
  if (!Array.isArray(actions) || actions.length > MAX_HELP_ACTIONS) return { error: `actions must be an array of at most ${MAX_HELP_ACTIONS}` }
  for (const [i, raw] of actions.entries()) {
    const a = raw as Record<string, unknown>
    if (!a || typeof a !== 'object' || !HELP_OPS.has(a.op as string)) return { error: `actions[${i}].op must be one of ${[...HELP_OPS].join(', ')}` }
    if (['click', 'fill', 'select'].includes(a.op as string) && !Number.isInteger(a.index)) return { error: `actions[${i}].index (an element index from the help request) is required for ${String(a.op)}` }
    if (a.op === 'fill' && typeof a.text !== 'string' && typeof a.fixture !== 'string') return { error: `actions[${i}] needs text, or fixture (a fixture key) for a secret` }
    if (a.op === 'select' && typeof a.option !== 'string') return { error: `actions[${i}].option (the option label) is required for select` }
    if (a.op === 'press' && !HELP_KEYS.has(a.key as string)) return { error: `actions[${i}].key must be one of ${[...HELP_KEYS].join(', ')}` }
    if (a.op === 'scroll' && a.delta !== undefined && typeof a.delta !== 'number') return { error: `actions[${i}].delta must be a number of pixels` }
  }
  const note = typeof input.note === 'string' ? input.note.slice(0, 300) : undefined
  return { runId, answer: { actions: actions as Record<string, unknown>[], then, ...(note && { note }) } }
}
