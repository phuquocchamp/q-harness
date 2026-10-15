// Jev requests and answers for q-advisor: pure builders and parsers, the caller does the fetch.
// API: POST JEV_URL {model, state, questions} → {answers: {<id>: {choice, confidence, probabilities} | {noul}}}
import type { Candidate, Recent, Relation, TaskSize } from './contract'

export const JEV_URL = 'https://api.typesafe.ai/v1/systemone'
export const DEFAULT_JEV_MODEL = 'jev-latest'
export const RELATIONS: readonly Relation[] = ['continuation', 'new-task', 'side-question']
export const SIZES: readonly TaskSize[] = ['trivial', 'routine', 'deep']

/** Label descriptions, also used as the Haiku classify fallback's labels. Wording validated live against Jev. */
export const RELATION_TEXT: Record<Relation, string> = {
  continuation: 'The new prompt continues or extends the work of the recent turns (same goal, same files or the same pattern applied again).',
  'new-task': 'The new prompt starts unrelated work with a different goal; the recent history would not help and would distract.',
  'side-question': 'A quick question or aside unrelated to the current work, after which the user will return to the current task.',
}
export const SIZE_TEXT: Record<TaskSize, string> = {
  trivial: 'A rename, typo, formatting, one-line change or short factual question.',
  routine: 'A well-scoped feature, test or bug fix in known code with a clear cause.',
  deep: 'Architecture, design trade-offs, an unclear bug, a large multi-step refactor, a security review or a plan.',
}

const RELATION_QUESTION = { type: 'choice', instructions: 'A developer is working with a coding agent. Classify how new_prompt relates to recent_work.', criteria: RELATION_TEXT }
const SIZE_QUESTION = { type: 'choice', instructions: 'Classify the size and difficulty of the task in new_prompt.', criteria: SIZE_TEXT }
const FINISHED_QUESTION = { type: 'noul', instructions: 'Was the task in recent_work finished when last_reply was written (done, verified, nothing left open)?' }
const KEEP_CRITERIA = {
  true: 'The agent will need it to do remaining_work correctly or to respect what the user decided or still has to answer.',
  false: 'Raw output, abandoned attempts or unrelated asides that the remaining work does not depend on.',
}

const CAP = { recentWork: 1500, lastReply: 1200, newPrompt: 1500, item: 400, todoState: 400, toolErrors: 400, remainingWork: 1500 }

// redact and validateChoice port jev-ultrafast's validate_choice and the redaction rules q-pilot's runner/redact.mjs also uses.
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

const trimTo = (s: string, max: number) => (s.length <= max ? s : `${s.slice(0, max)}…[truncated ${s.length - max} chars]`)

const recentState = (recent: Recent, secrets?: string[]) => {
  const f = (s: string, max: number) => trimTo(redact(s, secrets), max)
  return {
    recent_work: f(recent.recentWork, CAP.recentWork),
    last_reply: f(recent.lastReply, CAP.lastReply),
    todo_state: f(recent.todoState, CAP.todoState),
    tool_errors: f(recent.toolErrors, CAP.toolErrors),
  }
}

/** Body for the prompt.submit judgement: questions `relation` (choice) and `size` (choice). */
export function promptRequest(input: { recent: Recent; newPrompt: string; model?: string; secrets?: string[] }): string {
  const state = { ...recentState(input.recent, input.secrets), new_prompt: trimTo(redact(input.newPrompt, input.secrets), CAP.newPrompt) }
  return JSON.stringify({ model: input.model ?? DEFAULT_JEV_MODEL, state, questions: { relation: RELATION_QUESTION, size: SIZE_QUESTION } })
}

/** Body for the turn-end judgement: question `finished` (noul). */
export function finishedRequest(input: { recent: Recent; model?: string; secrets?: string[] }): string {
  return JSON.stringify({ model: input.model ?? DEFAULT_JEV_MODEL, state: recentState(input.recent, input.secrets), questions: { finished: FINISHED_QUESTION } })
}

/** Body for keep-scoring: one noul (with true/false criteria) per candidate, each candidate a state field `item_<id>`. Criteria are mandatory: without them Jev fails. */
export function keepRequest(input: { remainingWork: string; candidates: Candidate[]; model?: string; secrets?: string[] }): string {
  const state: Record<string, string> = { remaining_work: trimTo(redact(input.remainingWork, input.secrets), CAP.remainingWork) }
  const questions: Record<string, unknown> = {}
  for (const c of input.candidates) {
    state[`item_${c.id}`] = trimTo(redact(c.text, input.secrets), CAP.item)
    questions[c.id] = {
      type: 'noul',
      instructions: `Should item_${c.id} be kept in the agent's memory after the conversation is summarized, given remaining_work?`,
      criteria: KEEP_CRITERIA,
    }
  }
  return JSON.stringify({ model: input.model ?? DEFAULT_JEV_MODEL, state, questions })
}

const answersOf = (responseText: string): Record<string, unknown> | undefined => {
  let data: unknown
  try {
    data = JSON.parse(responseText)
  } catch {
    return undefined
  }
  const answers = (data as { answers?: unknown } | null)?.answers
  return answers && typeof answers === 'object' ? (answers as Record<string, unknown>) : undefined
}

const noulOf = (answer: unknown): number | undefined => {
  const n = (answer as { noul?: unknown } | null | undefined)?.noul
  return isProb(n) ? n : undefined
}

const labelOf = <T extends string>(answer: unknown, ids: readonly T[]): { label: T; p: number } | undefined =>
  validateChoice(answer, ids) ? { label: answer.choice as T, p: answer.probabilities[answer.choice]! } : undefined

/** Parses a promptRequest answer; undefined when the response is not valid. A single invalid question is dropped, not fatal. */
export function parsePrompt(responseText: string): { relation?: { label: Relation; p: number }; size?: { label: TaskSize; p: number } } | undefined {
  const answers = answersOf(responseText)
  if (!answers) return undefined
  const relation = labelOf(answers.relation, RELATIONS)
  const size = labelOf(answers.size, SIZES)
  if (!relation && !size) return undefined
  return { ...(relation && { relation }), ...(size && { size }) }
}

/** Parses a finishedRequest answer: the noul in 0..1, or undefined. */
export function parseFinished(responseText: string): number | undefined {
  return noulOf(answersOf(responseText)?.finished)
}

/** Parses a keepRequest answer: noul per candidate id; undefined when any id is missing or invalid. */
export function parseKeep(responseText: string, ids: readonly string[]): Record<string, number> | undefined {
  const answers = answersOf(responseText)
  if (!answers) return undefined
  const out: Record<string, number> = {}
  for (const id of ids) {
    const n = noulOf(answers[id])
    if (n === undefined) return undefined
    out[id] = n
  }
  return out
}
