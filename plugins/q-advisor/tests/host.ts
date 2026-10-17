// Test helpers shared by the q-advisor tests: a fake host (store, clock, session numbers, model, Jev over
// HTTP, commands) and short ways to drive the mod.

import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { AdviceRecord, Decision } from '../hooks/lib/contract'

export const ROOT = '/repo'

type Relation = 'continuation' | 'new-task' | 'side-question'
type Size = 'trivial' | 'routine' | 'deep'

/** What the fake Jev answers; a field left out leaves that question unanswered (an invalid response). */
export type FakeJev = { status: number; relation?: { label: Relation; p: number }; size?: { label: Size; p: number }; finished?: number; keep?: number }

const choiceOf = (labels: readonly string[], label: string, p: number) => {
  const rest = (1 - p) / (labels.length - 1)
  return { type: 'choice', choice: label, confidence: p, probabilities: Object.fromEntries(labels.map(l => [l, l === label ? p : rest])) }
}

const RELATIONS = ['continuation', 'new-task', 'side-question'] as const
const SIZES = ['trivial', 'routine', 'deep'] as const

/** The answer to a Jev request body, for the questions it asks. */
const jevAnswer = (jev: FakeJev, body: string) => {
  const questions = Object.keys((JSON.parse(body) as { questions: Record<string, unknown> }).questions)
  const answers: Record<string, unknown> = {}
  for (const q of questions) {
    if (q === 'relation' && jev.relation) answers.relation = choiceOf(RELATIONS, jev.relation.label, jev.relation.p)
    else if (q === 'size' && jev.size) answers.size = choiceOf(SIZES, jev.size.label, jev.size.p)
    else if (q === 'finished' && jev.finished !== undefined) answers.finished = { type: 'noul', noul: jev.finished }
    else if (/^c\d+$/.test(q) && jev.keep !== undefined) answers[q] = { type: 'noul', noul: jev.keep }
  }
  return JSON.stringify({ answers })
}

type FakeMessage = { role: 'user' | 'assistant'; text: string; toolUses: { tool_use_id: string; tool: string; input: Record<string, unknown> }[] }

/** A short conversation with a goal, so the focus has candidates. */
export const CONVERSATION: FakeMessage[] = [
  { role: 'user', text: 'Add pagination to the orders list and keep the API backwards compatible.', toolUses: [] },
  { role: 'assistant', text: 'Added pagination in orders.ts. Tests are green.', toolUses: [{ tool_use_id: 't1', tool: 'Edit', input: { file_path: `${ROOT}/src/orders.ts` } }] },
]

/**
 * The fake host. `jev` answers the Jev fetch (`'throw'` refuses it; `jevGate` holds the answer until it
 * resolves); `classify` answers Haiku's pick by labels; `complete` is Haiku's text.
 */
