// Past runs as dashboard sessions, rebuilt from `.q-pilot/runs/<runId>/`: result.json, `<flow>.decisions.json`, the
// run's files and, for runs made with the dashboard, `<flow>.session.json` (session.mjs). Nothing here is written.
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, resolve, sep } from 'node:path'
import { RUN_ID } from './trace.mjs'
import { ID } from './flow.mjs'
import { GROUP_ID } from './session.mjs'

const MAX_RUNS = 200
const KIND = { task: 'task', explore: 'test', run: 'flow', record: 'flow' }
const cache = new Map()

const readJson = file => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}
/** Run ids carry their start time in UTC: 20261016-045325-c4a0. */
const startOf = runId => Date.parse(`${runId.slice(0, 4)}-${runId.slice(4, 6)}-${runId.slice(6, 8)}T${runId.slice(9, 11)}:${runId.slice(11, 13)}:${runId.slice(13, 15)}Z`)
/** A path from a result or session file counts only when it sits inside the run dir. */
const inside = (runDir, file) => typeof file === 'string' && resolve(file).startsWith(resolve(runDir) + sep) && existsSync(file) ? file : null

function build(runDir, runId, flowId, flow, result, session, rows) {
  const command = result?.command
  const stat = (() => { try { return statSync(runDir).mtimeMs } catch { return Date.now() } })()
  const startedAt = session?.startedAt ?? (result?.startedAt ? Date.parse(result.startedAt) : startOf(runId))
  const done = Boolean(result || session)
  const own = ext => join(runDir, `${flowId}.${ext}`)
  const files = Object.fromEntries(Object.entries({
    trace: inside(runDir, flow?.trace) ?? inside(runDir, own('trace.zip')),
    decisions: inside(runDir, flow?.decisions) ?? inside(runDir, own('decisions.json')),
    screenshot: inside(runDir, flow?.screenshot) ?? inside(runDir, own('png')),
  }).filter(([, f]) => f))
  const by = flow?.steps ?? []
  const trail = session?.history ?? rows.map(r => ({ step: r.step, action: r.chose, p: r.p ?? null, latencyMs: r.latencyMs ?? null, by: by[r.step - 1]?.by ?? 'jev', model: r.jevModel ?? r.vision?.model ?? null, vision: Boolean(r.vision?.used), frame: null, pageChanged: null }))
  const frames = session?.frames ?? rows.map((r, n) => ({ i: n + 1, step: r.step, url: r.url, title: '', label: r.chose ?? null, p: r.p ?? null, help: null, by: by[r.step - 1]?.by ?? null, shot: false, vision: Boolean(r.vision?.used), box: false }))
  const outcome = session?.outcome ?? flow?.outcome ?? null
  const version = result?.playwright?.version?.split('.').slice(0, 2).join('.')
  return {
    id: `${runId}:${flowId}`, runId, flowId,
    kind: session?.kind ?? KIND[command] ?? 'flow',
    group: typeof session?.group === 'string' && GROUP_ID.test(session.group) ? session.group : null,
    name: session?.name ?? flowId,
    subline: '',
    target: session?.target ?? { kind: 'chromium', label: version ? `Chromium ${version}` : 'Chromium' },
    status: done ? 'ended' : 'incomplete',
    outcome,
    red: ['app-bug', 'blocked', 'error', 'drift', 'env'].includes(outcome) && !flow?.accepted,
    // Without session.json nothing says what the run typed: a task or explore run that kept no trace is treated as secret.
    secret: session?.secret ?? (!flow?.trace && (command === 'task' || command === 'explore')),
    startedAt, endedAt: session?.endedAt ?? (result ? startedAt + (result.durationMs ?? 0) : done ? null : stat),
    source: 'history', controls: false,
    goal: session?.goal ?? null, runDir, files, trail, frames,
    error: session?.error ?? flow?.error ?? null, checks: session?.checks ?? flow?.checks ?? [],
    vision: session?.vision ?? null, settings: session?.settings ?? null,
    steps: flow?.steps?.length ?? trail.length,
  }
}

const withSubline = s => {
  const ms = Math.max(0, (s.endedAt ?? s.startedAt) - s.startedAt)
  const clock = `${Math.floor(ms / 60000)}:${String(Math.floor(ms / 1000) % 60).padStart(2, '0')}`
  return { ...s, subline: `${s.kind} · ${s.steps} steps · ${clock}${s.outcome ? ` · ${s.outcome}` : ''}` }
}

/** The sessions of one run: one per flow of result.json, else per session.json or decisions file. [] when the id is bad or the run unknown. */
export function loadRun(root, runId) {
  if (!RUN_ID.test(runId ?? '')) return []
  const runDir = join(root, '.q-pilot', 'runs', runId)
  let mtime
  try { mtime = statSync(runDir).mtimeMs } catch { return [] }
  const hit = cache.get(runDir)
  if (hit?.mtime === mtime) return hit.sessions
  const result = readJson(join(runDir, 'result.json'))
  const names = readdirSync(runDir)
  const ids = result?.flows?.length
    ? result.flows.map(f => f.id)
    : [...new Set(names.map(n => /^(.+?)\.(?:session|decisions)\.json$/.exec(n)?.[1]).filter(Boolean))]
  const sessions = ids.filter(id => ID.test(id)).map(id => {
    const rows = readJson(join(runDir, `${id}.decisions.json`))
    const flow = result?.flows?.find(f => f.id === id)
    return withSubline(build(runDir, runId, id, flow, result, readJson(join(runDir, `${id}.session.json`)), Array.isArray(rows) ? rows : []))
  })
  cache.set(runDir, { mtime, sessions })
  return sessions
}

/**
 * The newest runs' sessions, newest first. `before`: a run id; only older runs are scanned, to page back.
 * At most `limit` run dirs are looked at.
 */
export function listRuns(root, { limit = MAX_RUNS, before = null } = {}) {
  const dir = join(root, '.q-pilot', 'runs')
  if (!existsSync(dir)) return []
  const ids = readdirSync(dir).filter(r => RUN_ID.test(r) && (!before || r < before)).sort().reverse().slice(0, limit)
  return ids.flatMap(id => loadRun(root, id))
}

/** One history frame with what decisions.json holds (elements and Jev's decision), no pixels. null when unknown. */
export function loadFrame(session, i) {
  const rows = readJson(join(session.runDir, `${session.flowId}.decisions.json`))
  const meta = session.frames.find(f => f.i === i)
  const r = Array.isArray(rows) ? rows[i - 1] : null
  if (!meta) return null
  if (!r || r.step !== meta.step) return { ...meta, view: null, boxes: [], screenshot: null, elements: [], decision: null }
  const { step, url, chose, p, elements, jevModel, vision, ...rest } = r
  return { i, step, url, title: meta.title, view: null, boxes: [], screenshot: null, elements: elements ?? [], decision: { label: chose, p, ...rest, vision } }
}
