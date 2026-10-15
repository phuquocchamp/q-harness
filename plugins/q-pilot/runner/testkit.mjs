// Helpers for the runner tests: temp copies of the demo app, a free port, and a stubbed Jev.
import { cpSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { JEV_URL } from './jev.mjs'

export const DEMO = new URL('../examples/demo-app/', import.meta.url).pathname.replace(/\/$/, '')

export const freePort = () =>
  new Promise(resolve => {
    const s = createServer().listen(0, '127.0.0.1', () => {
      const { port } = s.address()
      s.close(() => resolve(port))
    })
  })

/** A copy of the demo app in a temp dir on its own port. `edits` maps a src file to [from, to] pairs applied in order. */
export async function makeApp(edits = {}) {
  const root = mkdtempSync(join(tmpdir(), 'q-pilot-'))
  const port = await freePort()
  for (const f of ['src', 'server.mjs', 'package.json', 'q-pilot.config.json', 'flows', '.q-pilot']) cpSync(join(DEMO, f), join(root, f), { recursive: true })
  // Reuse the demo's Playwright install.
  symlinkSync(join(DEMO, 'node_modules'), join(root, 'node_modules'))
  rmSync(join(root, '.q-pilot', 'runs'), { recursive: true, force: true })
  for (const f of ['server.mjs', 'q-pilot.config.json']) {
    writeFileSync(join(root, f), readFileSync(join(root, f), 'utf8').replaceAll('4731', String(port)))
  }
  for (const [file, pairs] of Object.entries(edits)) {
    const p = join(root, 'src', file)
    writeFileSync(p, pairs.reduce((text, [from, to]) => text.replace(from, to), readFileSync(p, 'utf8')))
  }
  return { root, port, cleanup: () => rmSync(root, { recursive: true, force: true }) }
}

const BUG_EDIT = ['€12.00', '€120.00']
const DRIFT_EDIT = ['Place order', 'Pay now']
export const BUG = { 'checkout.html': [BUG_EDIT] }
export const DRIFT = { 'checkout.html': [DRIFT_EDIT] }
export const DRIFT_AND_BUG = { 'checkout.html': [DRIFT_EDIT, BUG_EDIT] }

const answer = (ids, choice) => {
  const rest = ids.filter(i => i !== choice)
  const probabilities = Object.fromEntries(ids.map(i => [i, i === choice ? (rest.length ? 0.9 : 1) : 0.1 / rest.length]))
  return { type: 'choice', choice, confidence: probabilities[choice], probabilities }
}

/**
 * Stubs fetch for the Jev URL only. `policy(body)` returns { op, label?, fixture? } and is turned into a valid
 * response, or returns { raw } to send an arbitrary `answers` object. Returns { requests, restore }.
 */
export function stubJev(policy) {
  const real = globalThis.fetch
  const requests = []
  globalThis.fetch = async (url, init) => {
    if (String(url) !== JEV_URL) return real(url, init)
    const body = JSON.parse(init.body)
    requests.push({ raw: init.body, body })
    const d = policy(body)
    const answers = d.raw ?? {}
    if (!d.raw) {
      answers.operation = answer(Object.keys(body.questions.operation.criteria), d.op)
      for (const [name, q] of Object.entries(body.questions)) {
        if (name === 'operation') continue
        const ids = Object.keys(q.criteria)
        if (name === 'fixture') answers.fixture = answer(ids, d.fixture ?? ids[0])
        else answers[name] = answer(ids, ids.find(k => d.label && q.criteria[k].element.includes(`] ${d.label}`)) ?? ids[0])
      }
    }
    return new Response(JSON.stringify({ model: 'jev-latest', answers }), { status: 200, headers: { 'content-type': 'application/json' } })
  }
  return { requests, restore: () => (globalThis.fetch = real) }
}

export const ENV = { TYPESAFE_API_KEY: 'test-key' }
