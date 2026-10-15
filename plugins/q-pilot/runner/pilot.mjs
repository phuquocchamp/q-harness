#!/usr/bin/env node
// q-pilot runner CLI: node runner/pilot.mjs <command> --root <projectDir> [options]. See DESIGN.md.
// stdout: exactly one line, the result JSON. stderr: progress.
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ConfigError, flowIds, ID, loadConfig, loadFlow } from './flow.mjs'
import { createJev } from './jev.mjs'
import { ensureServer, ServerError, stopAllServers } from './server.mjs'
import { accept, newRun, readTrace, RUN_ID, writeResult } from './trace.mjs'
import { runFlow } from './run.mjs'

const FLAGS = { all: true, 'no-jev': true }

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

function playwrightFor(root) {
  const req = createRequire(join(root, 'package.json'))
  for (const name of ['playwright', '@playwright/test']) {
    try {
      return req(name)
    } catch {}
  }
  throw new ConfigError(`playwright not found in ${root}: install playwright or @playwright/test in the project`)
}

async function runCommand(command, opts, root, cfg, env) {
  const started = Date.now()
  const deadline = started + (num(opts['budget-ms'], 'budget-ms') ?? Infinity)
  const jev = createJev({
    apiKey: opts['no-jev'] ? '' : env.TYPESAFE_API_KEY,
    model: opts['jev-model'],
    timeoutMs: num(opts['jev-timeout-ms'], 'jev-timeout-ms'),
  })
  const ids = command === 'record' ? [opts.flow] : opts.all ? flowIds(root, cfg) : (opts.flows ?? '').split(',').filter(Boolean)
  if (!ids.length || ids.includes(undefined)) throw new ConfigError(command === 'record' ? '--flow is required' : '--flows a,b or --all is required')
  const { runId, runDir } = newRun(root)
  let server, browser, stopped = false
  const flows = []
  const cleanup = async () => {
    stopped = true
    stopAllServers()
    await browser?.close().catch(() => {})
  }
  const onSignal = sig => () => cleanup().finally(() => process.exit(sig === 'SIGINT' ? 130 : 143))
  const handlers = ['SIGTERM', 'SIGINT'].map(sig => [sig, onSignal(sig)])
  for (const [sig, h] of handlers) process.on(sig, h)
  const work = async () => {
    let serverError = null
    try {
      server = await ensureServer(cfg, root)
    } catch (e) {
      if (!(e instanceof ServerError)) throw e
      serverError = e.message
    }
    const ctx = {
      root, cfg, jev, env, deadline, runDir,
      getBrowser: async () => {
        if (stopped) throw new Error('command stopped')
        return (browser ||= await playwrightFor(root).chromium.launch({ headless: true }))
      },
    }
    for (const id of ids) {
      if (stopped) return
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
  // Hard deadline for the whole command, so a slow server start, goto or verify cannot overrun --budget-ms.
  let timer
  const hard = Number.isFinite(deadline) ? new Promise(res => (timer = setTimeout(res, deadline - Date.now() + 5000, 'hard'))) : new Promise(() => {})
  const work$ = work()
  work$.catch(() => {})
  let outcome
  try {
    outcome = await Promise.race([work$.then(() => 'done'), hard])
  } finally {
    clearTimeout(timer)
    for (const [sig, h] of handlers) process.off(sig, h)
    await cleanup()
  }
  if (outcome === 'hard') return { ok: false, command, runId, runDir, error: `hard deadline exceeded (--budget-ms + 5 s); completed flows: ${flows.map(f => f.id).join(', ') || 'none'}` }
  await work$
  const result = { ok: true, command, runId, runDir, startedAt: new Date(started).toISOString(), durationMs: Date.now() - started, flows }
  writeResult(runDir, result)
  return result
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

/** Runs a command and returns its result object. Exported for tests; `env` carries TYPESAFE_API_KEY and $env: fixtures. */
export async function main(argv, env = process.env) {
  let command
  try {
    const parsed = parseArgs(argv)
    command = parsed.command
    const { opts } = parsed
    if (!['run', 'record', 'accept', 'export', 'list'].includes(command)) throw new ConfigError(`unknown command "${command ?? ''}"`)
    if (!opts.root) throw new ConfigError('--root is required')
    const root = isAbsolute(opts.root) ? opts.root : resolve(opts.root)
    if (!existsSync(root)) throw new ConfigError(`root ${root} does not exist`)
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
  process.exit(0)
}
