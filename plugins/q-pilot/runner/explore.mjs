// Prompt mode and task mode: Jev drives every step toward the spec's goal, then code grades the spec's checks.
// A task may have no checks: its outcome then only says whether Jev reported DONE (`done`), which proves nothing.
import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveFixtures } from './flow.mjs'
import { observe } from './snapshot.mjs'
import { dismissConsent, makeGuard, onLogin, settleStart, trackNetwork } from './act.mjs'
import { pilot } from './record.mjs'
import { runChecks } from './verify.mjs'
import { askSoft, JevError } from './jev.mjs'
import { shot } from './shot.mjs'
import { redact, redactDeep } from './redact.mjs'
import { buildTrace, writeFlowProposal, writeProposal } from './trace.mjs'
import { openSession, TASK_VIEWPORT } from './driver.mjs'

/** A check that only looks at the url, the title or mere presence proves little about the business result. */
export const isWeak = c => 'url' in c || 'title' in c || !['text', 'contains', 'value'].some(k => k in c)

export const blankEntry = (id, outcome, error = null) => ({
  id, outcome, durationMs: 0, recorded: false, jevCalls: 0, jevMs: [], steps: [], diverged: [], verifyFails: [],
  checks: [], softChecks: [], warnings: [], proposal: null, flowProposal: null, screenshot: null, trace: null, pageErrors: [], error,
})

/** The chip name on the dashboard: the spec's own name, else (for the default "task"/"explore") a slug of the redacted goal. */
export function sessionName(spec, secrets = []) {
  if (!['task', 'explore'].includes(spec.name)) return spec.name
  const slug = redact(spec.goal, secrets).toLowerCase().replace(/[^a-z0-9]+/g, '-').slice(0, 40).replace(/^-+|-+$/g, '')
  return slug || spec.name
}

/**
 * Runs one validated spec. ctx: { jev, env, deadline, runDir, cfg, storageState, getBrowser, inspectorFor }. Always returns a flow
 * entry. The Playwright trace is kept unless the outcome is pass, and not recorded when the spec has secret fixtures.
 */
