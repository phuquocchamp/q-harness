// Where the browser comes from: resolving Playwright (project, Q_PILOT_PLAYWRIGHT, global), launching or attaching
// over CDP, and one session (context + page) per attempt with page errors and an optional Playwright trace.
import { createRequire } from 'node:module'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, isAbsolute, join, posix, relative, resolve, win32 } from 'node:path'
import { homedir } from 'node:os'
import { ConfigError } from './flow.mjs'

const NAMES = ['playwright', '@playwright/test']
const VIEWPORT = { width: 1280, height: 720 }
/** Task mode: a desktop-sized window, so booking forms and filters fit above the fold as on a real screen. */
export const TASK_VIEWPORT = { width: 1440, height: 900 }
const MAX_PAGE_ERRORS = 10
export const INSTALL_HINT = 'npm install -g playwright && npx playwright install chromium'

/**
 * Global node_modules folders, without spawning npm: npm's prefix, the running node's prefix (a Homebrew node runs
 * from its Cellar, while npm installs to the prefix above it), NODE_PATH, ~/.npm-global, and every nvm version (the
 * shell's npm is often an nvm node other than the one running q-pilot), newest first.
 */
export function globalRoots(env = process.env, execPath = process.execPath, platform = process.platform, home = homedir()) {
  const win = platform === 'win32'
  const p = win ? win32 : posix
  const fromPrefix = dir => (win ? p.join(dir, 'node_modules') : p.join(dir, 'lib', 'node_modules'))
  const nodePrefix = win ? p.dirname(execPath) : p.dirname(p.dirname(execPath))
  const cellar = !win && /^(.*)\/Cellar\/node[^/]*\//.exec(execPath)
  const nvmDir = env.NVM_DIR || p.join(home, '.nvm')
  let nvm = []
  try {
    nvm = readdirSync(p.join(nvmDir, 'versions', 'node'))
      .sort((x, y) => y.localeCompare(x, 'en', { numeric: true }))
      .map(v => p.join(nvmDir, 'versions', 'node', v, 'lib', 'node_modules'))
  } catch {}
  const roots = [
    ...(env.NPM_CONFIG_PREFIX ? [fromPrefix(env.NPM_CONFIG_PREFIX)] : []),
    fromPrefix(nodePrefix),
    ...(cellar ? [fromPrefix(cellar[1])] : []),
    ...(env.NODE_PATH ?? '').split(win ? ';' : ':').filter(Boolean),
    ...(win ? [] : [p.join(home, '.npm-global', 'lib', 'node_modules')]),
    ...(env.NVM_BIN ? [fromPrefix(p.dirname(env.NVM_BIN))] : []),
    ...nvm,
  ]
  return [...new Set(roots)]
}

