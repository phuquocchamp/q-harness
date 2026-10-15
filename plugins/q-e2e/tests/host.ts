// Test helpers shared by the q-e2e tests: a fake host (store, clock, file system, processes, HTTP,
// model, agents) and short ways to drive the mod.

import { mock } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const ROOT = '/repo'
export const REPORT = `${ROOT}/.q-e2e/last-report.json`

type Proc = { exitCode: number; stdout?: string; stderr?: string }
type Spawned = { prompt: string; subagentType?: string; model?: string; description?: string }

/** One spec of a Playwright JSON report: `status` is the test's outcome. */
export type FakeSpec = { file: string; line: number; title: string; outcome: 'expected' | 'unexpected' | 'flaky' | 'skipped'; error?: string }

/** A Playwright JSON report as the reporter writes it, `file` relative to the config's rootDir (`/repo/tests`). */
export const report = (specs: FakeSpec[]) =>
  JSON.stringify({
    config: { rootDir: `${ROOT}/tests`, configFile: `${ROOT}/playwright.config.ts` },
    suites: specs.map(s => ({
      title: s.file,
      file: s.file,
      specs: [
        {
          title: s.title,
          file: s.file,
          line: s.line,
          tests: [
            {
              projectName: 'chromium',
              status: s.outcome,
              results: [{ status: s.outcome === 'unexpected' ? 'failed' : s.outcome === 'skipped' ? 'skipped' : 'passed', duration: 1200, retry: 0, ...(s.error ? { error: { message: s.error } } : {}) }],
            },
          ],
        },
      ],
    })),
    errors: [],
    stats: {
      expected: specs.filter(s => s.outcome === 'expected').length,
      unexpected: specs.filter(s => s.outcome === 'unexpected').length,
      flaky: specs.filter(s => s.outcome === 'flaky').length,
      skipped: specs.filter(s => s.outcome === 'skipped').length,
    },
  })

/** A Jev answer choosing `label` with probability `p` (the rest spread evenly). */
export const jevAnswer = (label: 'flaky' | 'test-drift' | 'app-bug' | 'env-auth', p = 0.91) => {
  const labels = ['flaky', 'test-drift', 'app-bug', 'env-auth'] as const
  const rest = (1 - p) / 3
  const probabilities = Object.fromEntries(labels.map(l => [l, l === label ? p : rest]))
  return JSON.stringify({ answers: { label: { choice: label, confidence: p, probabilities }, touched: { type: 'noul', noul: 0.9 } } })
}

/**
 * The fake host. `files` is the project's file system (absolute paths); `playwright` answers each
 * Playwright run with a report (or null for none) and an exit code; `jev` answers the triage fetch.
 */
