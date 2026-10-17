// Pure readers of the conversation: what the last turns were about and what must survive a compaction.
import type { Candidate, Msg, Recent } from './contract'

const ACK_WORDS = new Set([
  'ok', 'okay', 'yes', 'yep', 'yeah', 'no', 'nope', 'thanks', 'thank', 'thx', 'you', 'continue', 'go', 'on', 'ahead',
  'next', 'lgtm', 'do', 'it', 'sounds', 'good', 'hmm', 'sure', 'great', 'cool', 'perfect', 'proceed', 'please', 'fine', 'done',
])
const MAX_CANDIDATES = 12
const MAX_CANDIDATE_CHARS = 400
const MAX_DECISIONS = 5
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const DECISION = /^(let'?s (go with|use|do)|use |don'?t |do not |keep |we'?ll |we will |approved\b|yes,? (do|go|use)\b|go with |stick with |always |never |prefer )/i
const PLAN_TEXT = /^\s*(##\s*)?plan\b/i
// The assistant's own intent only: first person, or a labelled next step. Never a third-person description ("It then submits…").
const NEXT_INTENT = /\b(i'll|i will|i'm going to|let me|i still need to)\b|^(next( step)?s?|remaining|todo)\s*[:,](?!\s*(it|the|this|that|they|he|she|we)\b)/i
const NO_OPEN_WORK = 'No open work; the last task looks finished.'

function clip(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max - 1) + '…'
}

/** Tail-biased clip: the end of a reply usually holds the state. */
function clipTail(text: string, max: number): string {
  return text.length <= max ? text : '…' + text.slice(text.length - max + 1)
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map(oneLine).filter(Boolean)
}

function firstSentence(text: string): string {
  return sentences(text)[0] ?? ''
}

function userText(m: Msg): string {
  return m.role === 'user' ? m.text.trim() : ''
}

interface Todo { content: string; status: string }

function latestTodos(messages: Msg[]): Todo[] | null {
  for (const m of [...messages].reverse()) {
    for (const u of [...m.toolUses].reverse()) {
      if (u.tool !== 'TodoWrite') continue
      const todos = u.input.todos
      if (!Array.isArray(todos)) return []
      return todos.map((t: any) => ({ content: oneLine(String(t?.content ?? t?.subject ?? '')), status: String(t?.status ?? 'pending') })).filter((t) => t.content)
    }
  }
  return null
}

function openTodos(messages: Msg[]): Todo[] {
  return (latestTodos(messages) ?? []).filter((t) => t.status !== 'completed')
}

/** True for prompts never worth classifying: slash commands, shorter than minChars, or acknowledgements ("ok", "continue", "thanks"). */
export function isTrivialPrompt(text: string, minChars: number): boolean {
  const t = text.trim()
  if (t.startsWith('/') || t.length < minChars) return true
  const words = t.toLowerCase().replace(/[^a-z0-9'\s]/g, ' ').split(/\s+/).filter(Boolean)
  return words.length === 0 || (words.length <= 4 && words.every((w) => ACK_WORDS.has(w)))
}

/** Condenses the last messages into Jev state fields, each capped (recentWork ≤ 1500, lastReply ≤ 1200 chars). */
export function summarizeRecent(messages: Msg[]): Recent {
  const lines = messages.slice(-6).map((m) => {
    if (m.role === 'user') return m.text.trim() ? `User: ${clip(oneLine(m.text), 200)}` : ''
    const tools = m.toolUses.map((u) => {
      const path = u.input.file_path ?? u.input.notebook_path
      return typeof path === 'string' ? `${u.tool} ${path}` : u.tool
    })
    const say = firstSentence(m.text)
    return [say && `Assistant: ${clip(say, 200)}`, tools.length > 0 && `[tools: ${tools.join(', ')}]`].filter(Boolean).join(' ')
  })
  const lastAssistant = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim())

  const todos = latestTodos(messages)
  let todoState = 'none'
  if (todos && todos.length > 0) {
    const open = todos.filter((t) => t.status !== 'completed')
    todoState = open.length === 0 ? 'all completed' : `${open.length} of ${todos.length} open: ${open.slice(0, 3).map((t) => clip(t.content, 60)).join('; ')}`
  }

  return {
    recentWork: clipTail(lines.filter(Boolean).join('\n'), 1500),
    lastReply: lastAssistant ? clipTail(lastAssistant.text.trim(), 1200) : '',
    todoState,
    toolErrors: toolErrors(messages),
  }
}

function toolErrors(messages: Msg[]): string {
  const lastUser = messages.findLastIndex((m) => userText(m) !== '')
  const start = lastUser + 1
  const names: string[] = []
  let resultErrors = 0
  for (const m of messages.slice(start)) {
    for (const u of m.toolUses) if (u.isError && !names.includes(u.tool)) names.push(u.tool)
    resultErrors += (m.toolResults ?? []).filter((r) => r.isError).length
  }
  const uses = messages.slice(start).reduce((n, m) => n + m.toolUses.filter((u) => u.isError).length, 0)
  const count = Math.max(uses, resultErrors)
  if (count === 0) return 'none'
  return `${count} tool error${count > 1 ? 's' : ''}${names.length > 0 ? ': ' + names.join(', ') : ''}`
}

/** Candidate items that may need to survive a compaction: plan (ExitPlanMode input / "Plan:" text), user decisions, changed files (Write/Edit/MultiEdit/NotebookEdit paths), open questions (AskUserQuestion, a last reply ending in "?"), latest todos (TodoWrite), the goal (first substantial user prompt). At most 12, each ≤ 400 chars. */
export function extractCandidates(messages: Msg[]): Candidate[] {
  const found: Omit<Candidate, 'id'>[] = []
  const add = (kind: Candidate['kind'], text: string) => {
    if (text.trim()) found.push({ kind, text: clip(text.trim(), MAX_CANDIDATE_CHARS) })
  }

  const goalIndex = messages.findIndex((m) => userText(m).length >= 40 && !userText(m).startsWith('/'))
  const goal = messages[goalIndex]
  if (goal) add('goal', oneLine(goal.text))

  const plan = latestPlan(messages)
  if (plan) add('plan', plan)

  const decisions: string[] = []
  messages.forEach((m, i) => {
    if (i === goalIndex || !userText(m)) return
    for (const s of sentences(m.text)) if (s.length >= 8 && DECISION.test(s)) decisions.push(s)
  })
  for (const d of decisions.slice(-MAX_DECISIONS)) add('decision', d)

  const files: string[] = []
  for (const m of messages) {
    for (const u of m.toolUses) {
      if (!EDIT_TOOLS.has(u.tool)) continue
      const path = u.input.file_path ?? u.input.notebook_path
      if (typeof path === 'string' && !files.includes(path)) files.push(path)
    }
  }
  if (files.length > 0) add('files', `Changed files: ${files.join(', ')}`)

  const open = openTodos(messages)
  if (open.length > 0) add('todo', `Open todos: ${open.map((t) => t.content).join('; ')}`)

  const question = openQuestion(messages)
  if (question) add('open-question', question)

  return found.slice(0, MAX_CANDIDATES).map((c, i) => ({ id: `c${i + 1}`, ...c }))
}

function latestPlan(messages: Msg[]): string {
  for (const m of [...messages].reverse()) {
    if (m.role !== 'assistant') continue
    for (const u of [...m.toolUses].reverse()) {
      if (u.tool === 'ExitPlanMode' && typeof u.input.plan === 'string' && u.input.plan.trim()) return u.input.plan
    }
    if (PLAN_TEXT.test(m.text)) return m.text
  }
  return ''
}

/** A question is open only when it is the last thing said: any later message answers it. */
function openQuestion(messages: Msg[]): string {
  const last = messages[messages.length - 1]
  if (!last || last.role !== 'assistant') return ''
  for (const u of last.toolUses) {
    if (u.tool !== 'AskUserQuestion' || !Array.isArray(u.input.questions)) continue
    const qs = u.input.questions.map((q: any) => (typeof q === 'string' ? q : String(q?.question ?? ''))).filter(Boolean)
    if (qs.length > 0) return qs.join(' ')
  }
  const text = last.text.trim()
  return text.endsWith('?') ? (sentences(text).slice(-2).join(' ')) : ''
}

/** One or two sentences: what is left to do (open todos, else the assistant's own stated next step, else "no open work"). */
export function remainingWork(messages: Msg[]): string {
  const open = openTodos(messages)
  if (open.length > 0) return clip(`Open todos: ${open.map((t) => t.content).join('; ')}.`, MAX_CANDIDATE_CHARS)

  const reply = [...messages].reverse().find((m) => m.role === 'assistant' && m.text.trim())
  const next = reply ? sentences(reply.text).filter((s) => NEXT_INTENT.test(s)).pop() : undefined
  if (next) return clip(next, MAX_CANDIDATE_CHARS)

  return NO_OPEN_WORK
}

/** Rules-only keep decision when Jev is unavailable: keep plan, decision, files, open-question, todo, goal kinds. */
export function keepByRules(candidates: Candidate[]): string[] {
  const keep = new Set<Candidate['kind']>(['plan', 'decision', 'files', 'open-question', 'todo', 'goal'])
  return candidates.filter((c) => keep.has(c.kind)).map((c) => c.id)
}
