// Jev triage: the request body, the response check (a port of jev-ultrafast's validate_choice) and secret redaction.
// API: POST JEV_URL {model, state, questions} → {model, answers: {label: {type, choice, confidence, probabilities}, touched: {type: 'noul', noul}}, usage}

import type { SpecResult, TriageLabel, TriageVerdict } from './contract'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'

export const TRIAGE_LABELS: TriageLabel[] = ['flaky', 'test-drift', 'app-bug', 'env-auth']

/** Label descriptions; also used as the $.model.classify fallback labels. Wording validated live against Jev. */
export const HAIKU_LABEL_TEXT: Record<TriageLabel, string> = {
  flaky: 'Timing or nondeterminism: passes on retry, or the expected element is actually present.',
  'test-drift': "The app changed on purpose (renamed text, moved element) and the test's locator or expectation is outdated.",
  'app-bug': 'The application behaves incorrectly; the test expectation is right.',
  'env-auth': 'Environment problem: server not running, network refused, login/session expired.',
}

export const TRIAGE_QUESTIONS = {
  label: {
    type: 'choice',
    instructions: 'A Playwright end-to-end test failed. Classify the most likely cause of the failure.',
    criteria: HAIKU_LABEL_TEXT,
  },
  touched: {
    type: 'noul',
    instructions: 'Did the code change in turn_diff touch the feature this failing test exercises?',
  },
} as const

export const REDACTED = '[redacted]'
const MIN_SECRET = 4

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

// Bounded affixes keep long word runs (minified code, base64) from backtracking quadratically.
const SECRET_KEY = '[\\w.-]{0,40}(?:password|passwd|pwd|passcode|token|secret|api[_-]?key|apikey|access[_-]?key|session[_-]?id|totp|credential)[\\w.-]{0,40}'

