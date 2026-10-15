// One flow, start to outcome: replay (or record), verify, re-run on a failed verify, classify.
import { join } from 'node:path'
import { unlinkSync } from 'node:fs'
import { resolveFixtures } from './flow.mjs'
import { redact, redactDeep } from './redact.mjs'
import { observe } from './snapshot.mjs'
import { onLogin } from './act.mjs'
import { replay } from './replay.mjs'
import { pilot } from './record.mjs'
import { runVerify, suggestVerify } from './verify.mjs'
import { shot } from './shot.mjs'
import { buildTrace, readTrace, writeProposal, writeTrace } from './trace.mjs'

const VIEWPORT = { width: 1280, height: 720 }

/** One run in a fresh browser context: open start, replay `trace` (or pilot when null), then verify. */
async function attempt(ctx, flow, fixtures, trace, { allowJev, shotFile }) {
  const context = await ctx.browser.newContext({ baseURL: ctx.cfg.baseURL, viewport: VIEWPORT })
  const page = await context.newPage()
  page.setDefaultTimeout(5000)
  const secrets = Object.values(fixtures)
  try {
    try {
      await page.goto(flow.start, { waitUntil: 'domcontentloaded', timeout: 10000 })
    } catch (e) {
      return { end: 'env', error: `start not reachable: ${e.message.split('\n')[0]}`, steps: [], diverged: [] }
    }
    if (onLogin(page, ctx.cfg.loginPath, flow.start)) return { end: 'env', error: `redirected to ${ctx.cfg.loginPath}`, steps: [], diverged: [] }
    const jev = allowJev ? ctx.jev : { available: false }
    const deadline = Math.min(ctx.deadline, Date.now() + flow.budget.seconds * 1000)
    const r = trace
      ? await replay(page, { flow, trace, fixtures, jev, loginPath: ctx.cfg.loginPath, deadline, shotFile })
      : await pilot(page, { flow, fixtures, jev, loginPath: ctx.cfg.loginPath, deadline })
    if (r.end === 'done') {
      r.verifyFails = await runVerify(page, flow.verify, { secrets })
      if (!flow.verify.length) r.suggestedVerify = await suggestVerify(page, secrets)
    }
    // Failure pictures are taken while the page is still open; a heal picture already exists for a drift.
    if ((r.end === 'blocked' || r.verifyFails?.length) && shotFile) {
      const caption = r.verifyFails?.length ? redact(`verify failed: ${r.verifyFails.map(f => JSON.stringify(f.check)).join(' ')}`, secrets) : r.error
      await shot(page, await observe(page).catch(() => ({ actions: [] })), shotFile, caption ?? 'blocked').catch(() => {})
    }
    return r
  } finally {
    await context.close()
  }
}

const brief = steps => steps.map(({ op, role, name, by }) => ({ op, ...(role && { role, name }), by }))

/**
 * Runs one flow. `mode` is 'run' (replay, record when untraced) or 'record' (always pilot).
 * ctx: { root, cfg, jev, env, deadline, runDir, getBrowser }
 */
export async function runFlow(ctx, flow, mode) {
  const t0 = Date.now()
  const jev0 = { calls: ctx.jev.calls, ms: ctx.jev.ms.length }
  const res = { id: flow.id, outcome: 'error', durationMs: 0, recorded: false, jevCalls: 0, jevMs: [], steps: [], diverged: [], verifyFails: [], proposal: null, screenshot: null, error: null }
  let secrets = []
  const done = (outcome, error = null, extra = {}) => {
    Object.assign(res, { outcome, error, ...extra })
    // Everything that leaves the runner is redacted; paths are left alone.
    for (const k of ['steps', 'diverged', 'verifyFails', 'error', 'suggestedVerify']) if (res[k]) res[k] = redactDeep(res[k], secrets)
    res.durationMs = Date.now() - t0
    res.jevCalls = ctx.jev.calls - jev0.calls
    res.jevMs = ctx.jev.ms.slice(jev0.ms)
    return res
  }
  try {
    const { values: fixtures, missing } = resolveFixtures(flow, ctx.env)
    if (missing.length) return done('env', `missing environment variable ${missing.join(', ')} for fixtures`)
    secrets = Object.values(fixtures)
    let trace = mode === 'record' ? null : readTrace(ctx.root, flow.id)
    if (!trace && !ctx.jev.available) {
      return mode === 'record' ? done('blocked', 'jev unavailable') : done('untraced', 'no trace and jev unavailable')
    }
    if (Date.now() > ctx.deadline) return done('skipped', 'command budget spent')
    const browser = await ctx.getBrowser()
    const shotFile = join(ctx.runDir, `${flow.id}.png`)
    const first = await attempt({ ...ctx, browser }, flow, fixtures, trace, { allowJev: true, shotFile })
    Object.assign(res, { steps: brief(first.steps), diverged: first.diverged })
    if (first.end === 'env') return done('env', first.error)
    if (first.end === 'blocked') return done('blocked', first.error, { screenshot: shotFile })

    if (!first.verifyFails.length) {
      const recorded = !trace
      // Nothing verified is never a pass.
      if (!flow.verify.length) return done('needs-verify', null, { recorded, suggestedVerify: first.suggestedVerify })
      const version = trace ? trace.version + 1 : 1
      const proposed = buildTrace(flow.id, first.steps, version, secrets)
      if (mode === 'record') return done('pass', null, { recorded: true, trace: writeTrace(ctx.root, proposed) })
      if (recorded || first.diverged.length) res.proposal = writeProposal(ctx.runDir, proposed)
      return done(first.diverged.length ? 'drift' : 'pass', null, { recorded, screenshot: first.diverged.length ? shotFile : null })
    }

    // Verify failed: one more run in a fresh context, replaying the steps as run, with no model.
    const second = await attempt({ ...ctx, browser }, flow, fixtures, buildTrace(flow.id, first.steps, 1, secrets), { allowJev: false, shotFile: null })
    if (second.end === 'env') return done('env', `re-run: ${second.error}`, { verifyFails: first.verifyFails })
    if (second.end !== 'done') return done('blocked', `re-run did not complete: ${second.error}`, { verifyFails: first.verifyFails, screenshot: shotFile })
    if (!second.verifyFails.length) {
      try { unlinkSync(shotFile) } catch {}
      return done('flaky', null, { verifyFails: first.verifyFails })
    }
    return done('app-bug', null, { verifyFails: first.verifyFails, screenshot: shotFile })
  } catch (e) {
    return done('error', String(e.message || e).split('\n')[0])
  }
}