const versionOf = dir => {
  try { return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')).version ?? null } catch { return null }
}

/** A Playwright package directly in `dir` (`dir` is the package) or in `dir`/<name> (`dir` is a node_modules). */
function fromDir(dir, load) {
  for (const name of NAMES) {
    for (const pkg of [dir, join(dir, name), join(dir, 'node_modules', name)]) {
      let manifest
      try { manifest = JSON.parse(readFileSync(join(pkg, 'package.json'), 'utf8')) } catch { continue }
      if (manifest.name === name) return { pw: load(pkg), version: manifest.version ?? null, path: pkg }
    }
  }
  return null
}

/**
 * Resolves Playwright: the project's own first (exported specs run with that version), then the folder in
 * Q_PILOT_PLAYWRIGHT, then a global install. Returns { pw, from, version, path }; throws ConfigError listing every
 * place it looked. `load` and `roots` are parameters so tests do not depend on this machine.
 */
export function resolvePlaywright(root, env = process.env, { roots = globalRoots(env), load = p => createRequire(import.meta.url)(p) } = {}) {
  const tried = []
  const req = createRequire(join(root, 'package.json'))
  for (const name of NAMES) {
    try {
      const path = dirname(req.resolve(`${name}/package.json`))
      return { pw: load(path), from: 'project', version: versionOf(path), path }
    } catch {}
  }
  tried.push(`${root} (project)`)
  if (env.Q_PILOT_PLAYWRIGHT) {
    const dir = resolve(root, env.Q_PILOT_PLAYWRIGHT)
    const hit = fromDir(dir, load)
    if (hit) return { ...hit, from: 'env' }
    tried.push(`${dir} (Q_PILOT_PLAYWRIGHT)`)
  }
  for (const dir of roots) {
    const hit = existsSync(dir) && fromDir(dir, load)
    if (hit) return { ...hit, from: 'global' }
    tried.push(`${dir} (global)`)
  }
  throw new ConfigError(`playwright not found; looked in ${tried.join(', ')}. Install it once for every project: ${INSTALL_HINT}, or set Q_PILOT_PLAYWRIGHT to a folder that has it`)
}

/**
 * The browser for a command: attach to a running Chrome when Q_PILOT_CDP_URL is set (its default profile, so the
 * user's logins), else launch Chromium. Returns { browser, cdp }. `close()` on an attached browser only disconnects.
 */
export async function openBrowser(pw, env, { headless }) {
  if (env.Q_PILOT_CDP_URL) {
    const attach = () => pw.chromium.connectOverCDP(env.Q_PILOT_CDP_URL, { timeout: 5000 })
    try {
      return { browser: await attach(), cdp: true }
    } catch (e) {
      // A Chrome with every window closed (macOS keeps it running) refuses context management: open a tab, retry once.
      if (/context management is not supported/i.test(String(e.message))) {
        try {
          await fetch(new URL('/json/new?about:blank', env.Q_PILOT_CDP_URL), { method: 'PUT', signal: AbortSignal.timeout(3000) })
          return { browser: await attach(), cdp: true }
        } catch (e2) {
          e = e2
        }
      }
      throw new ConfigError(`cannot attach to Chrome at Q_PILOT_CDP_URL ${env.Q_PILOT_CDP_URL}: ${String(e.message).split('\n')[0]}`)
    }
  }
  return { browser: await pw.chromium.launch({ headless }), cdp: false }
}

/** config.storageState: a path inside the project root, or undefined. */
export function storageStateOf(root, cfg) {
  if (!cfg?.storageState) return undefined
  const file = resolve(root, cfg.storageState)
  const rel = relative(root, file)
  if (!rel || rel.startsWith('..') || isAbsolute(rel)) throw new ConfigError('config.storageState must be a file inside the project')
  if (!existsSync(file)) throw new ConfigError(`config.storageState ${cfg.storageState} not found: save a logged-in state there first`)
  return file
}

/**
 * One attempt's page. Launched: a fresh context (with storageState). Attached over CDP: a new tab in the user's
 * default context, so its cookies apply; only that tab is closed. `traceFile`: record a Playwright trace there
 * (null to skip). Never in an attached context: a trace covers every tab of the context, the user's own included.
 * Returns { page, pageErrors, close(keepTrace) } where close returns the trace path or null.
 */
export async function openSession({ browser, cdp }, { baseURL, storageState, traceFile = null, viewport = VIEWPORT }) {
  let context, own
  if (cdp && browser.contexts().length) {
    context = browser.contexts()[0]
    own = false
  } else {
    context = await browser.newContext({ baseURL, viewport, ...(storageState && { storageState }) })
    own = true
  }
  let tracing = false, page
  try {
    if (traceFile && own) {
      tracing = await context.tracing.start({ screenshots: true, snapshots: true }).then(() => true, () => false)
    }
    page = await context.newPage()
  } catch (e) {
    // E.g. an endpoint that refuses new tabs: leave nothing running behind.
    if (tracing) await context.tracing.stop().catch(() => {})
    if (own) await context.close().catch(() => {})
    throw e
  }
  const pageErrors = []
  const push = text => { if (pageErrors.length < MAX_PAGE_ERRORS) pageErrors.push(String(text).split('\n')[0].slice(0, 200)) }
  page.on('pageerror', e => push(`pageerror: ${e.message}`))
  page.on('console', m => { if (m.type() === 'error') push(`console: ${m.text()}`) })
  // A CDP tab has no baseURL: resolve relative starts against it ourselves.
  if (!own) {
    const goto = page.goto.bind(page)
    page.goto = (url, opts) => goto(new URL(url, baseURL).href, opts)
  }
  return {
    page,
    pageErrors,
    async close(keepTrace) {
      let kept = null
      if (tracing) {
        kept = await context.tracing.stop(keepTrace ? { path: traceFile } : undefined).then(() => (keepTrace ? traceFile : null), () => null)
      }
      if (own) await context.close().catch(() => {})
      else await page.close().catch(() => {})
      return kept
    },
  }
}