export const fakeHost = (on: On) => {
  const store = new Map<string, unknown>()
  const toasts: string[] = []
  const suggested: string[] = []
  const commands: { command: string; args: string }[] = []
  const compactInputs: { trigger: string; agentId?: string; instructions?: string }[] = []
  const fetches: { url: string; headers: Record<string, string>; body: string }[] = []
  const classified: { text: string; labels: readonly string[] }[] = []
  const completes: { prompt: string }[] = []
  const state = new Map<string, unknown>()
  const contexts: (readonly string[] | undefined)[] = []
  const host = {
    store,
    toasts,
    suggested,
    commands,
    compactInputs,
    fetches,
    classified,
    completes,
    /** The last value the mod wrote to each of its state keys (`$.state` itself is not on the test's `$`). */
    state,
    /** The `context` each prompt reached the engine with. */
    contexts,
    /** When set, `session.compact` rejects with this (a turn is running). */
    compactError: undefined as string | undefined,
    env: new Map<string, string>(),
    jev: { status: 200 } as FakeJev | 'throw',
    jevGate: undefined as Promise<void> | undefined,
    classify: undefined as ((labels: readonly string[]) => string | undefined) | 'throw' | undefined,
    complete: 'Keep: the pagination plan and src/orders.ts.' as string | undefined,
    usage: { percent: 20 as number | undefined, tokens: 40_000, five: undefined as number | undefined, usd: 1 },
    model: 'claude-opus-5-5',
    turns: 5,
    messages: CONVERSATION as FakeMessage[],
    /** When set, `$.command.run` for another command rejects with this. */
    commandError: undefined as string | undefined,
    clock: mock.clock(on, { now: 1_000_000 }),
  }

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, JSON.parse(JSON.stringify(e.value)))
    return { value: undefined }
  })
  on('store.delete', (_$, e) => (store.delete(e.key), { value: undefined }))
  on('store.keys', () => ({ value: [...store.keys()] }))
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: host.env.get(e.name) }))

  on('state.set', (_$, e, next) => {
    state.set(e.key, e.value)
    return next(e)
  })

  on('session.usage', () => ({
    value: {
      startedAt: 0,
      context: { window: 200_000, tokens: host.usage.tokens, ...(host.usage.percent !== undefined ? { percent: host.usage.percent } : {}) },
      rateLimits: host.usage.five !== undefined ? [{ kind: 'five_hour', percentUsed: host.usage.five }] : [],
      cost: { usd: host.usage.usd },
    },
  }))
  on('session.model', () => ({ value: host.model }))
  on('session.turns', () => ({ value: host.turns }))
  on('session.messages', () => ({ value: host.messages as never }))

  on('http.fetch', async (_$, e) => {
    fetches.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ?? '' })
    if (host.jevGate) await host.jevGate
    if (host.jev === 'throw') throw new Error('refused by policy')
    const status = host.jev.status
    return { value: { status, ok: status < 400, headers: {}, text: jevAnswer(host.jev, e.init?.body ?? '{"questions":{}}') } }
  })
  on('model.classify', (_$, e) => {
    classified.push({ text: e.text, labels: e.labels })
    if (host.classify === 'throw') throw new Error('model unavailable')
    return { value: host.classify?.(e.labels) }
  })
  on('model.complete', (_$, e) => {
    completes.push({ prompt: String(e.prompt) })
    const usage = { input_tokens: 1, output_tokens: 1, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 }
    return { value: host.complete === undefined ? { isAnswered: false as const, reason: 'empty-reply' as const, usage } : { isAnswered: true as const, text: host.complete, usage } } as never
  })

  on('command.run', (_$, e) => {
    commands.push({ command: e.command, args: e.args })
    // A hook that throws is skipped, and with nothing beneath it the call rejects.
    if (host.commandError) throw new Error(host.commandError)
    return { text: '' }
  })
  on('session.compact', (_$, e) => {
    if (host.compactError) throw new Error(host.compactError)
    compactInputs.push({ trigger: e.trigger, ...(e.agentId ? { agentId: e.agentId } : {}), ...(e.instructions !== undefined ? { instructions: e.instructions } : {}) })
    return { messages: [{ role: 'assistant' as const, text: 'summary', toolUses: [] }] }
  })
  // The engine's own band: nothing.
  on('ui.render', () => ({ type: 'Box', props: {} }) as never)
  on('prompt.suggest', (_$, e) => (suggested.push(e.text), { isShown: true }))
  on('prompt.submit', (_$, e) => (contexts.push(e.context), { text: e.text, ...(e.context ? { context: e.context } : {}) }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('classic.SessionStart', () => ({}))
  return host
}

export type Host = ReturnType<typeof fakeHost>

/** A state key of q-advisor as the mod last wrote it; undefined before the first write. */
export const stateOf = <T = unknown>(host: Host, key: string) => host.state.get(key) as T | undefined

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-advisor', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

/** The person's own prompt (origin composer). */
export const userPrompt = ($: Engine, text: string) => $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

/** Ends the main loop's turn. */
export const completeMain = ($: Engine, turnId = 't1') =>
  $.turn.complete({ answer: 'Done.', durationMs: 1000, isAborted: false, turnId, reason: 'answer' } as Parameters<Engine['turn']['complete']>[0])

/** `/compact` raised by the engine itself (`trigger`), over `agentId`'s transcript when given. */
export const compact = ($: Engine, trigger: 'manual' | 'auto' | 'plugin' | 'precompute', extra: { agentId?: string; instructions?: string } = {}) =>
  $.session.compact({ trigger, messages: [{ role: 'user', text: 'hello', toolUses: [] }], ...extra } as never)

/** Lets the mod's detached work run to its end: due timers, then the host answers that resolve across ticks. */
export const settle = async (host: Host) => {
  const tick = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout
  for (let i = 0; i < 40; i++) {
    await host.clock.settle()
    await new Promise<void>(r => tick(r, 0))
  }
}

/** The band above the prompt, mounted on the terminal. */
export const mountBand = ($: Engine, props: { isWorking?: boolean } = {}) =>
  $.ui.mount({ plugin: 'q-advisor', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, ...props } } as Parameters<typeof $.ui.mount>[0])

export const decisionsOf = (host: Host) => (host.store.get('decisions') ?? []) as Decision[]
export const adviceLogOf = (host: Host) => (host.store.get('adviceLog') ?? []) as AdviceRecord[]

/** A prompt long enough to be classified. */
export const LONG_PROMPT = 'Now add the same pagination to the customers list, please.'
