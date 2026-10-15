// Loading and validating q-pilot.config.json and flow files; resolving $env: fixtures.
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'

export class ConfigError extends Error {}

export const ID = /^[a-z0-9-]+$/
const ENV_NAME = /^(E2E_|Q_PILOT_)\w+$/
// A path on the base origin: never `//host` or `/\host`, which a URL parser resolves off-origin.
const START = /^\/(?![/\\])/
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

/**
 * Network access is open by default: any baseURL, and a run may follow links to other origins. The user's own
 * environment can close it (Q_PILOT_ALLOW_REMOTE=0 in the shell); a repo file cannot.
 */
export const remoteAllowed = env => env.Q_PILOT_ALLOW_REMOTE !== '0'

/** With remote access closed, the app must be on loopback. */
export function assertLoopback(url, what, env) {
  if (remoteAllowed(env)) return
  let host
  try { host = new URL(url).hostname } catch { throw new ConfigError(`${what} is not a valid URL`) }
  if (!LOOPBACK.has(host)) throw new ConfigError(`${what} must be loopback (localhost, 127.0.0.1, [::1]) while remote access is off (Q_PILOT_ALLOW_REMOTE=0 is set in the shell)`)
}

export function loadConfig(root, env = process.env) {
  const c = readJson(join(root, 'q-pilot.config.json'), 'config')
  if (!isObj(c)) throw new ConfigError('config must be an object')
  if (typeof c.baseURL !== 'string' || !c.baseURL) throw new ConfigError('config.baseURL is required')
  if (c.flowsDir !== undefined && typeof c.flowsDir !== 'string') throw new ConfigError('config.flowsDir must be a string')
  if (c.loginPath !== undefined && typeof c.loginPath !== 'string') throw new ConfigError('config.loginPath must be a string')
  if (c.ignore !== undefined && !isStrArr(c.ignore)) throw new ConfigError('config.ignore must be an array of strings')
  if (c.storageState !== undefined && (typeof c.storageState !== 'string' || !c.storageState)) throw new ConfigError('config.storageState must be a path')
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

function validateFixtures(raw) {
  const fixtures = raw ?? {}
  if (!isObj(fixtures) || !Object.values(fixtures).every(v => typeof v === 'string')) throw new ConfigError('fixtures must map names to strings')
  for (const [k, v] of Object.entries(fixtures)) {
    if (v.startsWith('$env:') && !ENV_NAME.test(v.slice(5))) throw new ConfigError(`fixture "${k}": $env: names must start with E2E_ or Q_PILOT_ (got "${v.slice(5)}")`)
  }
  return fixtures
}

export function validateFlow(f, stem) {
  if (!isObj(f)) throw new ConfigError('flow must be an object')
  if (typeof f.id !== 'string' || !ID.test(f.id)) throw new ConfigError('flow.id must match [a-z0-9-]+')
  if (f.id !== stem) throw new ConfigError(`flow.id "${f.id}" must equal the file name stem "${stem}"`)
  if (typeof f.start !== 'string' || !START.test(f.start)) throw new ConfigError('flow.start must be a path starting with a single /')
  if (typeof f.goal !== 'string' || !f.goal.trim()) throw new ConfigError('flow.goal is required')
  const fixtures = validateFixtures(f.fixtures)
  if (!Array.isArray(f.verify)) throw new ConfigError('flow.verify must be an array')
  f.verify.forEach((c, i) => validateCheck(c, `verify[${i}]`))
  for (const k of ['covers', 'tags']) if (f[k] !== undefined && !isStrArr(f[k])) throw new ConfigError(`flow.${k} must be an array of strings`)
  const b = f.budget ?? {}
  for (const k of ['steps', 'seconds']) if (b[k] !== undefined && !(b[k] > 0)) throw new ConfigError(`flow.budget.${k} must be positive`)
  return { ...f, fixtures, covers: f.covers ?? [], tags: f.tags ?? [], budget: { steps: 20, seconds: 20, ...b } }
}

/** The config, or null when the project has none (prompt mode does not need one). */
export function loadConfigOptional(root, env = process.env) {
  return existsSync(join(root, 'q-pilot.config.json')) ? loadConfig(root, env) : null
}

/**
 * Task-mode spec: any browser task from a prompt, like jev-ultrafast. `url` is a full http(s) URL (its origin becomes
 * the baseURL, its path and query the start); without it, baseURL and start work as in a prompt-mode spec. Checks are
 * optional: with none, the outcome only says whether Jev reported DONE.
 */
export function validateTask(spec, config, env) {
  if (!isObj(spec)) throw new ConfigError('task must be an object')
  const name = spec.name ?? 'task'
  if (typeof name !== 'string' || !ID.test(name)) throw new ConfigError('task.name must match [a-z0-9-]+')
  let baseURL, start
  if (spec.url !== undefined) {
    let u
    try { u = new URL(spec.url) } catch { throw new ConfigError('task.url must be a full URL such as https://example.com/search') }
    // Page text goes to Jev: never a local file or a browser-internal page.
    if (u.protocol !== 'http:' && u.protocol !== 'https:') throw new ConfigError('task.url must use http or https')
    baseURL = u.origin
    start = u.pathname + u.search
  } else {
    baseURL = spec.baseURL ?? config?.baseURL
    if (typeof baseURL !== 'string' || !baseURL) throw new ConfigError('task.url is required when there is no q-pilot.config.json')
    start = spec.start ?? '/'
    if (typeof start !== 'string' || !START.test(start)) throw new ConfigError('task.start must be a path starting with a single /')
  }
  assertLoopback(baseURL, 'task.url', env)
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) throw new ConfigError('task.goal is required')
  const fixtures = validateFixtures(spec.fixtures)
  const checks = spec.checks ?? []
  if (!Array.isArray(checks)) throw new ConfigError('task.checks must be an array')
  checks.forEach((c, i) => validateCheck(c, `checks[${i}]`))
  const soft = spec.softChecks ?? []
  if (!isStrArr(soft) || soft.length > 5) throw new ConfigError('task.softChecks must be at most 5 strings')
  const b = spec.budget ?? {}
  for (const k of ['steps', 'seconds']) if (b[k] !== undefined && !(b[k] > 0)) throw new ConfigError(`task.budget.${k} must be positive`)
  return { name, baseURL, start, goal: spec.goal, fixtures, checks, softChecks: soft, budget: { steps: 40, seconds: 180, ...b }, task: true }
}

