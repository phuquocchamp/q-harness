#!/usr/bin/env node
// q-pilot runner CLI: node runner/pilot.mjs <command> --root <projectDir> [options]. Commands are listed in main().
// stdout: exactly one line, the result JSON. stderr: progress.
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConfigError, flowIds, ID, loadConfig, loadConfigOptional, loadFlow, validateSpec, validateTask } from './flow.mjs'
import { blankEntry, runExplore } from './explore.mjs'
import { createJev } from './jev.mjs'
import { closeBrowser, openBrowser, resolvePlaywright, storageStateOf } from './driver.mjs'
import { ensureServer, ServerError, stopAllServers } from './server.mjs'
import { accept, newRun, readTrace, RUN_ID, saveRun, writeResult } from './trace.mjs'
import { runFlow } from './run.mjs'
import { createInspector, DEFAULT_PORT } from './inspect.mjs'
import { createHelper } from './help.mjs'
import { askViaCli, askViaMod, createAsker } from './ask.mjs'
import { saveViaMod } from './settings-save.mjs'
import { visionDefaults } from './record.mjs'
import { spawn } from 'node:child_process'

const FLAGS = { all: true, 'no-jev': true, inspect: true, 'inspect-pause': true, help: true, linger: true, 'ask-via-mod': true, box: true, dashboard: true, 'keep-trace': true }
/** With a dashboard open, the final state stays on screen this long before the browser closes. */
const HOLD_MS = 3000

function parseArgs(argv) {
  const [command, ...rest] = argv
  const opts = {}
  for (let i = 0; i < rest.length; i++) {
    const m = /^--([\w-]+)$/.exec(rest[i])
    if (!m) throw new ConfigError(`unexpected argument "${rest[i]}"`)
    if (FLAGS[m[1]]) opts[m[1]] = true
    else if (i + 1 >= rest.length) throw new ConfigError(`--${m[1]} needs a value`)
    else opts[m[1]] = rest[++i]
  }
  return { command, opts }
}

const num = (v, name) => {
  if (v === undefined) return undefined
  if (!(Number(v) > 0)) throw new ConfigError(`--${name} must be a positive number`)
  return Number(v)
}

/**
 * The browser window is shown by default so a run can be watched live. Headless when Q_PILOT_HEADLESS=1, in CI,
 * or on Linux without a display (a headed launch would fail there). Read from process.env: a machine preference.
 */
export function headless(env = process.env, platform = process.platform) {
  if (env.Q_PILOT_HEADLESS === '1' || env.CI) return true
  return platform === 'linux' && !env.DISPLAY && !env.WAYLAND_DISPLAY
}

