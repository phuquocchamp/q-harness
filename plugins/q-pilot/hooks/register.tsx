// q-pilot: checks that the user flows of a web app still work. It records the files the main loop
// edits, and when the main turn tries to stop after UI-relevant edits it runs the affected flows with
// the runner (a Node CLI): replay of a recorded trace, a Jev re-pick of one changed step, and a
// verify block judged by code. Red flows block the stop; drift blocks until the person accepts it
// (or, with trust on, until the turn's diff shows the change was intended).
// When the classic Stop hook never reaches this module (managed settings can bypass user plugins'
// classic.Stop), the main turn's turn.complete runs the same gate detached and, on red, submits the
// failures as a follow-up prompt. Every hook and every helper that takes `$` lives in this file (the
// engine follows `$` only within one module); pure helpers are in ./lib.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, PluginOptions, Register } from 'claude-code'

import type { PilotFlow, PilotLast, PilotMode, PilotRun, PilotStopSeen } from '../types'
import { claimsSuccess } from './lib/claims'
import type { FlowDef, PilotConfig, RunnerResult, Trust } from './lib/contract'
import { DEFAULT_FLOWS_DIR, isUiRelevant, selectFlows } from './lib/impact'
import { actionFor, blockText, flowBlock, flowLine, isBad, isTouched, parseResult, stderrTail, stopBudget, summarize } from './lib/report'

const edits = atom({ plugin: 'q-pilot', key: 'edits' } as const, [] as string[])
const blocks = atom({ plugin: 'q-pilot', key: 'blocksThisTurn' } as const, 0 as number)
const lastRun = atom({ plugin: 'q-pilot', key: 'lastRun' } as const, null as PilotRun | null)
const lastByFlow = atom({ plugin: 'q-pilot', key: 'lastByFlow' } as const, {} as Record<string, PilotLast>)
const modeOverride = atom({ plugin: 'q-pilot', key: 'mode' } as const, null as PilotMode | null)
const currentTurn = atom({ plugin: 'q-pilot', key: 'currentTurn' } as const, null as string | null)
const stopSeen = atom({ plugin: 'q-pilot', key: 'stopSeen' } as const, null as PilotStopSeen | null)
const followUps = atom({ plugin: 'q-pilot', key: 'followUps' } as const, 0 as number)
const interactive = atom({ plugin: 'q-pilot', key: 'interactive' } as const, true as boolean)

const TOOL = 'pilot_status'
/** `mcp__q-pilot__pilot_status`, tolerating a namespaced plugin segment (`plugin_q-pilot`, `q-pilot@inline`). */
const TOOL_RE = /^mcp__[\w@.-]*q-pilot[\w@.-]*__pilot_status$/
const CONFIG_FILE = 'q-pilot.config.json'
const RUNNER = 'runner/pilot.mjs'
const MAX_BLOCKS = 2
const MAX_FOLLOW_UPS = 2
/** Prompt origins that are the person's own prompt: they reset the follow-up cap. */
const USER_ORIGINS = new Set(['composer', 'sdk', 'bridge'])
/** A command may take this long (the process.run ceiling). */
const COMMAND_TIMEOUT_MS = 600_000
const DIFF_CAP = 200_000
const MAX_FLOWS = 200
const FLOW_ID = /^[a-z0-9-]+$/
const EDIT_TOOLS = new Set(['Write', 'Edit', 'MultiEdit', 'NotebookEdit'])
const RED_HEX = '#ff7b6b'
const WARN_HEX = '#ffc04d'

const USAGE = [
  'Usage: /q-pilot <subcommand>',
  '  run              run the flows this turn\'s edits affect',
  '  run all|<id>     run every flow, or one',
  '  record <id>      record a flow\'s trace with Jev (needs a verify block)',
  '  accept [<id>]    accept a drift or a fresh recording as the flow\'s trace',
  '  status           last run per flow',
  '  export <id>      write a Playwright spec from a flow and its trace',
  '  init             write q-pilot.config.json and flows/example.flow.json when missing',
  '  mode off|affected|all',
].join('\n')

const EXAMPLE_CONFIG = { baseURL: 'http://localhost:3000', flowsDir: DEFAULT_FLOWS_DIR, ignore: ['**/*.md'] }
const EXAMPLE_FLOW = {
  id: 'example',
  start: '/',
  goal: 'Open the start page and check that it loads.',
  fixtures: {},
  verify: [{ url: '^/$' }],
  covers: [],
  tags: [],
  budget: { steps: 20, seconds: 20 },
}

type FollowUp = 'auto' | 'suggest' | 'off'

type Opts = {
  mode: PilotMode
  followUp: FollowUp
  trust: Trust
  maxStopMs: number
  node: string[]
  jevKey: string
}

const words = (v: unknown) => String(v ?? '').split(/\s+/).filter(Boolean)