export async function runExplore(ctx, spec) {
  const t0 = Date.now()
  const jev0 = { calls: ctx.jev.calls, ms: ctx.jev.ms.length }
  const res = { ...blankEntry(spec.name, 'error'), baseURL: spec.baseURL }
  let secrets = []
  const done = (outcome, error = null) => {
    Object.assign(res, { outcome, error })
    for (const k of ['steps', 'error', 'verifyFails']) if (res[k]) res[k] = redactDeep(res[k], secrets)
    res.durationMs = Date.now() - t0
    res.jevCalls = ctx.jev.calls - jev0.calls
    res.jevMs = ctx.jev.ms.slice(jev0.ms)
    return res
  }
  try {
    const { values: fixtures, missing, secrets: secret } = resolveFixtures(spec, ctx.env)
    if (missing.length) return done('env', `missing environment variable ${missing.join(', ')} for fixtures`)
    secrets = secret
    // A DONE Claude confirmed on the page (task mode with a helper) is noted by doneBy; the warning stays: no check ran.
    if (!spec.checks.length) res.warnings.push('unverified')
    else if (spec.checks.every(isWeak)) res.warnings.push('weak-checks')
    const browser = await ctx.getBrowser()
    const session = await openSession(browser, { baseURL: spec.baseURL, storageState: ctx.storageState, traceFile: secrets.length ? null : join(ctx.runDir, `${spec.name}.trace.zip`), title: `q-pilot ${spec.task ? 'task' : 'test'} ${spec.name}`, ...(spec.task && { viewport: TASK_VIEWPORT }) })
    let live = null
    // The dashboard session of this flow (null without one); it ends in the finally below.
    const inspector = (await ctx.inspectorFor?.({ flowId: spec.name, name: sessionName(spec, secrets), goal: redact(spec.goal, secrets), secret: secrets.length > 0 })) ?? null
    try {
      const { page } = session
      trackNetwork(page)
      page.setDefaultTimeout(5000)
      const guard = makeGuard(spec.baseURL, ctx.env)
      const bad = guard.startError(spec.start)
      if (bad) return done('blocked', bad)
      try {
        await page.goto(spec.start, { waitUntil: 'domcontentloaded', timeout: 10000 })
      } catch (e) {
        return done('env', `start not reachable: ${e.message.split('\n')[0]}`)
      }
      const off = guard.check(page)
      if (off) return done('blocked', off)
      if (onLogin(page, ctx.cfg?.loginPath, spec.start)) return done('env', `redirected to ${ctx.cfg.loginPath}`)
      await settleStart(page)
      // Task mode runs on sites q-pilot does not know: a consent banner over the page is closed before Jev looks.
      if (spec.task) {
        const consent = await dismissConsent(page)
        if (consent) console.error(`[q-pilot] closed a consent banner: ${redact(consent, secrets)}`)
      }
      const flow = { id: spec.name, start: spec.start, goal: spec.goal, budget: spec.budget }
      // The loop's deadline moves with the command's while Claude is asked for help (ctx.extend).
      let loopDeadline = Math.min(ctx.deadline, Date.now() + spec.budget.seconds * 1000)
      const helper = ctx.makeHelper?.({ goal: spec.goal, secrets, fixtureKeys: Object.keys(fixtures), confirmDone: !spec.checks.length, onWait: ms => (loopDeadline += ms, ctx.extend?.(ms), inspector?.extend?.(ms)) }) ?? null
      inspector?.start({ name: spec.name, goal: spec.goal, deadline: loopDeadline, secrets })
      // With a helper: the checks are tried on Jev's DONE, so a red one reaches Claude while the browser is open.
      const checkDone = helper && spec.checks.length
        ? async p => (await runChecks(p, spec.checks, { secrets, timeoutMs: 1500 })).filter(c => !c.ok).map(({ check, actual }) => redactDeep({ check, actual }, secrets))
        : null
      // Vision settings are one object shared with the inspector, which may change them during the run.
      const r = await pilot(page, { flow, fixtures, secrets, jev: ctx.jev, loginPath: ctx.cfg?.loginPath, deadline: () => loopDeadline, guard, inspector, helper, checkDone, tracer: session, ...(ctx.vision && { vision: ctx.vision }) })
      if (helper) res.helpRequests = helper.used()
      if (r.by === 'claude') res.doneBy = 'claude'
      if (r.decisions?.length) {
        res.decisions = join(ctx.runDir, `${spec.name}.decisions.json`)
        writeFileSync(res.decisions, JSON.stringify(r.decisions, null, 2))
      }
      res.steps = r.steps.map(({ op, role, name, key, by, p }) => ({ op, ...(role && { role, name }), ...(key && { key }), by, p }))
      if (r.end === 'env') return done('env', r.error)

      // Checks always run, also after BLOCKED, so the caller sees the state. Code grades; Jev's DONE only ended the loop.
      // The run may have moved into a tab a click opened.
      live = r.page ?? page
      res.checks = spec.checks.length ? await runChecks(live, spec.checks, { secrets, timeoutMs: r.end === 'done' ? 2000 : 300 }) : []
      res.verifyFails = res.checks.filter(c => !c.ok).map(({ check, actual }) => ({ check, actual }))
      const snap = await observe(live).catch(() => ({ url: live.url(), title: '', text: '', actions: [] }))
      if (spec.softChecks.length && ctx.jev.available) {
        try {
          res.softChecks = await askSoft(ctx.jev, { goal: spec.goal, snap, questions: spec.softChecks, secrets })
        } catch (e) {
          if (!(e instanceof JevError)) throw e
          res.softChecks = spec.softChecks.map(question => ({ question, p: null }))
          res.warnings.push('soft-checks-unavailable')
        }
      }
      const outcome = r.end !== 'done' ? 'blocked' : !spec.checks.length ? 'done' : res.verifyFails.length ? 'fail' : 'pass'
      const file = join(ctx.runDir, `${spec.name}.png`)
      const caption = redact(`${spec.name}: ${outcome} (${r.end === 'done' ? (r.by === 'claude' ? 'Claude confirmed DONE' : 'Jev DONE') : r.error}) · checks ${!spec.checks.length ? 'none' : res.verifyFails.length ? `RED ${res.verifyFails.map(f => JSON.stringify(f.actual)).join(' ')}` : 'green'}`, secrets)
      await shot(live, snap, file, caption).then(() => (res.screenshot = file), () => {})
      if (outcome === 'pass') {
        res.proposal = writeProposal(ctx.runDir, buildTrace(spec.name, r.steps, 1, secrets))
        res.flowProposal = writeFlowProposal(ctx.runDir, {
          id: spec.name, start: spec.start, goal: spec.goal, fixtures: spec.fixtures, verify: spec.checks, covers: [], tags: [],
        })
        res.recorded = true
      }
      return done(outcome, outcome === 'blocked' ? r.error : null)
    } finally {
      // Before end(): a dashboard session carries these files in its end message. The trace only exists after the close below.
      inspector?.files({ decisions: res.decisions ?? null, screenshot: res.screenshot })
      inspector?.end({ outcome: res.outcome, error: res.error, checks: res.checks })
      // A tab the run moved into: closed here, since an attached Chrome only closes the tab the session opened.
      if (live && live !== session.page) await live.close().catch(() => {})
      res.trace = await session.close(ctx.keepTrace || (res.outcome !== 'pass' && res.outcome !== 'done'))
      res.pageErrors = redactDeep(session.pageErrors, secrets)
      inspector?.files({ trace: res.trace, decisions: res.decisions ?? null, screenshot: res.screenshot })
    }
  } catch (e) {
    return done('error', String(e.message || e).split('\n')[0])
  }
}
