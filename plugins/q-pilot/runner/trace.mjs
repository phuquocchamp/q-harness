// Traces (committed), run dirs (git-ignored), proposals and results.
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync, copyFileSync } from 'node:fs'
import { join } from 'node:path'
import { randomBytes } from 'node:crypto'
import { redact } from './redact.mjs'
import { ID } from './flow.mjs'

export const OPS = ['click', 'fill', 'select', 'scroll', 'wait']
export const RUN_ID = /^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$/
export const tracePath = (root, id) => {
  if (!ID.test(id)) throw new Error(`invalid flow id "${id}"`)
  return join(root, '.q-pilot', 'traces', `${id}.json`)
}
const runsDir = root => join(root, '.q-pilot', 'runs')

export function readTrace(root, id) {
  const file = tracePath(root, id)
  if (!existsSync(file)) return null
  let t
  try {
    t = JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new Error(`trace ${file}: ${e.message}`)
  }
  if (!Array.isArray(t?.steps) || !t.steps.every(s => OPS.includes(s?.op))) throw new Error(`trace ${file} is invalid`)
  return t
}

/** A trace object for `steps`. Steps keep real element names; `by` is dropped and fixture values are removed from `url`. */
export function buildTrace(flowId, steps, version = 1, secrets = []) {
  const clean = ({ by, ...s }) => (s.url ? { ...s, url: redact(s.url, secrets) } : s)
  return { flow: flowId, version, recordedAt: new Date().toISOString(), steps: steps.map(clean) }
}

const write = (file, obj) => {
  mkdirSync(join(file, '..'), { recursive: true })
  writeFileSync(file, JSON.stringify(obj, null, 2) + '\n')
  return file
}
export const writeTrace = (root, trace) => write(tracePath(root, trace.flow), trace)

export function newRun(root) {
  const t = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15)
  const runId = `${t}-${randomBytes(2).toString('hex')}`
  const runDir = join(runsDir(root), runId)
  mkdirSync(runDir, { recursive: true })
  return { runId, runDir }
}

export const writeProposal = (runDir, trace) => write(join(runDir, `${trace.flow}.trace.json`), trace)
export const writeResult = (runDir, result) => write(join(runDir, 'result.json'), result)

/**
 * The proposal for `id`: from `runId`, else from the latest run that contains the flow. When that run has
 * no proposal there is nothing to accept; an older run's proposal is stale and is never used.
 */
export function findProposal(root, id, runId) {
  if (!ID.test(id)) throw new Error(`invalid flow id "${id}"`)
  if (runId !== undefined && !RUN_ID.test(runId)) throw new Error(`invalid run id "${runId}"`)
  const dir = runsDir(root)
  let run = runId
  if (!run && existsSync(dir)) {
    // Newest run (by start time; ids alone do not order runs within one second) that contains the flow.
    let newest = ''
    for (const r of readdirSync(dir).filter(r => RUN_ID.test(r))) {
      try {
        const result = JSON.parse(readFileSync(join(dir, r, 'result.json'), 'utf8'))
        if (result.flows?.some(f => f.id === id) && (result.startedAt ?? '') >= newest) [newest, run] = [result.startedAt ?? '', r]
      } catch {}
    }
  }
  if (!run) return null
  const file = join(dir, run, `${id}.trace.json`)
  return existsSync(file) ? file : null
}

/** Copies a proposal over the committed trace. */
export function accept(root, id, runId) {
  const from = findProposal(root, id, runId)
  if (!from) return null
  mkdirSync(join(root, '.q-pilot', 'traces'), { recursive: true })
  copyFileSync(from, tracePath(root, id))
  return { from, to: tracePath(root, id) }
}