const optsOf = (options: PluginOptions): Opts => {
  const mode = String(options.mode ?? 'affected')
  const seconds = Number(options.maxStopSeconds)
  const node = words(options.node ?? 'node')
  const followUp = String(options.followUp ?? 'auto')
  return {
    mode: mode === 'off' || mode === 'all' ? mode : 'affected',
    followUp: followUp === 'suggest' || followUp === 'off' ? followUp : 'auto',
    trust: String(options.trust ?? 'shadow') === 'on' ? 'on' : 'shadow',
    maxStopMs: (Number.isFinite(seconds) && seconds > 0 ? seconds : 60) * 1000,
    node: node.length > 0 ? node : ['node'],
    jevKey: String(options.jevApiKey ?? ''),
  }
}

const cap = (text: string, n: number) => (text.length > n ? `${text.slice(0, n)}\n…(truncated)` : text)
const errMsg = (err: unknown) => (err instanceof Error ? err.message : String(err))

// ---- small $ helpers -------------------------------------------------------------------------------

/** The repo-relative form of a path the tools give absolute. */
async function relPath($: EngineInterface, path: string): Promise<string | undefined> {
  const root = await $.session.root()
  const base = root.endsWith('/') ? root : `${root}/`
  if (path.startsWith(base)) return path.slice(base.length)
  // A relative path is the project's; an absolute one elsewhere (scratch files, ~/) is not.
  return path.startsWith('/') ? undefined : path.replace(/^\.\//, '')
}

async function effectiveMode($: EngineInterface, o: Opts): Promise<PilotMode> {
  return (await read($, modeOverride)) ?? o.mode
}

/** Forgets `handled` (the snapshot a gate ran on), or every edit; edits made meanwhile stay. */
async function clearEdits($: EngineInterface, handled?: readonly string[]) {
  await update($, edits, list => (handled ? list.filter(p => !handled.includes(p)) : []))
}

/** `q-pilot.config.json` at the project root, or undefined when absent or unreadable: the gate stays off. */
async function loadConfig($: EngineInterface): Promise<PilotConfig | undefined> {
  try {
    const path = `${await $.session.root()}/${CONFIG_FILE}`
    if (!(await $.fs.exists(path))) return undefined
    const parsed = JSON.parse(await $.fs.read(path)) as unknown
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? (parsed as PilotConfig) : undefined
  } catch {
    return undefined
  }
}

const flowsDirOf = (cfg: PilotConfig) => (cfg.flowsDir ?? DEFAULT_FLOWS_DIR).replace(/^\.\//, '').replace(/\/$/, '')

/** The flows under `<flowsDir>/*.flow.json`; a file that does not parse is left to the runner to report. */
async function loadFlows($: EngineInterface, cfg: PilotConfig): Promise<FlowDef[]> {
  const root = await $.session.root()
  const dir = `${root}/${flowsDirOf(cfg)}`
  let entries
  try {
    entries = await $.fs.list(dir)
  } catch {
    return []
  }
  const flows: FlowDef[] = []
  for (const entry of entries) {
    if (entry.kind !== 'file' || !entry.name.endsWith('.flow.json') || flows.length >= MAX_FLOWS) continue
    try {
      const parsed = JSON.parse(await $.fs.read(`${dir}/${entry.name}`)) as Partial<FlowDef>
      const strings = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : [])
      flows.push({ id: typeof parsed.id === 'string' ? parsed.id : entry.name.replace(/\.flow\.json$/, ''), covers: strings(parsed.covers), tags: strings(parsed.tags) })
    } catch {
      // Unreadable or invalid: the runner reports it when the flow runs.
    }
  }
  return flows
}

/** `git diff` of the given files, capped. Used only to see whether a drifted element name was touched. */
async function gitDiff($: EngineInterface, files: readonly string[]): Promise<string> {
  try {
    const r = await $.process.run(['git', 'diff', '--no-color', '--', ...files], { cwd: await $.session.root(), timeoutMs: 10_000 })
    return r.stdout.slice(0, DIFF_CAP)
  } catch {
    return ''
  }
}

async function jevKeyOf($: EngineInterface, o: Opts): Promise<string> {
  if (o.jevKey) return o.jevKey
  try {
    return (await $.env.get('TYPESAFE_API_KEY')) ?? ''
  } catch {
    return ''
  }
}

/** Adds a hidden user-role note the model reads with the next prompt. */
async function note($: EngineInterface, text: string) {
  await $.session.append({ message: { type: 'user', content: [{ type: 'text', text: `[q-pilot] ${text}` }] } }).catch(() => undefined)
}

// ---- running the runner ----------------------------------------------------------------------------

/**
 * `result`: the runner printed a result line. `unavailable`: the runner file or node is missing, or
 * the process could not run (says nothing about the app: the gate allows). `error`: it ran but crashed
 * or printed no result line.
 */
type RunnerOutcome = { result: RunnerResult } | { unavailable: string } | { error: string }

/** Runs `node runner/pilot.mjs <args>` in the project root and parses the last stdout line. */
async function runRunner($: EngineInterface, o: Opts, args: string[], timeoutMs: number): Promise<RunnerOutcome> {
  const root = await $.session.root()
  const script = `${$.plugin.root}/${RUNNER}`
  if (!(await $.fs.exists(script).catch(() => false))) return { unavailable: `the runner is missing (${script})` }
  const key = await jevKeyOf($, o)
  const secrets = key ? [key] : []
  const argv = [...o.node, script, args[0]!, '--root', root, ...args.slice(1)]
  let r
  try {
    r = await $.process.run(argv, { cwd: root, ...(key ? { env: { TYPESAFE_API_KEY: key } } : {}), timeoutMs: Math.max(1, Math.min(timeoutMs, COMMAND_TIMEOUT_MS)) })
  } catch (err) {
    return { unavailable: `could not run ${o.node.join(' ')}: ${errMsg(err)}` }
  }
  if (r.exitCode === 127) return { unavailable: `${o.node.join(' ')} was not found` }
  const result = parseResult(r.stdout)
  const tail = stderrTail(r.stderr, secrets)
  if (!result) return { error: `the runner crashed (exit ${r.exitCode}) and printed no result${tail ? `:\n${tail}` : ''}` }
  if (!result.ok) return { error: `the runner failed: ${result.error ?? 'no reason given'}${tail ? `\n${tail}` : ''}` }
  return { result }
}

/** Keeps a run as the last one, in the last-per-flow map, and on the status line. */
async function recordRun($: EngineInterface, o: Opts, run: PilotRun) {
  await update($, lastRun, () => run)
  await setLast($, run.flows, run.runId, run.startedAt)
  $.ui.status(`pilot ${summarize(run.flows, o.trust)}`)
  $.ui.invalidate('ui.render')
}

async function setLast($: EngineInterface, flows: readonly PilotFlow[], runId: string, at: number) {
  await update($, lastByFlow, cur => ({ ...cur, ...Object.fromEntries(flows.map(f => [f.id, { outcome: f.outcome, runId, at, ...(f.accepted ? { accepted: true } : {}), ...(f.jevCalls === undefined ? {} : { jevCalls: f.jevCalls }) }])) }))
  try {
    await $.store.set('lastRun', await read($, lastRun))
    await $.store.set('lastByFlow', await read($, lastByFlow))
  } catch {
    // The evidence stays in state for this session.
  }
}

/** Marks a flow's proposal as accepted: the band and the summary stop counting it. */
async function markAccepted($: EngineInterface, o: Opts, id: string) {
  await update($, lastRun, run => (run ? { ...run, flows: run.flows.map(f => (f.id === id ? { ...f, accepted: true } : f)) } : run))
  await update($, lastByFlow, cur => (cur[id] ? { ...cur, [id]: { ...cur[id]!, accepted: true } } : cur))
  const run = await read($, lastRun)
  try {
    await $.store.set('lastRun', run)
    await $.store.set('lastByFlow', await read($, lastByFlow))
  } catch {
    // Best effort.
  }
  if (run) $.ui.status(`pilot ${summarize(run.flows, o.trust)}`)
  $.ui.invalidate('ui.render')
}

/** Runs the runner's `accept` for one flow; answers the failure text, or undefined on success. */
async function acceptFlow($: EngineInterface, o: Opts, id: string, runId: string | undefined): Promise<string | undefined> {
  const out = await runRunner($, o, ['accept', '--flow', id, ...(runId ? ['--run', runId] : [])], 30_000)
  if ('unavailable' in out) return out.unavailable
  if ('error' in out) return out.error
  const flow = out.result.flows?.find(f => f.id === id)
  if (flow?.error) return flow.error
  await markAccepted($, o, id)
  return undefined
}

// ---- the stop gate ---------------------------------------------------------------------------------

/** `driftOnly`: the block is only about drift, which the person must accept: Claude cannot, so no follow-up. */
type GateResult = { block?: string; run?: PilotRun; changed?: string[]; driftOnly?: boolean }

/**
 * `stopHookActive`: the classic Stop input's flag (a stop right after a block). `fallback`: called
 * from turn.complete, which keeps its own follow-up cap, so the Stop path's block counter is left alone.
 */
type GateCall = { stopHookActive: boolean; fallback?: boolean }

/** Runs the flows this turn's edits affect and decides whether the main loop may stop. */
async function gate($: EngineInterface, o: Opts, call: GateCall): Promise<GateResult | undefined> {
  if (!call.fallback && !call.stopHookActive) await update($, blocks, () => 0)
  const mode = await effectiveMode($, o)
  if (mode === 'off') return void (await clearEdits($))
  const changed = await read($, edits)
  const cfg = await loadConfig($)
  // Not a q-pilot project (or not set up yet): nothing to gate.
  if (!cfg) return void (await clearEdits($, changed))
  if (!changed.some(p => isUiRelevant(p, cfg))) return void (await clearEdits($, changed))
  if (!call.fallback && (await read($, blocks)) >= MAX_BLOCKS) {
    $.ui.toast(`q-pilot: still red after ${MAX_BLOCKS} blocks; letting the turn end`, { timeoutMs: 8000 })
    return void (await clearEdits($, changed))
  }

  const sel = selectFlows(changed, await loadFlows($, cfg), cfg, mode)
  if (sel.mode === 'none') return void (await clearEdits($, changed))

  const t0 = await $.clock.now()
  $.ui.status(`pilot running ${sel.ids.length} flow(s)…`)
  const { budgetMs, timeoutMs } = stopBudget(o.maxStopMs)
  const out = await runRunner($, o, ['run', '--flows', sel.ids.join(','), '--budget-ms', String(budgetMs)], timeoutMs)
  if ('unavailable' in out) {
    $.ui.status(`pilot ⚠ ${cap(out.unavailable, 80)}`)
    $.ui.toast(`q-pilot: ${out.unavailable}`, { timeoutMs: 8000 })
    return void (await clearEdits($, changed))
  }
  if ('error' in out) {
    // A crash says nothing about the app: block once with the stderr tail, and do not gate these edits again.
    $.ui.status('pilot ⚠ the runner failed')
    await clearEdits($, changed)
    if (!call.fallback) await update($, blocks, n => n + 1)
    return { block: `q-pilot: ${out.error}\nTell the user the flow check could not run; do not retry it yourself.`, changed }
  }

  const result = out.result
  const flows: PilotFlow[] = (result.flows ?? []).map(f => ({ ...f }))
  const run: PilotRun = { runId: result.runId ?? `${t0}`, startedAt: t0, durationMs: result.durationMs ?? (await $.clock.now()) - t0, reason: 'stop-gate', flows }

  // Deterministic `touched`: only needed to decide an auto-accept.
  const drifted = flows.filter(f => f.outcome === 'drift')
  const diff = o.trust === 'on' && drifted.length > 0 ? await gitDiff($, changed) : ''
  const entries: string[][] = []
  const notes: string[] = []
  for (const f of flows) {
    const touched = f.outcome === 'drift' && isTouched(f, diff)
    const action = actionFor(f, o.trust, touched)
    if (action === 'accept') {
      const why = await acceptFlow($, o, f.id, run.runId)
      if (!why) {
        f.accepted = true
        notes.push(`${f.id} drifted (${f.diverged.map(d => `step ${d.step}`).join(', ')}); the turn's diff mentions the changed element, so its new trace was accepted.`)
        continue
      }
      entries.push([...flowBlock(f, o.trust, touched), `    Auto-accept failed: ${why}`])
    } else if (action === 'block') entries.push(flowBlock(f, o.trust, touched))
    else if (action === 'notify') await $.ui.notify(`${f.id}: environment problem: ${f.error ?? 'start page unreachable'}`, { title: 'q-pilot' }).catch(() => undefined)
    else if (action === 'note') {
      if (f.outcome === 'pass') notes.push(`${f.id} was recorded just now (a proposal, not yet a trace). Ask the user to run /q-pilot accept ${f.id}.`)
      else if (f.outcome === 'skipped') notes.push(`${f.id} was skipped: the stop budget ran out. /q-pilot run ${f.id} runs it.`)
      else notes.push(`${f.id} has no trace yet (${f.outcome}). Ask the user to run /q-pilot record ${f.id}.`)
    }
  }
  await recordRun($, o, run)
  if (notes.length > 0) {
    $.ui.toast(`q-pilot: ${cap(notes[0]!, 120)}`, { timeoutMs: 8000 })
    await note($, notes.join('\n'))
  }
  if (entries.length > 0) {
    if (!call.fallback) await update($, blocks, n => n + 1)
    // Drift alone is the person's to accept: report it once and do not gate these edits again.
    const driftOnly = flows.every(f => f.outcome === 'drift' || !blocks_(f, o.trust))
    if (driftOnly) await clearEdits($, changed)
    return { block: blockText(run.runId, entries), run, changed, driftOnly }
  }
  await clearEdits($, changed)
  return { run }
}

/** Whether the gate blocks on this flow when the diff does not touch it. */
const blocks_ = (f: PilotFlow, trust: Trust) => actionFor(f, trust, false) === 'block'

/** What ran, in words. */
const ranWhat = (run: PilotRun) => `${run.flows.length} flow(s) (${run.flows.map(f => f.id).join(', ')})`

/** The block text, led by a contradiction line when the answer claimed success. */
function followUpText(block: string, run: PilotRun | undefined, answer: string, trust: Trust): string {
  if (!run || !claimsSuccess(answer)) return block
  // "the flows work" only when a sentence that itself claims success talks about passing; "Done. I ran no tests" is "it is done".
  const testsClaim = answer.split(/(?<=[.!?])\s+|\n+/).some(x => /\b(?:pass(?:es|ed|ing)?|green|works?|working)\b/i.test(x) && claimsSuccess(x))
  const said = testsClaim ? 'the flows work' : 'it is done'
  return `You said ${said}, but q-pilot ran ${ranWhat(run)} after your changes: ${summarize(run.flows, trust)}.\n\n${block}`
}

/** One line for the prompt box's suggestion: the red flows, not the whole block text. */
const suggestionOf = (run: PilotRun | undefined, trust: Trust) =>
  `Fix the failing flow(s): ${(run?.flows.filter(f => isBad(f, trust)) ?? []).slice(0, 3).map(f => `${f.id} (${f.outcome})`).join('; ') || 'see /q-pilot status'}`

/**
 * The fallback when classic.Stop did not run for the main turn: the same gate, then by `followUp`
 * a follow-up prompt (auto), a suggestion in the prompt box (suggest), or a note the model reads
 * with the next prompt (off, or when the others are refused).
 */
async function fallbackGate($: EngineInterface, o: Opts, answer: string) {
  const g = await gate($, o, { stopHookActive: false, fallback: true })
  if (!g?.block) return
  const text = followUpText(g.block, g.run, answer, o.trust)
  if (g.driftOnly) {
    // Claude cannot accept a drift, so a follow-up would only re-run the gate: tell the person once.
    $.ui.toast(`q-pilot: ${cap((g.block.split('\n')[0] ?? '').replace(/^q-pilot: /, ''), 100)} Run /q-pilot accept, or restore the old element.`, { timeoutMs: 10_000 })
    await note($, text)
    return
  }
  const count = await read($, followUps)
  if (count >= MAX_FOLLOW_UPS) {
    $.ui.toast(`q-pilot: still red after ${MAX_FOLLOW_UPS} follow-ups; not continuing`, { timeoutMs: 8000 })
    // Like the Stop path's block cap: give up on these edits, so the next turn gates only new ones.
    await clearEdits($, g.changed)
    await note($, text)
    return
  }
  if (o.followUp === 'auto') {
    // Counted before the submit: our own prompt passes our prompt.submit hook too, and must not reset it.
    await update($, followUps, n => n + 1)
    let refused: string
    try {
      const r = await $.prompt.submit({ text })
      if (!r.drop) return
      refused = r.drop
    } catch (err) {
      refused = errMsg(err)
    }
    await update($, followUps, n => Math.max(0, n - 1))
    $.ui.toast(`q-pilot: follow-up not submitted (${cap(refused, 80)})`, { timeoutMs: 8000 })
  }
  if (o.followUp !== 'off') {
    const shown = await $.prompt.suggest({ text: suggestionOf(g.run, o.trust) }).catch(() => ({ isShown: false }))
    if (!shown.isShown) {
      const filled = await $.prompt.fill({ text: suggestionOf(g.run, o.trust) }).catch(() => ({ isFilled: false }))
      if (!filled.isFilled) $.ui.toast(`q-pilot: ${cap(g.block.split('\n')[0] ?? '', 120)}`, { timeoutMs: 8000 })
    }
  } else $.ui.toast(`q-pilot: ${cap(g.block.split('\n')[0] ?? '', 120)}`, { timeoutMs: 8000 })
  // Whatever the person sends next, the model reads the failures with it.
  await note($, text)
}

// ---- /q-pilot --------------------------------------------------------------------------------------

/** The evidence tool's answer, as an object; the tool returns it as JSON text. */
async function statusJson($: EngineInterface, o: Opts) {
  const run = await read($, lastRun)
  const last = await read($, lastByFlow)
  const now = await $.clock.now()
  return {
    mode: await effectiveMode($, o),
    trust: o.trust,
    pendingEdits: (await read($, edits)).length,
    summary: run ? summarize(run.flows, o.trust) : null,
    flows: Object.fromEntries(Object.entries(last).map(([id, l]) => [id, { outcome: l.outcome, accepted: l.accepted === true, jevCalls: l.jevCalls ?? 0, runId: l.runId, ageSeconds: Math.round((now - l.at) / 1000) }])),
    lastRun: run
      ? {
          runId: run.runId,
          reason: run.reason,
          durationMs: run.durationMs,
          ageSeconds: Math.round((now - run.startedAt) / 1000),
          flows: run.flows.map(f => ({
            id: f.id,
            outcome: f.outcome,
            accepted: f.accepted === true,
            jevCalls: f.jevCalls ?? 0,
            error: f.error ?? null,
            diverged: f.diverged,
            verifyFails: f.verifyFails,
          })),
        }
      : null,
    note: run ? 'Evidence from a real q-pilot run; quote it instead of claiming the flows work.' : 'No q-pilot run recorded yet. Run /q-pilot run or finish a turn with UI edits.',
  }
}

async function describeStatus($: EngineInterface, o: Opts): Promise<string> {
  const s = await statusJson($, o)
  const lines = [`mode: ${s.mode} · trust: ${s.trust} · follow-up: ${o.followUp} · pending edits: ${s.pendingEdits}`]
  const entries = Object.entries(s.flows)
  if (entries.length === 0) lines.push('flows: none run yet')
  for (const [id, l] of entries) lines.push(`  ${l.outcome === 'pass' || (l.outcome === 'flaky' && o.trust === 'on') || l.accepted ? '✓' : '✗'} ${id}: ${l.outcome}${l.accepted ? ' (accepted)' : ''} · ${l.ageSeconds}s ago · run ${l.runId}`)
  return lines.join('\n')
}

const idError = (usage: string, id: string) => (FLOW_ID.test(id) ? undefined : { text: `Usage: ${usage}`, exitCode: 2 })

async function commandRun($: EngineInterface, o: Opts, target: string): Promise<{ text: string; exitCode?: number }> {
  const cfg = await loadConfig($)
  if (!cfg) return { text: 'q-pilot: no q-pilot.config.json at the project root, so there is nothing to run. Run /q-pilot init.', exitCode: 1 }
  let args: string[]
  if (target === 'all') args = ['run', '--all']
  else if (target) {
    const bad = idError('/q-pilot run [all|<id>]', target)
    if (bad) return bad
    args = ['run', '--flows', target]
  } else {
    const sel = selectFlows(await read($, edits), await loadFlows($, cfg), cfg, 'affected')
    if (sel.mode === 'none') return { text: 'No UI-relevant edits pending that a flow covers. Use /q-pilot run all or /q-pilot run <id>.' }
    args = ['run', '--flows', sel.ids.join(',')]
  }
  $.ui.status('pilot running…')
  const out = await runRunner($, o, args, COMMAND_TIMEOUT_MS)
  if ('unavailable' in out || 'error' in out) {
    const why = 'unavailable' in out ? out.unavailable : out.error
    $.ui.status(`pilot ⚠ ${cap(why, 80)}`)
    return { text: `q-pilot: ${why}`, exitCode: 1 }
  }
  const flows = (out.result.flows ?? []) as PilotFlow[]
  const run: PilotRun = { runId: out.result.runId ?? `${await $.clock.now()}`, startedAt: await $.clock.now(), durationMs: out.result.durationMs ?? 0, reason: 'command', flows }
  await recordRun($, o, run)
  const lines = [summarize(flows, o.trust), ...flows.map(f => flowLine(f, o.trust))]
  if (flows.some(f => f.outcome === 'drift' || (f.recorded && f.outcome === 'pass'))) lines.push('Proposals are in the run; /q-pilot accept [<id>] makes them the traces.')
  if (out.result.runDir) lines.push(`run: ${out.result.runDir}`)
  return { text: lines.join('\n'), exitCode: flows.some(f => isBad(f, o.trust)) ? 1 : 0 }
}

async function commandRecord($: EngineInterface, o: Opts, id: string): Promise<{ text: string; exitCode?: number }> {
  const bad = idError('/q-pilot record <id>', id)
  if (bad) return bad
  $.ui.status(`pilot recording ${id}…`)
  const out = await runRunner($, o, ['record', '--flow', id], COMMAND_TIMEOUT_MS)
  if ('unavailable' in out || 'error' in out) return { text: `q-pilot: ${'unavailable' in out ? out.unavailable : out.error}`, exitCode: 1 }
  const f = out.result.flows?.find(x => x.id === id) ?? out.result.flows?.[0]
  if (!f) return { text: 'q-pilot: the runner answered without a flow result.', exitCode: 1 }
  await setLast($, [f], out.result.runId ?? '', await $.clock.now())
  $.ui.invalidate('ui.render')
  if (f.outcome === 'needs-verify') {
    return {
      text: [`${id}: the flow has no verify block, so nothing was recorded.`, `Suggested verify (a person writes it, then records again):`, JSON.stringify(f.suggestedVerify ?? null, null, 2)].join('\n'),
      exitCode: 1,
    }
  }
  if (f.outcome === 'pass') return { text: `${id}: recorded, verify passed; the trace is in .q-pilot/traces/${id}.json.` }
  return { text: [`${id}: ${f.outcome}; no trace written.`, flowLine(f, o.trust)].join('\n'), exitCode: 1 }
}

async function commandAccept($: EngineInterface, o: Opts, id: string): Promise<{ text: string; exitCode?: number }> {
  const run = await read($, lastRun)
  if (id) {
    const bad = idError('/q-pilot accept [<id>]', id)
    if (bad) return bad
    const known = run?.flows.find(f => f.id === id && f.proposal)
    const why = await acceptFlow($, o, id, known ? run?.runId : undefined)
    return why ? { text: `q-pilot: could not accept ${id}: ${why}`, exitCode: 1 } : { text: `Accepted ${id}: the proposal is now .q-pilot/traces/${id}.json. Commit it with your change.` }
  }
  const pending = run?.flows.filter(f => f.proposal && !f.accepted && (f.outcome === 'drift' || (f.outcome === 'pass' && f.recorded))) ?? []
  if (pending.length === 0) return { text: 'Nothing to accept: the last run left no drift or fresh recording.' }
  const lines: string[] = []
  let failed = false
  for (const f of pending) {
    const why = await acceptFlow($, o, f.id, run?.runId)
    if (why) failed = true
    lines.push(why ? `  ✗ ${f.id}: ${why}` : `  ✓ ${f.id}: accepted`)
  }
  return { text: ['q-pilot accept:', ...lines].join('\n'), ...(failed ? { exitCode: 1 } : {}) }
}

async function commandExport($: EngineInterface, o: Opts, id: string): Promise<{ text: string; exitCode?: number }> {
  const bad = idError('/q-pilot export <id>', id)
  if (bad) return bad
  const out = await runRunner($, o, ['export', '--flow', id], 60_000)
  if ('unavailable' in out || 'error' in out) return { text: `q-pilot: ${'unavailable' in out ? out.unavailable : out.error}`, exitCode: 1 }
  const where = [out.result.out, out.result.path, out.result.file].find((v): v is string => typeof v === 'string')
  return { text: where ? `Exported ${id} to ${where}.` : `Exported ${id}.` }
}

/** Writes q-pilot.config.json and the example flow, each only when missing: never overwrites. */
async function commandInit($: EngineInterface): Promise<{ text: string; exitCode?: number }> {
  const root = await $.session.root()
  const files: [string, unknown][] = [
    [CONFIG_FILE, EXAMPLE_CONFIG],
    [`${DEFAULT_FLOWS_DIR}/example.flow.json`, EXAMPLE_FLOW],
  ]
  const lines: string[] = []
  let failed = false
  for (const [rel, content] of files) {
    try {
      if (await $.fs.exists(`${root}/${rel}`)) {
        lines.push(`  · keep ${rel}`)
        continue
      }
      await $.fs.write(`${root}/${rel}`, `${JSON.stringify(content, null, 2)}\n`)
      lines.push(`  + write ${rel}`)
    } catch (err) {
      failed = true
      lines.push(`  ✗ ${rel}: ${errMsg(err)}`)
    }
  }
  lines.push('Set baseURL, then write a flow: a goal, fixtures, and a verify block (you write verify; Jev never does).', 'Add `.q-pilot/runs/` to .gitignore; commit `.q-pilot/traces/`.')
  return { text: ['q-pilot init:', ...lines].join('\n'), ...(failed ? { exitCode: 1 } : {}) }
}

// ---- register --------------------------------------------------------------------------------------

export const register: Register = (on, options) => {
  const o = optsOf(options)
  /** A fallback run in flight: a second one, or a /q-pilot command, must not share the runner. */
  let busy = false

  on('session.start', async ($, e, next) => {
    await update($, interactive, () => e.isInteractive !== false).catch(() => undefined)
    try {
      const saved = await $.store.get('lastRun')
      if (saved && typeof saved === 'object') {
        await update($, lastRun, () => saved as PilotRun)
        $.ui.status(`pilot ${summarize((saved as PilotRun).flows, o.trust)}`)
      }
      const last = await $.store.get('lastByFlow')
      if (last && typeof last === 'object') await update($, lastByFlow, () => last as Record<string, PilotLast>)
      const mode = await $.store.get('mode')
      if (mode === 'off' || mode === 'affected' || mode === 'all') await update($, modeOverride, () => mode)
    } catch {
      // Defaults stand when the store cannot be read.
    }
    await $.command.register({
      name: 'q-pilot',
      description: 'Run, record and accept the user flows a change affects',
      argumentHint: 'run [all|<id>] | record <id> | accept [<id>] | status | export <id> | init | mode off|affected|all',
    })
    await $.tool.register({
      name: TOOL,
      description: 'The last real q-pilot run of this project: outcome per flow (pass, drift, app-bug, blocked, env), failed checks with actual values, age. Call it before saying the user flows work, and quote it.',
      inputSchema: { type: 'object', properties: {} },
    })
    return next(e)
  })

  // ---- the model's evidence tool -------------------------------------------------------------------

  // The host takes a string or a content array as a tool result, never an object.
  on('tool.call', { tool: TOOL_RE }, async $ => ({ result: JSON.stringify(await statusJson($, o)) })).catch(() => ({
    result: JSON.stringify({ error: 'q-pilot could not read its evidence store' }),
  }))

  // ---- edit recorder -------------------------------------------------------------------------------

  on('tool.call', async ($, e, next) => {
    const r = await next(e)
    if (!EDIT_TOOLS.has(e.tool) || r.deny || r.isError || e.agentId) return r
    const raw = (e as { file_path?: unknown; notebook_path?: unknown }).file_path ?? (e as { notebook_path?: unknown }).notebook_path
    if (typeof raw !== 'string' || !raw) return r
    const path = await relPath($, raw)
    if (!path) return r
    await update($, edits, list => (list.includes(path) ? list : [...list, path]))
    return r
  }).catch(($, e, next) => next(e))

  // ---- the stop gate -------------------------------------------------------------------------------

  on('classic.Stop', async ($, e, next) => {
    // Marked first: the turn.complete fallback skips a turn whose Stop reached this hook, gated or not.
    if (!e.agent_id) {
      const turnId = await read($, currentTurn)
      const at = await $.clock.now()
      await update($, stopSeen, () => ({ turnId, at }))
    }
    const r = await next(e)
    // A subagent's stop, or another hook already blocking: not ours to gate.
    if (e.agent_id || r.block) return r
    if (busy) return r
    busy = true
    try {
      const g = await gate($, o, { stopHookActive: e.stop_hook_active === true })
      return g?.block ? { ...r, block: followUpText(g.block, g.run, e.last_assistant_message ?? '', o.trust) } : r
    } finally {
      busy = false
    }
  }).catch(($, e, next) => {
    $.ui.toast('q-pilot: the stop gate failed; letting the turn end', { timeoutMs: 8000 })
    return next(e)
  })

  // ---- the fallback gate: turn tracking and the follow-up cap ---------------------------------------

  on('turn.start', async ($, e, next) => {
    const r = await next(e)
    await update($, currentTurn, () => e.turnId)
    return r
  }).catch(($, e, next) => next(e))

  on('prompt.submit', async ($, e, next) => {
    // The person's own prompt resets the cap; our follow-ups (origin plugin) do not.
    if (USER_ORIGINS.has(e.origin?.kind)) await update($, followUps, () => 0)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    if (e.agentId) return r
    const seen = await read($, stopSeen)
    await update($, stopSeen, () => null)
    if (e.isAborted || e.reason !== 'answer') return r
    const now = await $.clock.now()
    // By turn id when turn.start gave one, else by time: a Stop within this turn's span.
    const handled = !!seen && (seen.turnId ? seen.turnId === e.turnId : now - seen.at <= e.durationMs + 1000)
    if (handled || busy) return r
    busy = true
    const job = fallbackGate($, o, e.answer)
      .catch(err => $.ui.toast(`q-pilot: the fallback gate failed: ${errMsg(err)}`, { timeoutMs: 8000 }))
      .finally(() => {
        busy = false
      })
    // Detached under a person, so the turn ends at once; awaited in -p / SDK runs, which exit after the turn.
    if (await read($, interactive)) void job
    else await job
    return r
  }).catch(($, e, next) => next(e))

  // ---- /q-pilot ------------------------------------------------------------------------------------

  on('command.run', { command: 'q-pilot' }, async ($, e) => {
    const args = e.args.trim()
    const [sub = 'status', ...rest] = args.split(/\s+/).filter(Boolean)
    const busyText = { text: 'q-pilot: a gate run is in progress; try again when it ends.', exitCode: 1 }
    switch (sub) {
      case 'run':
        if (busy) return busyText
        return commandRun($, o, rest[0] ?? '')
      case 'record':
        if (busy) return busyText
        return commandRecord($, o, rest[0] ?? '')
      case 'accept':
        if (busy) return busyText
        return commandAccept($, o, rest[0] ?? '')
      case 'export':
        return commandExport($, o, rest[0] ?? '')
      case 'status':
        return { text: await describeStatus($, o) }
      case 'init':
        return commandInit($)
      case 'mode': {
        const m = rest[0]
        if (m !== 'off' && m !== 'affected' && m !== 'all') return { text: `mode is ${await effectiveMode($, o)}. Usage: /q-pilot mode off|affected|all`, exitCode: 2 }
        await update($, modeOverride, () => m)
        await $.store.set('mode', m).catch(() => undefined)
        return { text: `q-pilot mode ${m}.` }
      }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  })

  // ---- band above the prompt: only while a flow is red or drifted ----------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    if (e.props.hasSurvey) return next(e)
    const run = await read($, lastRun)
    const bad = run?.flows.filter(f => isBad(f, o.trust)) ?? []
    if (!run || bad.length === 0) return next(e)
    const driftOnly = bad.every(f => f.outcome === 'drift')
    const { Box, Text } = $.ui.resolve(e)
    return (
      <Box flexDirection="row" gap={2}>
        <Text key="red" wrap="truncate" color={driftOnly ? WARN_HEX : RED_HEX}>
          {`pilot ${summarize(run.flows, o.trust)}${driftOnly ? ' · /q-pilot accept' : ''}`}
        </Text>
      </Box>
    )
  })
}