/** Prompt-mode spec. baseURL falls back to `config`; returns the normalized spec. */
export function validateSpec(spec, config, env) {
  if (!isObj(spec)) throw new ConfigError('spec must be an object')
  const name = spec.name ?? 'explore'
  if (typeof name !== 'string' || !ID.test(name)) throw new ConfigError('spec.name must match [a-z0-9-]+')
  const baseURL = spec.baseURL ?? config?.baseURL
  if (typeof baseURL !== 'string' || !baseURL) throw new ConfigError('spec.baseURL is required when there is no q-pilot.config.json')
  assertLoopback(baseURL, 'spec.baseURL', env)
  const start = spec.start ?? '/'
  if (typeof start !== 'string' || !START.test(start)) throw new ConfigError('spec.start must be a path starting with a single /')
  if (typeof spec.goal !== 'string' || !spec.goal.trim()) throw new ConfigError('spec.goal is required')
  const fixtures = validateFixtures(spec.fixtures)
  if (!Array.isArray(spec.checks) || !spec.checks.length) throw new ConfigError('spec.checks needs at least one check')
  spec.checks.forEach((c, i) => validateCheck(c, `checks[${i}]`))
  const soft = spec.softChecks ?? []
  if (!isStrArr(soft) || soft.length > 5) throw new ConfigError('spec.softChecks must be at most 5 strings')
  const b = spec.budget ?? {}
  for (const k of ['steps', 'seconds']) if (b[k] !== undefined && !(b[k] > 0)) throw new ConfigError(`spec.budget.${k} must be positive`)
  return { name, baseURL, start, goal: spec.goal, fixtures, checks: spec.checks, softChecks: soft, budget: { steps: 20, seconds: 60, ...b } }
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

/**
 * `$env:NAME` values come from `env`. Returns the resolved values, the names of missing variables and the
 * secrets: only values from the environment are secret, a literal fixture is plain test data.
 */
export function resolveFixtures(flow, env) {
  const values = {}, missing = [], secrets = []
  for (const [k, v] of Object.entries(flow.fixtures)) {
    if (v.startsWith('$env:')) {
      const name = v.slice(5)
      if (env[name]) secrets.push((values[k] = env[name]))
      else missing.push(name)
    } else values[k] = v
  }
  return { values, missing, secrets }
}