async function runCommand(command, opts, root, cfg, env, spec) {
  const started = Date.now()
  // Moves while Claude is asked for help (ctx.extend): time waiting for an answer is not the run's time.
  let deadline = started + (num(opts['budget-ms'], 'budget-ms') ?? Infinity)
  const jev = createJev({
    apiKey: opts['no-jev'] ? '' : env.TYPESAFE_API_KEY,
    model: opts['jev-model'],
    timeoutMs: num(opts['jev-timeout-ms'], 'jev-timeout-ms'),
  })
  const prompted = command === 'explore' || command === 'task'
  const ids = prompted ? [spec.name] : command === 'record' ? [opts.flow] : opts.all ? flowIds(root, cfg) : (opts.flows ?? '').split(',').filter(Boolean)
  if (!ids.length || ids.includes(undefined)) throw new ConfigError(command === 'record' ? '--flow is required' : '--flows a,b or --all is required')
  // Resolved up front so a missing Playwright is one clear error, before any server starts.
  const playwright = resolvePlaywright(root, env)
  const storageState = storageStateOf(root, cfg)
  const { runId, runDir } = newRun(root)
  let server, launching, stopped = false, signaled = null
  const flows = []
  // The dashboard: started before the browser so a person can open it from the URL on stderr at once.
  // Jev vision (preview, docs.typesafe.ai/images): --vision off|gated|always, --vision-model, --box. The inspector
  // shares this object and may change it during the run.
  const vision = visionOf(opts)
  // Where the mod's settings came from (--settings-sources); saving one goes back through the mod, which is the only writer.
  const sources = sourcesOf(opts)
  const settings = sources && { sources, save: opts['ask-via-mod'] ? saveViaMod({ runDir }) : null }
  // "Ask Claude" in the dashboard: through the mod (the session's own client) when it started the run, else the CLI.
  const asker = createAsker(opts['ask-via-mod']
    ? { transport: askViaMod({ runDir }), via: 'session' }
    : { transport: askViaCli({ cwd: root }), via: 'cli', screenshotFor: f => frameShot(runDir, f) })
  // Opens the run's Playwright trace in Playwright's own viewer, from the dashboard (a separate window).
  const openTrace = file => {
    const cli = join(playwright.path, 'cli.js')
    if (!existsSync(cli)) return console.error(`[q-pilot] no Playwright CLI at ${cli}`)
    spawn(process.execPath, [cli, 'show-trace', file], { detached: true, stdio: 'ignore' }).unref()
  }
  const inspector = prompted && (opts.inspect || opts['inspect-pause'])
    ? await createInspector({ port: num(opts['inspect-port'], 'inspect-port') ?? (Number(env.Q_PILOT_INSPECT_PORT) || DEFAULT_PORT), mode: opts['inspect-pause'] ? 'pause' : 'run', asker, sessionModel: opts['session-model'] ?? null, openTrace, vision, settings })
    : null
  // --linger: the dashboard stays up after the run (the result is printed first); see the CLI entry at the end.
  const linger = Boolean(inspector && opts.linger && !headless())
  if (inspector) console.error(`[q-pilot] inspector ${inspector.url}`)
  let dashboard = null
  // Started once and shared; begun next to the server start so the two overlap.
  const launch = () => (launching ||= Promise.resolve().then(() => openBrowser(playwright.pw, env, { headless: headless(), dashboard: Boolean(opts.dashboard), title: ids.length === 1 ? `${command} ${ids[0]}` : command, root })))
  const cleanup = async () => {
    stopped = true
    stopAllServers()
    await dashboard?.close().catch(() => {})
    await inspector?.close().catch(() => {})
    await launching?.then(b => closeBrowser(b.browser)).catch(() => {})
  }
  const onSignal = sig => () => {
    signaled = sig
    cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143))
  }
  const handlers = ['SIGTERM', 'SIGINT'].map(sig => [sig, onSignal(sig)])
  for (const [sig, h] of handlers) process.on(sig, h)
  const work = async () => {
    let serverError = null
    // Headless only: a visible window should not open for a run that ends before any flow needs it.
    if (headless()) launch().catch(() => {}) // a launch error is reported by the first getBrowser()
    try {
      server = await ensureServer(cfg, root)
    } catch (e) {
      if (!(e instanceof ServerError)) throw e
      serverError = e.message
    }
    const ctx = {
      root, cfg, jev, env, runDir, storageState, inspector,
      // A dashboard that stays up for review (or --keep-trace) keeps the run's Playwright trace whatever the outcome.
      keepTrace: linger || Boolean(opts['keep-trace']),
      vision,
      get deadline() { return deadline },
      extend: ms => {
        deadline += ms
        arm()
      },
      // task --help: the pilot loop may hand the run to Claude (help.mjs); the mod answers through the run dir.
      makeHelper: command === 'task' && opts.help ? o => createHelper({ runDir, runId, ...o }) : undefined,
      getBrowser: async () => {
        if (stopped) throw new Error('command stopped')
        return await launch()
      },
    }
    for (const id of ids) {
      if (stopped) return
      if (prompted) {
        if (serverError) flows.push(blankEntry(id, 'env', serverError))
        else if (Date.now() > deadline) flows.push(blankEntry(id, 'skipped', 'command budget spent'))
        else {
          console.error(`[q-pilot] ${command} ${id}`)
          if (inspector && !headless() && !dashboard) dashboard = openInUserBrowser(inspector.url)
          // A cold browser start can be slow; the dashboard catches up on connect (the full state is sent then).
          if (dashboard) await inspector.waitForClient(5000)
          const f = await runExplore(ctx, spec)
          flows.push(f)
          inspector?.end({ outcome: f.outcome, error: f.error, checks: f.checks })
          inspector?.files({ trace: f.trace, decisions: f.decisions, screenshot: f.screenshot })
          if (dashboard && inspector.clients && !linger) await new Promise(r => setTimeout(r, Math.max(0, Math.min(HOLD_MS, deadline - Date.now()))))
        }
        continue
      }
      let flow
      try {
        flow = loadFlow(root, cfg, id)
      } catch (e) {
        flows.push({ id, outcome: 'error', error: e.message, durationMs: 0, recorded: false, jevCalls: 0, jevMs: [], steps: [], diverged: [], verifyFails: [], proposal: null, screenshot: null })
        continue
      }
      if (serverError) flows.push({ id, outcome: 'env', error: serverError, durationMs: 0, recorded: false, jevCalls: 0, jevMs: [], steps: [], diverged: [], verifyFails: [], proposal: null, screenshot: null })
      else if (Date.now() > deadline) flows.push({ id, outcome: 'skipped', error: 'command budget spent', durationMs: 0, recorded: false, jevCalls: 0, jevMs: [], steps: [], diverged: [], verifyFails: [], proposal: null, screenshot: null })
      else {
        console.error(`[q-pilot] ${command} ${id}`)
        flows.push(await runFlow(ctx, flow, command))
      }
    }
  }
  // Hard deadline for the whole command, so a slow server start, goto or verify cannot overrun --budget-ms. Re-armed
  // when the deadline moves.
  let timer, fire
  const hard = new Promise(res => (fire = res))
  const arm = () => {
    clearTimeout(timer)
    if (Number.isFinite(deadline)) timer = setTimeout(fire, Math.max(0, deadline - Date.now() + 5000), 'hard')
  }
  arm()
  const work$ = work()
  work$.catch(() => {})
  let outcome
  try {
    outcome = await Promise.race([work$.then(() => 'done'), hard])
  } finally {
    clearTimeout(timer)
    // A lingering dashboard keeps its browser and server (and the signal handlers that close them) until it closes.
    if (!(linger && outcome === 'done' && !signaled)) {
      for (const [sig, h] of handlers) process.off(sig, h)
      await cleanup()
    }
  }
  // A signal ends the command: never report it as a finished run (the handler exits with 130/143).
  if (signaled) return { ok: false, command, runId, runDir, signal: signaled, error: `stopped by ${signaled}` }
  if (outcome === 'hard') return { ok: false, command, runId, runDir, error: `hard deadline exceeded (--budget-ms + 5 s); completed flows: ${flows.map(f => f.id).join(', ') || 'none'}` }
  await work$
  const result = { ok: true, command, runId, runDir, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, playwright: { from: playwright.from, version: playwright.version }, flows }
  writeResult(runDir, result)
  if (linger) {
    // Not part of the JSON: the CLI prints the result, then waits here until the dashboard is closed.
    Object.defineProperty(result, 'linger', {
      value: async () => {
        await inspector.lingering()
        for (const [sig, h] of handlers) process.off(sig, h)
        await cleanup()
      },
    })
  }
  return result
}