export const fakeHost = (on: On) => {
  const store = new Map<string, unknown>()
  const files = new Map<string, string>()
  const toasts: string[] = []
  const notes: string[] = []
  const appended: string[] = []
  const statuses: (string | undefined)[] = []
  const spawned: Spawned[] = []
  const fetches: { url: string; headers: Record<string, string>; body: string }[] = []
  const runs: string[][] = []
  const env = new Map<string, string>()
  const toolsCalled: string[] = []
  const submitted: { text: string; origin: unknown }[] = []
  const suggested: string[] = []
  const filled: string[] = []
  const host = {
    submitted,
    suggested,
    filled,
    /** When set, a plugin's prompt.submit is dropped with this reason. */
    submitDrop: undefined as string | undefined,
    /** Whether prompt.suggest / prompt.fill take the text. */
    suggestShown: true,
    fillFilled: true,
    store,
    files,
    toasts,
    notes,
    appended,
    statuses,
    spawned,
    fetches,
    runs,
    env,
    toolsCalled,
    /** Reports the next Playwright runs answer, in order; the last one repeats. */
    playwright: [] as { json: string | null; exitCode: number }[],
    jev: { status: 200, text: jevAnswer('app-bug') } as { status: number; text: string } | 'throw',
    classify: undefined as string | undefined | 'throw',
    diff: '',
    /** When set, every spawn is refused with this reason. */
    spawnDeny: undefined as string | undefined,
    clock: mock.clock(on, { now: 1_000 }),
  }
  const isDir = (path: string) => [...files.keys()].some(k => k.startsWith(`${path}/`))

  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('session.root', () => ({ value: ROOT }))
  on('session.cwd', () => ({ value: ROOT }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('session.append', (_$, e, next) => {
    for (const b of e.message.content) if (b.type === 'text') appended.push(String(b.text))
    return next(e)
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('tool.register', (_$, e) => ({ value: { tool: `mcp__q-e2e__${e.name}` } }))
  on('ui.toast', (_$, e) => (toasts.push(e.text), { value: undefined }))
  on('ui.notify', (_$, e) => (notes.push(e.text), { value: { isSent: true, channel: 'terminal_bell' as const } }))
  on('ui.status', (_$, e) => (statuses.push(e.text), { value: undefined }))
  on('ui.invalidate', () => ({ value: undefined }))
  on('env.get', (_$, e) => ({ value: env.get(e.name) }))

  on('fs.exists', (_$, e) => ({ value: files.has(e.path) || isDir(e.path) }))
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
    const answer = (p: Proc) => ({ value: { exitCode: p.exitCode, stdout: p.stdout ?? '', stderr: p.stderr ?? '', isStdoutTruncated: false, isStderrTruncated: false } })
    if (argv[0] === 'git' && argv[1] === 'rev-parse') return answer({ exitCode: 0, stdout: 'abc1234\n' })
    if (argv[0] === 'git' && argv[1] === 'diff') return answer({ exitCode: 0, stdout: host.diff })
    if (argv.includes('playwright')) {
      const next = host.playwright.length > 1 ? host.playwright.shift()! : host.playwright[0]
      if (!next) throw new Error('no Playwright answer set')
      const out = e.init?.env?.PLAYWRIGHT_JSON_OUTPUT_NAME
      if (next.json !== null && out) files.set(out, next.json)
      return answer({ exitCode: next.exitCode })
    }
    throw new Error(`unexpected process: ${argv.join(' ')}`)
  })

  on('http.fetch', (_$, e) => {
    fetches.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ?? '' })
    if (host.jev === 'throw') throw new Error('refused by policy')
    return { value: { status: host.jev.status, ok: host.jev.status < 400, headers: {}, text: host.jev.text } }
  })
  on('model.classify', () => {
    if (host.classify === 'throw') throw new Error('model unavailable')
    return { value: host.classify }
  })

  let ids = 0
  on('agent.spawn', (_$, e) => {
    spawned.push({ prompt: e.prompt, subagentType: e.subagentType, model: e.model, description: e.description })
    if (host.spawnDeny) return { deny: host.spawnDeny }
    const id = `a${++ids}`
    return { model: 'claude-haiku-5-5', agentId: id }
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
  on('tool.call', (_$, e) => (toolsCalled.push(e.tool), { result: { ok: true } }) as never)
  return host
}

export const start = ($: Engine) => $.session.start({ cwd: ROOT, surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-e2e', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

/** An Edit by the main loop (or by subagent `agentId`). */
export const edit = ($: Engine, path: string, agentId?: string) =>
  $.tool.call({ tool: 'Edit', file_path: path, old_string: 'a', new_string: 'b', ...(agentId ? { agentId } : {}) } as never)

export const stop = ($: Engine, stopHookActive = false, agentId?: string) =>
  $.classic.Stop({ stop_hook_active: stopHookActive, ...(agentId ? { agent_id: agentId } : {}) } as Parameters<Engine['classic']['Stop']>[0])

/** Ends subagent `agentId`'s turn. */
export const endTurn = ($: Engine, agentId: string) =>
  $.turn.complete({ answer: 'done', durationMs: 1000, isAborted: false, turnId: `turn-${agentId}`, agentId, reason: 'answer' } as Parameters<Engine['turn']['complete']>[0])

/** A main-loop turn: turn.start, then (unless `skipStop`) a classic Stop, then turn.complete with `answer`. */
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

/** Lets the mod's detached work (the heal check) run to its end. */
export const settle = async () => {
  // Macrotasks: the detached fallback awaits host answers that resolve across ticks.
  const tick = (globalThis as unknown as { setTimeout: (f: () => void, ms: number) => void }).setTimeout
  for (let i = 0; i < 50; i++) await new Promise<void>(r => tick(r, 0))
}

/** A project with one checkout spec that visits /checkout. */
export const seedProject = (files: Map<string, string>) => {
  files.set(`${ROOT}/playwright.config.ts`, "export default { testDir: './tests' }\n")
  files.set(`${ROOT}/tests/checkout.spec.ts`, "test('pays', async ({ page }) => {\n  await page.goto('/checkout')\n  await expect(page.getByText('Paid')).toBeVisible()\n})\n")
  files.set(`${ROOT}/app/checkout/page.tsx`, 'export default function Page() { return null }\n')
}

export const RED_CHECKOUT: FakeSpec = { file: 'checkout.spec.ts', line: 42, title: 'pays', outcome: 'unexpected', error: "expected 'Paid' got 'Pending'" }
export const GREEN_CHECKOUT: FakeSpec = { file: 'checkout.spec.ts', line: 42, title: 'pays', outcome: 'expected' }
