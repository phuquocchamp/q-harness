// Test helpers shared by the q-pilot tests: a fake host (store, clock, file system, processes) whose
// runner answers canned result lines, and short ways to drive the mod.

import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const ROOT = '/repo'

/** A help request the fake runner raises (task mode) before it prints its result: written to `file`, then announced. */
type Help = { n: number; reason: string; request: Record<string, unknown> }
/** linger: after the result the fake runner stays up (an inspector open for review), raises `asks`, and ends only when the mod closes it. */
type Proc = { exitCode?: number; stdout?: string; stderr?: string; throws?: string; helps?: Help[]; linger?: boolean; asks?: { model: string; prompt: string }[]; saves?: { keys: unknown; scope: unknown }[] }

/** One flow of a runner result; every field of the contract that the mod reads has a default. */
export type FakeFlow = {
  id: string
  outcome: string
  recorded?: boolean
  jevCalls?: number
  jevMs?: number[]
  checks?: { check: unknown; ok: boolean; actual: unknown }[]
  warnings?: string[]
  flowProposal?: string
  steps?: unknown[]
  diverged?: unknown[]
  verifyFails?: unknown[]
  proposal?: string | null
  screenshot?: string | null
  error?: string | null
  suggestedVerify?: unknown
}

export const flow = (id: string, outcome: string, extra: Partial<FakeFlow> = {}): FakeFlow => ({
  id,
  outcome,
  recorded: false,
  steps: [{ op: 'click', role: 'button', name: 'Place order', by: 'replay' }],
  diverged: [],
  verifyFails: [],
  proposal: null,
  screenshot: null,
  error: null,
  ...extra,
})

export const DRIFT = flow('checkout', 'drift', {
  diverged: [{ step: 3, was: { op: 'click', role: 'button', name: 'Place order' }, now: { op: 'click', role: 'button', name: 'Pay now' }, p: 0.82 }],
  proposal: `${ROOT}/.q-pilot/runs/r1/checkout.trace.json`,
})

export const APP_BUG = flow('checkout', 'app-bug', {
  verifyFails: [{ check: { testid: 'total', text: '€12.00' }, actual: '€14.00' }],
  screenshot: `${ROOT}/.q-pilot/runs/r1/checkout.png`,
})

/** The runner's stdout: progress noise is on stderr, so stdout is the one result line. */
export const resultLine = (flows: FakeFlow[], command = 'run') =>
  JSON.stringify({ ok: true, command, runId: 'r1', runDir: `${ROOT}/.q-pilot/runs/r1`, durationMs: 800, flows })

export const say = (flows: FakeFlow[], command = 'run'): Proc => ({ exitCode: 0, stdout: `${resultLine(flows, command)}\n` })

/**
 * The fake host. `files` is the project's file system (absolute paths); `runner[command]` answers each
 * runner call of that command in order (the last one repeats).
 */