export const VISION_MODES = ['off', 'gated', 'always']
export const VISION_MODELS = ['jev-1.13.0', 'jev-1.14.0']
/** The vision settings from the flags; a bad value is a ConfigError, like any other flag. */
function sourcesOf(opts) {
  if (opts['settings-sources'] === undefined) return null
  let v
  try { v = JSON.parse(opts['settings-sources']) } catch {}
  if (!v || typeof v !== 'object' || Array.isArray(v)) throw new ConfigError('--settings-sources must be a JSON object')
  return v
}

function visionOf(opts) {
  const v = visionDefaults()
  if (opts.vision !== undefined) {
    if (!VISION_MODES.includes(opts.vision)) throw new ConfigError(`--vision must be one of ${VISION_MODES.join(', ')}`)
    v.mode = opts.vision
  }
  if (opts['vision-model'] !== undefined) {
    if (!VISION_MODELS.includes(opts['vision-model'])) throw new ConfigError(`--vision-model must be one of ${VISION_MODELS.join(', ')}`)
    v.model = opts['vision-model']
  }
  v.box = Boolean(opts.box)
  return v
}

/** Writes a frame's screenshot for a model that reads files (the claude CLI); null when the frame has none. */
function frameShot(runDir, frame) {
  if (!frame?.screenshot) return null
  const file = join(runDir, `ask-frame-${frame.i}.jpg`)
  writeFileSync(file, Buffer.from(frame.screenshot, 'base64'))
  return file
}