const RULES: [RegExp, string][] = [
  // Header lines: `Cookie: a=b; c=d`, `set-cookie: ...`, `Authorization: Bearer x`, `x-api-key: k`.
  // A diff or quote prefix (`+`, `-`, `>`) is allowed so changed header lines in turn_diff are caught too.
  [/^([+\-\s>*]*(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\s*:\s*).+$/gim, `$1${REDACTED}`],
  // The same headers as JSON or object entries: `"cookie": "..."`, `Authorization: 'Bearer x'`.
  [/((["']?)(?:set-cookie|cookie|authorization|proxy-authorization|x-api-key|api-key|x-auth-token)\2\s*[:=]\s*)(["'`])(?:(?!\3)[^\\]|\\.)*\3/gi, `$1$3${REDACTED}$3`],
  // Only credential-looking values (8+ chars with a digit), so "Token expired" and "Basic plan" survive.
  [/\b(Bearer|Basic|Token)\s+(?=[A-Za-z0-9\-._~+/]*\d)[A-Za-z0-9\-._~+/]{8,}=*/gi, `$1 ${REDACTED}`],
  // JSON-ish secret fields: `"password": "hunter2"`, `password: 'x'`.
  [new RegExp(`((["']?)${SECRET_KEY}\\2\\s*:\\s*)(["'\`])(?:(?!\\3)[^\\\\]|\\\\.)*\\3`, 'gi'), `$1$3${REDACTED}$3`],
  // Query or form values: `password=x`, `?token=x&`.
  [new RegExp(`\\b(${SECRET_KEY})=([^&\\s"'\`#;,)]+)`, 'gi'), `$1=${REDACTED}`],
  // JWTs.
  [/\beyJ[\w-]+\.[\w-]+\.[\w-]*/g, REDACTED],
]

/** Replaces cookies, Authorization/Bearer values, password/token/secret values, JWTs and the exact `extraSecrets` with "[redacted]". */
export function redact(text: string, extraSecrets: string[] = []): string {
  let out = text
  const secrets = [...new Set(extraSecrets.filter(s => typeof s === 'string' && s.length >= MIN_SECRET))].sort((a, b) => b.length - a.length)
  for (const s of secrets) out = out.replace(new RegExp(escapeRegExp(s), 'g'), REDACTED)
  for (const [re, to] of RULES) out = out.replace(re, to)
  return out
}

/** The aria snapshot block from error-context.md ("# Page snapshot" + yaml fence); the whole text when there is none. */
export function extractAriaSnapshot(errorContext: string): string {
  const m = /#+\s*Page snapshot\s*\n+```(?:ya?ml)?\n([\s\S]*?)```/i.exec(errorContext)
  return (m ? m[1]! : errorContext).trim()
}

/** Wording of the retry history as validated in the live probe, e.g. "failed 2 of 2 runs". */
export function retriesText(spec: Pick<SpecResult, 'status' | 'retries'>): string {
  const runs = spec.retries + 1
  if (spec.status === 'flaky') return `failed ${spec.retries} of ${runs} runs, passed on retry`
  return `failed ${runs} of ${runs} runs`
}

export const STATE_BUDGET = 24_000

const trimTo = (s: string, max: number) =>
  s.length <= max ? s : `${s.slice(0, Math.max(0, max - 40))}\n…[truncated ${s.length - Math.max(0, max - 40)} chars]`

/** The JSON body for one red spec. Redacts first, then trims turn_diff, then aria_snapshot, so the state stays near 24k chars. */
export function triageRequest(input: {
  spec: SpecResult
  errorContext?: string
  turnDiff?: string
  model?: string
  secrets?: string[]
}): string {
  const r = (s: string) => redact(s, input.secrets)
  const { spec } = input
  const head = spec.file ? `${spec.file}:${spec.line}` : '(run)'
  const state = {
    spec: r(spec.title ? `${head} › ${spec.title}` : head),
    error: r(spec.error ?? '(no error message)'),
    aria_snapshot: r(input.errorContext ? extractAriaSnapshot(input.errorContext) : '(none)'),
    turn_diff: r(input.turnDiff?.trim() || '(no diff this turn)'),
    retries: retriesText(spec),
  }
  const fixed = state.spec.length + state.error.length + state.retries.length
  let room = Math.max(0, STATE_BUDGET - fixed)
  const aria = Math.min(state.aria_snapshot.length, Math.max(room - state.turn_diff.length, Math.floor(room / 2)))
  state.aria_snapshot = trimTo(state.aria_snapshot, aria)
  room -= state.aria_snapshot.length
  state.turn_diff = trimTo(state.turn_diff, Math.max(room, 200))
  return JSON.stringify({ model: input.model ?? DEFAULT_JEV_MODEL, state, questions: TRIAGE_QUESTIONS })
}

const isProb = (n: unknown): n is number => typeof n === 'number' && Number.isFinite(n) && n >= 0 && n <= 1

/** Port of validate_choice: choice in ids, probability keys == ids, all numbers finite in 0..1, sum ≈ 1 ± 0.02, choice is the argmax. */
export function validateChoice(answer: unknown, ids: readonly string[]): answer is { choice: string; confidence: number; probabilities: Record<string, number> } {
  if (!answer || typeof answer !== 'object') return false
  const a = answer as { choice?: unknown; confidence?: unknown; probabilities?: unknown }
  const probs = a.probabilities
  if (!probs || typeof probs !== 'object' || Array.isArray(probs)) return false
  const p = probs as Record<string, unknown>
  const keys = Object.keys(p)
  if (typeof a.choice !== 'string' || !ids.includes(a.choice)) return false
  if (keys.length !== ids.length || !ids.every(id => keys.includes(id))) return false
  const values = keys.map(k => p[k])
  if (![...values, a.confidence].every(isProb)) return false
  const nums = values as number[]
  if (Math.abs(nums.reduce((s, n) => s + n, 0) - 1) >= 0.02) return false
  return (p[a.choice] as number) >= Math.max(...nums) - 1e-6
}

/** Parses a Jev response into a verdict, or undefined when it is not valid. An invalid `touched` answer is dropped, not fatal. */
export function parseTriage(responseText: string): TriageVerdict | undefined {
  let data: unknown
  try {
    data = JSON.parse(responseText)
  } catch {
    return undefined
  }
  const answers = (data as { answers?: Record<string, unknown> } | null)?.answers
  if (!answers || typeof answers !== 'object') return undefined
  const label = answers.label
  if (!validateChoice(label, TRIAGE_LABELS)) return undefined
  const probabilities: Partial<Record<TriageLabel, number>> = {}
  for (const l of TRIAGE_LABELS) probabilities[l] = label.probabilities[l]
  const verdict: TriageVerdict = { label: label.choice as TriageLabel, p: label.probabilities[label.choice]!, probabilities, source: 'jev' }
  const touched = answers.touched as { type?: unknown; noul?: unknown } | undefined
  if (touched && touched.type === 'noul' && isProb(touched.noul)) verdict.touched = touched.noul
  return verdict
}
