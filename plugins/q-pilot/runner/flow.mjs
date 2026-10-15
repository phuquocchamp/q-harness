// Loading and validating q-pilot.config.json and flow files; resolving $env: fixtures.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export class ConfigError extends Error {}

export const ID = /^[a-z0-9-]+$/
const ENV_NAME = /^(E2E_|Q_PILOT_)\w+$/
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]'])
const TARGETS = ['url', 'title', 'role', 'testid', 'label']
const EXPECTATIONS = ['text', 'contains', 'value', 'visible']
const CHECK_KEYS = new Set([...TARGETS, ...EXPECTATIONS, 'name'])

const readJson = (file, what) => {
  try {
    return JSON.parse(readFileSync(file, 'utf8'))
  } catch (e) {
    throw new ConfigError(`${what} ${file}: ${e.code === 'ENOENT' ? 'not found' : e.message}`)
  }
}
const isObj = v => v && typeof v === 'object' && !Array.isArray(v)
const isStrArr = v => Array.isArray(v) && v.every(s => typeof s === 'string')

/** A remote app is only allowed when the user's own environment opts in; a repo file cannot. */
function assertLoopback(url, what, env) {
  if (env.Q_PILOT_ALLOW_REMOTE === '1') return
  let host
  try { host = new URL(url).hostname } catch { throw new ConfigError(`${what} is not a valid URL`) }
  if (!LOOPBACK.has(host)) throw new ConfigError(`${what} must be loopback (localhost, 127.0.0.1, [::1]) unless Q_PILOT_ALLOW_REMOTE=1 is set in the environment`)
}

export function loadConfig(root, env = process.env) {
  const c = readJson(join(root, 'q-pilot.config.json'), 'config')
  if (!isObj(c)) throw new ConfigError('config must be an object')
  if (typeof c.baseURL !== 'string' || !c.baseURL) throw new ConfigError('config.baseURL is required')
  if (c.flowsDir !== undefined && typeof c.flowsDir !== 'string') throw new ConfigError('config.flowsDir must be a string')
  if (c.loginPath !== undefined && typeof c.loginPath !== 'string') throw new ConfigError('config.loginPath must be a string')
  if (c.ignore !== undefined && !isStrArr(c.ignore)) throw new ConfigError('config.ignore must be an array of strings')
  const s = c.server
  if (s !== undefined) {
    if (!isObj(s) || !isStrArr(s.command) || !s.command.length || typeof s.url !== 'string') throw new ConfigError('config.server needs command (string array) and url')
    if (s.timeoutMs !== undefined && !(s.timeoutMs > 0)) throw new ConfigError('config.server.timeoutMs must be positive')
  }
  assertLoopback(c.baseURL, 'config.baseURL', env)
  if (s) assertLoopback(s.url, 'config.server.url', env)
  return { flowsDir: 'flows', ...c, server: s && { timeoutMs: 20000, ...s } }
}

/** Throws ConfigError naming the problem; returns the check unchanged. */
export function validateCheck(check, at = 'check') {
  if (!isObj(check)) throw new ConfigError(`${at} must be an object`)
  for (const k of Object.keys(check)) if (!CHECK_KEYS.has(k)) throw new ConfigError(`${at}: unknown key "${k}"`)
  const targets = TARGETS.filter(k => k in check)
  if (targets.length > 1) throw new ConfigError(`${at}: more than one target (${targets.join(', ')})`)
  // A bare `text` is the target; next to another target it is the expectation.
  if (!targets.length && !('text' in check)) throw new ConfigError(`${at}: needs a target (${TARGETS.join(', ')} or text)`)
  if (!targets.length && Object.keys(check).length > 1) throw new ConfigError(`${at}: "text" alone takes no other key`)
  if ('name' in check && !('role' in check)) throw new ConfigError(`${at}: "name" is only valid with "role"`)
  const exps = EXPECTATIONS.filter(k => k in check && targets.length)
  if (exps.length > 1) throw new ConfigError(`${at}: more than one expectation (${exps.join(', ')})`)
  if ((targets[0] === 'url' || targets[0] === 'title') && exps.length) throw new ConfigError(`${at}: "${targets[0]}" takes no expectation`)
  for (const k of Object.keys(check)) {
    if (k === 'visible' ? typeof check[k] !== 'boolean' : typeof check[k] !== 'string') throw new ConfigError(`${at}: "${k}" has the wrong type`)
  }
  if ('url' in check) {
    try { new RegExp(check.url) } catch { throw new ConfigError(`${at}: "url" is not a valid regex`) }
  }
  return check
}

export function validateFlow(f, stem) {
  if (!isObj(f)) throw new ConfigError('flow must be an object')
  if (typeof f.id !== 'string' || !ID.test(f.id)) throw new ConfigError('flow.id must match [a-z0-9-]+')
  if (f.id !== stem) throw new ConfigError(`flow.id "${f.id}" must equal the file name stem "${stem}"`)
  if (typeof f.start !== 'string' || !f.start.startsWith('/')) throw new ConfigError('flow.start must be a path starting with /')
  if (typeof f.goal !== 'string' || !f.goal.trim()) throw new ConfigError('flow.goal is required')
  const fixtures = f.fixtures ?? {}
  if (!isObj(fixtures) || !Object.values(fixtures).every(v => typeof v === 'string')) throw new ConfigError('flow.fixtures must map names to strings')
  for (const [k, v] of Object.entries(fixtures)) {
    if (v.startsWith('$env:') && !ENV_NAME.test(v.slice(5))) throw new ConfigError(`fixture "${k}": $env: names must start with E2E_ or Q_PILOT_ (got "${v.slice(5)}")`)
  }
  if (!Array.isArray(f.verify)) throw new ConfigError('flow.verify must be an array')
  f.verify.forEach((c, i) => validateCheck(c, `verify[${i}]`))
  for (const k of ['covers', 'tags']) if (f[k] !== undefined && !isStrArr(f[k])) throw new ConfigError(`flow.${k} must be an array of strings`)
  const b = f.budget ?? {}
  for (const k of ['steps', 'seconds']) if (b[k] !== undefined && !(b[k] > 0)) throw new ConfigError(`flow.budget.${k} must be positive`)
  return { ...f, fixtures, covers: f.covers ?? [], tags: f.tags ?? [], budget: { steps: 20, seconds: 20, ...b } }
}

export const flowFile = (root, cfg, id) => join(root, cfg.flowsDir, `${id}.flow.json`)

export function loadFlow(root, cfg, id) {
  if (typeof id !== 'string' || !ID.test(id)) throw new ConfigError(`invalid flow id "${id}": must match [a-z0-9-]+`)
  const file = flowFile(root, cfg, id)
  if (!existsSync(file)) throw new ConfigError(`flow "${id}" not found in ${cfg.flowsDir}/`)
  return validateFlow(readJson(file, 'flow'), id)
}

export function flowIds(root, cfg) {
  const dir = join(root, cfg.flowsDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir).filter(n => n.endsWith('.flow.json')).map(n => n.slice(0, -'.flow.json'.length)).sort()
}

/** `$env:NAME` values come from `env`; returns the resolved values and the names of missing variables. */
export function resolveFixtures(flow, env) {
  const values = {}, missing = []
  for (const [k, v] of Object.entries(flow.fixtures)) {
    if (v.startsWith('$env:')) {
      const name = v.slice(5)
      if (env[name]) values[k] = env[name]
      else missing.push(name)
    } else values[k] = v
  }
  return { values, missing }
}