/** The system's "open this URL" commands: macOS, Windows, else Linux. */
const OPENER = { darwin: ['open'], win32: ['cmd', '/c', 'start', '""'] }

/**
 * Opens the inspector in the person's default browser (their own profile), apart from the browser under test.
 * Returns { close } (the tab belongs to the person: closing the dashboard ends the server, not the tab), or null.
 */
function openInUserBrowser(url) {
  const [cmd, ...args] = OPENER[process.platform] ?? ['xdg-open']
  try {
    const child = spawn(cmd, [...args, url], { detached: true, stdio: 'ignore' })
    child.on('error', e => console.error(`[q-pilot] could not open the inspector (${e.message}); open ${url} yourself`))
    child.unref()
    return { close: async () => {} }
  } catch (e) {
    console.error(`[q-pilot] could not open the inspector (${e.message}); open ${url} yourself`)
    return null
  }
}

function listCommand(root, cfg) {
  const flows = flowIds(root, cfg).map(id => {
    try {
      const f = loadFlow(root, cfg, id)
      const trace = readTrace(root, id)
      return { id, covers: f.covers, tags: f.tags, hasTrace: Boolean(trace), urls: trace ? [...new Set(trace.steps.map(s => s.url))] : [] }
    } catch (e) {
      return { id, error: e.message }
    }
  })
  return { ok: true, command: 'list', flows }
}

async function exportCommand(opts, root, cfg) {
  if (!opts.flow) throw new ConfigError('--flow is required')
  const flow = loadFlow(root, cfg, opts.flow)
  const trace = readTrace(root, flow.id)
  if (!trace) throw new ConfigError(`no trace for "${flow.id}"; record it first`)
  let mod
  try {
    mod = await import('./export.mjs')
  } catch (e) {
    if (e.code === 'ERR_MODULE_NOT_FOUND' && /export\.mjs/.test(e.message)) return { ok: false, command: 'export', error: 'export module missing' }
    throw e
  }
  const out = resolve(root, opts.out ?? join('tests', 'q-pilot', `${flow.id}.spec.ts`))
  const rel = relative(root, out)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ConfigError('--out must resolve inside --root')
  mkdirSync(dirname(out), { recursive: true })
  writeFileSync(out, mod.exportSpec(flow, trace, { baseURL: cfg.baseURL }))
  return { ok: true, command: 'export', flow: flow.id, out }
}

async function exploreCommand(opts, root, env) {
  const invalid = error => ({ ok: true, command: 'explore', runId: null, runDir: null, durationMs: 0, flows: [blankEntry('explore', 'error', error)] })
  let raw
  if (Buffer.byteLength(opts['spec-json'] ?? '') > 32 * 1024) return invalid('--spec-json is larger than 32 KB')
  try {
    raw = JSON.parse(opts['spec-json'] ?? '')
  } catch {
    return invalid('--spec-json is required and must be valid JSON')
  }
  const cfg = loadConfigOptional(root, env)
  let spec
  try {
    spec = validateSpec(raw, cfg, env)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    return { ...invalid(e.message), flows: [blankEntry(typeof raw?.name === 'string' && ID.test(raw.name) ? raw.name : 'explore', 'error', e.message)] }
  }
  return await runCommand('explore', opts, root, { flowsDir: 'flows', ...cfg, baseURL: spec.baseURL }, env, spec)
}

