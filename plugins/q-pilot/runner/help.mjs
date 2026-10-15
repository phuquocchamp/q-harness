// Help requests: in task mode the pilot loop hands the run to Claude where Jev is stuck (see record.mjs). The runner
// stays alive with the browser open: it writes help-<n>.json (and help-<n>.png) into the run dir, announces it on
// stderr, and waits for help-<n>.answer.json, which the mod writes when Claude calls pilot_help.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { elementIndex } from './snapshot.mjs'
import { redact, redactValue } from './redact.mjs'

export const MAX_HELP = 6
/** How long one request waits for Claude's answer. A bot wall waits longer: a person has to solve it first. */
export const HELP_WAIT_MS = 240_000
export const HUMAN_WAIT_MS = 600_000
const POLL_MS = 250
const MAX_ELEMENTS = 150
const MAX_TEXT = 2500
export const OPS = new Set(['click', 'fill', 'select', 'press', 'scroll', 'wait'])
export const KEYS = new Set(['Enter', 'Escape', 'Tab', 'ArrowDown', 'ArrowUp'])
export const THEN = new Set(['observe', 'resume', 'done', 'stop'])
const MAX_ACTIONS = 8

/** The line the runner prints to stderr for each request; the mod watches for it. */
export const HELP_MARK = '[q-pilot] help '

/** The elements Claude may act on, one row per element with the operations it takes (same indices as Jev's). */
export function helpElements(snap, secrets) {
  const index = elementIndex(snap.actions)
  const rows = new Map()
  for (const a of snap.actions) {
    if (a.node === undefined || !index.has(a.node)) continue
    const i = index.get(a.node)
    const row = rows.get(i) ?? { index: Number(i), role: a.role, name: redact(a.name, secrets), ops: [] }
    if (!rows.has(i)) {
      if (a.scope) row.scope = redact(a.scope, secrets)
      for (const k of ['checked', 'selected', 'expanded', 'pressed', 'current']) if (a[k] !== undefined) row[k] = a[k]
      rows.set(i, row)
    }
    if (a.kind === 'select') {
      row.value = redactValue(a.current_value ?? '', secrets)
      ;(row.options ||= []).push(redact(a.option, secrets))
    } else if (a.value) row.value = redactValue(a.value, secrets)
    if (!row.ops.includes(a.kind)) row.ops.push(a.kind)
  }
  return [...rows.values()].slice(0, MAX_ELEMENTS)
}

/** Checks an answer file's content; returns { actions, then, note } or { error }. */
export function parseAnswer(raw) {
  let a
  try { a = JSON.parse(raw) } catch { return { error: 'the answer is not JSON' } }
  if (!a || typeof a !== 'object') return { error: 'the answer must be an object' }
  const then = a.then ?? 'observe'
  if (!THEN.has(then)) return { error: `then must be one of ${[...THEN].join(', ')}` }
  const actions = a.actions ?? []
  if (!Array.isArray(actions) || actions.length > MAX_ACTIONS) return { error: `actions must be an array of at most ${MAX_ACTIONS}` }
  for (const [i, x] of actions.entries()) {
    if (!x || !OPS.has(x.op)) return { error: `actions[${i}].op must be one of ${[...OPS].join(', ')}` }
    if (['click', 'fill', 'select'].includes(x.op) && !Number.isInteger(x.index)) return { error: `actions[${i}].index is required for ${x.op}` }
    if (x.op === 'fill' && typeof x.text !== 'string' && typeof x.fixture !== 'string') return { error: `actions[${i}] needs text or fixture` }
    if (x.op === 'select' && typeof x.option !== 'string') return { error: `actions[${i}].option is required for select` }
    if (x.op === 'press' && !KEYS.has(x.key)) return { error: `actions[${i}].key must be one of ${[...KEYS].join(', ')}` }
    if (x.op === 'scroll' && x.delta !== undefined && !Number.isFinite(x.delta)) return { error: `actions[${i}].delta must be a number` }
  }
  return { actions, then, note: typeof a.note === 'string' ? a.note.slice(0, 300) : undefined }
}

/**
 * The helper the pilot loop asks. `onWait(ms)` moves the run's deadlines by the time spent waiting. `screenshots` is
 * false when the run types a secret fixture (a screenshot could show it), like the inspector.
 */
export function createHelper({ runDir, runId, goal = '', secrets = [], fixtureKeys = [], confirmDone = false, onWait = () => {}, max = MAX_HELP, waitMs = HELP_WAIT_MS, humanWaitMs = HUMAN_WAIT_MS, log = line => console.error(line) }) {
  let n = 0
  return {
    confirmDone,
    left: () => max - n,
    used: () => n,
    /** Returns { actions, then, note } or null when no answer came in time. */
    async ask({ reason, info, snap, history, steps, page }) {
      n++
      const file = join(runDir, `help-${n}.json`)
      const answerFile = join(runDir, `help-${n}.answer.json`)
      let screenshot = null
      if (page && !secrets.length) {
        screenshot = join(runDir, `help-${n}.png`)
        await page.screenshot({ path: screenshot, timeout: 5000 }).catch(() => (screenshot = null))
      }
      const request = {
        n, of: max, runId, reason, info: info ?? null,
        // The task's goal, for a helper model that did not write it (the session did).
        goal: redact(goal, secrets),
        url: redact(snap.url ?? '', secrets), title: redact(snap.title ?? '', secrets),
        elements: helpElements(snap, secrets),
        text: redact(snap.text ?? '', secrets).slice(0, MAX_TEXT),
        recent_actions: (history ?? []).slice(-8),
        steps, fixtures: fixtureKeys, screenshot,
        wait_ms: reason === 'human_needed' ? humanWaitMs : waitMs,
      }
      writeFileSync(file, JSON.stringify(request, null, 2))
      log(`${HELP_MARK}${JSON.stringify({ n, file, runId, runDir, reason })}`)
      const t0 = Date.now()
      try {
        for (const end = t0 + request.wait_ms; Date.now() < end; ) {
          if (existsSync(answerFile)) {
            const a = parseAnswer(readFileSync(answerFile, 'utf8'))
            // A malformed answer is never acted on: it counts as "look again".
            return 'error' in a ? { actions: [], then: 'observe', note: a.error } : a
          }
          await new Promise(r => setTimeout(r, POLL_MS))
        }
        return null
      } finally {
        onWait(Date.now() - t0)
      }
    },
  }
}