export const fakeHost = (on: On) => {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const toasts: string[] = []
  const notes: string[] = []
  const appended: string[] = []
  const statuses: (string | undefined)[] = []
  const runs: string[][] = []
  const envs: (Record<string, string> | undefined)[] = []
  const submitted: { text: string; origin: unknown }[] = []
  /** Answers the mod wrote to the fake runner's help requests, in order. */
  const answers: unknown[] = []
  /** Inspector questions the mod answered (the request to $.model.complete and the answer file it wrote). */
  const completes: { model: string; prompt: string; system?: string }[] = []
  const asked: unknown[] = []
  /** The mod's answers to the inspector's "Save as default" requests. */
  const saved: unknown[] = []
  /** How many lingering fake runners the mod closed. */
  const closed = { n: 0 }
  const suggested: string[] = []
  const filled: string[] = []
  const host = {
    submitted,
    answers,
    completes,
    asked,
    saved,
    closed,
    suggested,
    filled,
    submitDrop: undefined as string | undefined,
    /** Canned $.model.complete replies, used in order (the helper model's answers); empty: a plain-text default. */
    modelReplies: [] as string[],
    suggestShown: true,
    fillFilled: true,
    store,
    /** A per-project store value (its key is the name plus a hash of the root). */
    stored: (name: string) => [...store].find(([k]) => new RegExp(`^${name}:[0-9a-f]{8}$`).test(k))?.[1],
    files,
    toasts,
    notes,
    appended,
    statuses,
    runs,
    envs,
    env: new Map<string, string>(),
    /** Answers of the runner by command (`run`, `accept`, `record`, `export`). */
    runner: {} as Record<string, Proc[]>,
    /** Whether runner/pilot.mjs exists in the plugin. */
    runnerExists: true,
    diff: '',
    /** The project root `$.session.root()` answers. */
    root: ROOT,
    clock: mock.clock(on, { now: 1_000 }),
  }
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.root', () => ({ value: host.root }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.append', (_$, e, next) => {
    for (const b of e.message.content) if (b.type === 'text') appended.push(String(b.text))
    return next(e)
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__q-pilot__${e.name}` } }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.notify', (_$, e) => (notes.push(e.text), { value: { isSent: true, channel: 'terminal_bell' as const } }))
  on('ui.status', (_$, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: host.env.get(e.name) }))

  on('fs.exists', (_$, e) => ({ value: e.path.endsWith('/runner/pilot.mjs') ? host.runnerExists : files.has(e.path) || isDir(e.path) }))
  on('fs.read', (_$, e) => {
    const text = files.get(e.path)
    if (text === undefined) throw new Error(`ENOENT: ${e.path}`)
    return { value: text }
  })
  on('fs.write', (_$, e) => (files.set(e.path, e.text), { value: undefined }))
  on('fs.list', (_$, e) => {
    const names = new Map<string, 'file' | 'dir'>()
    for (const k of files.keys()) {
      if (!k.startsWith(`${e.path}/`)) continue
      const [name, ...more] = k.slice(e.path.length + 1).split('/')
      names.set(name!, more.length > 0 ? 'dir' : 'file')
    }
    if (names.size === 0) throw new Error(`ENOENT: ${e.path}`)
    return { value: [...names].map(([name, kind]) => ({ name, kind, size: 0, mtimeMs: 0, isLink: false })) }
  })

  on('process.run', (_$, e) => {
    const argv = [...e.argv]
    runs.push(argv)
    envs.push(e.init?.env)
    const answer = (p: Proc) => ({ value: { exitCode: p.exitCode ?? 0, stdout: p.stdout ?? '', stderr: p.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'git' && argv[1] === 'diff') return answer({ stdout: host.diff })
    const script = argv.findIndex(a => a.endsWith('runner/pilot.mjs'))
    if (script >= 0) {
      const queue = host.runner[argv[script + 1]!]
      const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
      if (!next) throw new Error(`no runner answer set for ${argv[script + 1]}`)
      if (next.throws) throw new Error(next.throws)
      return answer(next)
    }
    throw new Error(`unexpected process: ${argv.join(' ')}`)
  })

  // The task runner is spawned (it outlives a tool call while it waits for help). Same canned answers as process.run.
  on('process.spawn', async function* (_$, e) {
    const argv = [...e.argv]
    runs.push(argv)
    envs.push(e.env)
    const script = argv.findIndex(a => a.endsWith('runner/pilot.mjs'))
    if (script < 0) throw new Error(`unexpected spawn: ${argv.join(' ')}`)
    const queue = host.runner[argv[script + 1]!]
    const next = queue && queue.length > 1 ? queue.shift()! : queue?.[0]
    if (!next) throw new Error(`no runner answer set for ${argv[script + 1]}`)
    if (next.throws) throw new Error(next.throws)
    const runDir = `${ROOT}/.q-pilot/runs/r1`
    for (const h of next.helps ?? []) {
      const file = `${runDir}/help-${h.n}.json`
      files.set(file, JSON.stringify({ n: h.n, of: 6, steps: 3, wait_ms: 240000, fixtures: [], elements: [], text: '', recent_actions: [], screenshot: null, url: 'https://x/', title: 'X', ...h.request }))
      yield { stream: 'stderr' as const, text: `[q-pilot] task\n[q-pilot] help ${JSON.stringify({ n: h.n, file, runId: '20261015-122547-253c', runDir, reason: h.reason })}\n` }
      const answer = file.replace(/\.json$/, '.answer.json')
      while (!files.has(answer)) await new Promise(r => setTimeout(r, 2))
      answers.push(JSON.parse(files.get(answer)!))
    }
    if (next.stderr) yield { stream: 'stderr' as const, text: next.stderr }
    if (next.stdout) yield { stream: 'stdout' as const, text: next.stdout }
    if (next.linger) {
      try {
        for (const [k, a] of (next.asks ?? []).entries()) {
          const file = `${runDir}/ask-${k + 1}.json`
          files.set(file, JSON.stringify({ n: k + 1, system: 'sys', ...a }))
          yield { stream: 'stderr' as const, text: `[q-pilot] ask ${JSON.stringify({ n: k + 1, file })}\n` }
          const answer = file.replace(/\.json$/, '.answer.json')
          while (!files.has(answer)) await new Promise(r => setTimeout(r, 2))
          asked.push(JSON.parse(files.get(answer)!))
        }
        for (const [k, a] of (next.saves ?? []).entries()) {
          const file = `${runDir}/settings-save-${k + 1}.json`
          files.set(file, JSON.stringify({ n: k + 1, ...a }))
          yield { stream: 'stderr' as const, text: `[q-pilot] settings-save ${JSON.stringify({ n: k + 1, file })}\n` }
          const answer = file.replace(/\.json$/, '.answer.json')
          while (!files.has(answer)) await new Promise(r => setTimeout(r, 2))
          saved.push(JSON.parse(files.get(answer)!))
        }
        // Progress lines while it serves the inspector: a generator only takes return() at a yield.
        for (;;) {
          await new Promise(r => setTimeout(r, 5))
          yield { stream: 'stderr' as const, text: '[q-pilot] inspector open\n' }
        }
      } finally {
        closed.n++
      }
    }
    return { value: { code: next.exitCode ?? 0, signal: null } }
  })

  on('model.complete', (_$, e) => {
    completes.push({ model: e.model, prompt: String(e.prompt), system: e.system === undefined ? undefined : String(e.system) })
    return { value: { isAnswered: true as const, text: host.modelReplies.shift() ?? `Click [31] (${e.model}).`, usage: { input_tokens: 10, output_tokens: 5, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } }
  })

  on('turn.complete', (_$, e) => ({ text: e.answer }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('prompt.submit', (_$, e) => {
    submitted.push({ text: e.text, origin: e.origin })
    return host.submitDrop ? { drop: host.submitDrop } : { text: e.text }
  })
  on('prompt.suggest', (_$, e) => (suggested.push(e.text), { isShown: host.suggestShown }))
  on('prompt.fill', (_$, e) => (filled.push(e.text), { isFilled: host.fillFilled }))
  on('classic.Stop', () => ({}))
  // Write, Edit and the rest succeed.
  on('tool.call', (_$, e) => ({ result: { ok: true } }) as never)
  return host
}

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-pilot', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

/** An Edit by the main loop (or by subagent `agentId`). */
export const edit = ($: Engine, path: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)

export const stop = ($: Engine, stopHookActive = false, agentId?: string) =>
  $.classic.Stop({ stop_hook_active: stopHookActive, ...(agentId ? { agent_id: agentId } : {}) } as Parameters<Engine['classic']['Stop']>[0])

/** A main-loop turn: turn.start, then (when `stop`) a classic Stop, then turn.complete with `answer`. */
export const mainTurn = async ($: Engine, turnId: string, answer: string, opts: { stop?: boolean } = {}) => {
  await $.turn.start({ text: 'go', turnId } as Parameters<Engine['turn']['start']>[0])
  return { stopped: opts.stop ? await stop($) : undefined, completed: await completeMain($, turnId, answer) }
}

/** Ends the main loop's turn `turnId` with `answer` (no agentId). */
export const completeMain = ($: Engine, turnId: string, answer: string) =>
  $.turn.complete({ answer, durationMs: 1000, isAborted: false, turnId, reason: 'answer' } as Parameters<Engine['turn']['complete']>[0])

/** The person's own prompt (origin composer). */
export const userPrompt = ($: Engine, text: string) =>
  $.prompt.submit({ text, wait: false, origin: { kind: 'composer' } } as never)

/** Lets the mod's detached work (the fallback gate) run to its end. */
export const settle = async () => {
  const tick = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout
  for (let i = 0; i < 50; i++) await new Promise<void>(r => tick(r, 0))
}

/** The runner calls of one command. */
export const calls = (runs: string[][], command: string) => runs.filter(a => a.some(x => x.endsWith('runner/pilot.mjs')) && a[a.findIndex(x => x.endsWith('runner/pilot.mjs')) + 1] === command)

/** A project with a checkout flow (covers src/checkout.html) and a smoke flow. */
export const seedProject = (files: Map<string, string>) => {
  files.set(`${ROOT}/q-pilot.config.json`, JSON.stringify({ baseURL: 'http://localhost:4321', flowsDir: 'flows' }))
  files.set(`${ROOT}/flows/checkout.flow.json`, JSON.stringify({ id: 'checkout', start: '/', goal: 'Buy', verify: [{ url: 'x' }], covers: ['src/checkout.html'], tags: [] }))
  files.set(`${ROOT}/flows/home.flow.json`, JSON.stringify({ id: 'home', start: '/', goal: 'Home', verify: [{ url: '^/$' }], covers: ['src/index.html'], tags: ['smoke'] }))
  files.set(`${ROOT}/src/checkout.html`, '<html></html>')
  files.set(`${ROOT}/src/other.html`, '<html></html>')
}