/** Task mode: any browser task from a prompt, like jev-ultrafast. Checks are optional; `--inspect` opens the dashboard. */
async function taskCommand(opts, root, env) {
  const invalid = (error, id = 'task') => ({ ok: true, command: 'task', runId: null, runDir: null, durationMs: 0, flows: [blankEntry(id, 'error', error)] })
  let raw
  if (Buffer.byteLength(opts['spec-json'] ?? '') > 32 * 1024) return invalid('--spec-json is larger than 32 KB')
  try {
    raw = JSON.parse(opts['spec-json'] ?? '')
  } catch {
    return invalid('--spec-json is required and must be valid JSON')
  }
  const cfg = loadConfigOptional(root, env)
  let spec
  try {
    spec = validateTask(raw, cfg, env)
  } catch (e) {
    if (!(e instanceof ConfigError)) throw e
    return invalid(e.message, typeof raw?.name === 'string' && ID.test(raw.name) ? raw.name : 'task')
  }
  // A task on another site than the configured app must not start the app's dev server.
  const same = cfg && new URL(cfg.baseURL).origin === spec.baseURL
  return await runCommand('task', opts, root, { flowsDir: 'flows', ...(same ? cfg : { loginPath: undefined }), baseURL: spec.baseURL }, env, spec)
}

function saveCommand(opts, root, env) {
  if (!opts.run) throw new ConfigError('--run is required')
  const cfg = loadConfigOptional(root, env)
  try {
    return { ok: true, command: 'save', ...saveRun(root, cfg?.flowsDir ?? 'flows', opts.run, opts.name) }
  } catch (e) {
    return { ok: false, command: 'save', error: e.message.split('\n')[0] }
  }
}

/** Runs a command and returns its result object. Exported for tests; `env` carries TYPESAFE_API_KEY and $env: fixtures. */
export async function main(argv, env = process.env) {
  let command
  try {
    const parsed = parseArgs(argv)
    command = parsed.command
    const { opts } = parsed
    if (!['run', 'record', 'accept', 'export', 'list', 'explore', 'task', 'save'].includes(command)) throw new ConfigError(`unknown command "${command ?? ''}"`)
    if (!opts.root) throw new ConfigError('--root is required')
    const root = isAbsolute(opts.root) ? opts.root : resolve(opts.root)
    if (!existsSync(root)) throw new ConfigError(`root ${root} does not exist`)
    if (command === 'explore') return await exploreCommand(opts, root, env)
    if (command === 'task') return await taskCommand(opts, root, env)
    if (command === 'save') return saveCommand(opts, root, env)
    const cfg = loadConfig(root, env)
    if (command === 'list') return listCommand(root, cfg)
    if (command === 'export') return await exportCommand(opts, root, cfg)
    if (command === 'accept') {
      if (!opts.flow) throw new ConfigError('--flow is required')
      if (!ID.test(opts.flow)) throw new ConfigError(`invalid flow id "${opts.flow}": must match [a-z0-9-]+`)
      if (opts.run !== undefined && !RUN_ID.test(opts.run)) throw new ConfigError(`invalid run id "${opts.run}"`)
      const r = accept(root, opts.flow, opts.run)
      return r ? { ok: true, command, flow: opts.flow, ...r } : { ok: false, command, error: `no proposal for "${opts.flow}"${opts.run ? ` in run ${opts.run}` : ''}` }
    }
    return await runCommand(command, opts, root, cfg, env)
  } catch (e) {
    return { ok: false, command: command ?? null, error: String(e.message || e).split('\n')[0] }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await main(process.argv.slice(2))
  console.log(JSON.stringify(result))
  // --linger: the result is out (the caller has it); the inspector stays up for review until it is closed.
  if (result.linger) {
    console.error('[q-pilot] the inspector stays open for review; close it there (or wait 30 min)')
    await result.linger()
  }
  process.exit(result.signal === 'SIGINT' ? 130 : result.signal ? 143 : 0)
}
