// Opens the dashboard as a standalone app window (a Chromium-family browser's --app mode, like `playwright-cli show`),
// not as a tab in the default browser. The caller falls back to the default browser when this returns ok:false.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import child_process from 'node:child_process'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { resolvePlaywright } from './driver.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SHELL_SCRIPT = path.join(HERE, 'app-shell', 'dashboard.jxa')
const ICON_SVG = path.join(HERE, 'inspector', 'icon.svg')
const ICON_ICNS = path.join(HERE, 'app-shell', 'AppIcon.icns')
const APP_NAME = 'q-pilot Dashboard'
const APP_ID = 'dev.q-harness.q-pilot.dashboard'
const WM_CLASS = 'q-pilot-dashboard'

const MAC = [
  ['chrome', 'Google Chrome'],
  ['edge', 'Microsoft Edge'],
  ['chromium', 'Chromium'],
  ['brave', 'Brave Browser'],
]
const WIN = [
  ['chrome', 'Google\\Chrome\\Application\\chrome.exe'],
  ['edge', 'Microsoft\\Edge\\Application\\msedge.exe'],
  ['chromium', 'Chromium\\Application\\chrome.exe'],
  ['brave', 'BraveSoftware\\Brave-Browser\\Application\\brave.exe'],
]
const LINUX = [
  ['chrome', 'google-chrome'],
  ['chrome', 'google-chrome-stable'],
  ['edge', 'microsoft-edge'],
  ['chromium', 'chromium'],
  ['chromium', 'chromium-browser'],
  ['brave', 'brave-browser'],
]
const SPAWN_GRACE_MS = 400
const READY_MS = 6000

function candidates(platform, env) {
  if (platform === 'darwin') return MAC.map(([kind, app]) => ({ kind, path: `/Applications/${app}.app/Contents/MacOS/${app}` }))
  if (platform === 'win32') {
    const bases = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LocalAppData].filter(Boolean)
    return WIN.flatMap(([kind, rel]) => bases.map(base => ({ kind, path: path.win32.join(base, rel) })))
  }
  const dirs = (env.PATH ?? '').split(path.delimiter).filter(Boolean)
  return LINUX.flatMap(([kind, bin]) => dirs.map(dir => ({ kind, path: path.join(dir, bin) })))
}

/** Finds a Chromium-family browser that supports --app. Returns { path, kind: 'chrome'|'edge'|'chromium'|'brave'|'playwright' } or null. */
export async function findAppBrowser({ platform = process.platform, env = process.env, exists = fs.existsSync, playwright } = {}) {
  for (const c of candidates(platform, env)) if (exists(c.path)) return c
  try {
    const pw = playwright ?? resolvePlaywright(process.cwd(), env).pw
    const bundled = pw.chromium.executablePath()
    if (bundled && exists(bundled)) return { path: bundled, kind: 'playwright' }
  } catch {}
  return null
}

function cacheRoot(platform, env) {
  if (platform === 'darwin') return path.join(env.HOME || os.homedir(), 'Library', 'Caches', 'q-pilot')
  if (platform === 'win32') return path.win32.join(env.LocalAppData ?? path.win32.join(os.homedir(), 'AppData', 'Local'), 'q-pilot')
  return path.join(env.XDG_CACHE_HOME || path.join(env.HOME || os.homedir(), '.cache'), 'q-pilot')
}

function validLoopbackUrl(url) {
  try {
    const u = new URL(url)
    return u.protocol === 'http:' && u.hostname === '127.0.0.1' && /^\d+$/.test(u.port)
  } catch {
    return false
  }
}

function execRun(cmd, args) {
  return new Promise((resolve, reject) => child_process.execFile(cmd, args, (err, stdout) => (err ? reject(err) : resolve(stdout))))
}

/**
 * Builds `q-pilot Dashboard.app` into dir (a stay-open JXA applet with the checked-in AppIcon.icns, so the Dock and the app switcher
 * show it instead of Chrome) unless one built from the same script and icon is already there. Returns the app path.
 * `run(cmd, args)` runs one tool; the caller catches a failure and falls back.
 */
export async function ensureMacApp({ dir, run = execRun, script = SHELL_SCRIPT, icon = ICON_ICNS } = {}) {
  const app = path.join(dir, `${APP_NAME}.app`)
  const stampFile = path.join(dir, 'shell.stamp')
  const stamp = crypto.createHash('sha256').update(fs.readFileSync(script)).update(fs.readFileSync(icon)).digest('hex')
  const stamped = () => { try { return fs.readFileSync(stampFile, 'utf8') === stamp } catch { return false } }
  if (stamped() && fs.existsSync(app)) return app

  fs.mkdirSync(dir, { recursive: true })
  const work = fs.mkdtempSync(path.join(dir, 'build-'))
  try {
    const built = path.join(work, `${APP_NAME}.app`)
    await run('osacompile', ['-l', 'JavaScript', '-s', '-o', built, script])
    fs.copyFileSync(icon, path.join(built, 'Contents', 'Resources', 'applet.icns'))
    const resources = path.join(built, 'Contents', 'Resources')
    // The applet's asset catalog would win over applet.icns
    fs.rmSync(path.join(resources, 'Assets.car'), { force: true })
    const plist = path.join(built, 'Contents', 'Info.plist')
    await run('plutil', ['-remove', 'CFBundleIconName', plist]).catch(() => {})
    await run('plutil', ['-replace', 'CFBundleIdentifier', '-string', APP_ID, plist])
    await run('plutil', ['-replace', 'CFBundleDisplayName', '-string', APP_NAME, plist])
    await run('plutil', ['-replace', 'NSAppTransportSecurity', '-json', '{"NSAllowsLocalNetworking":true}', plist])
    await run('codesign', ['--force', '--sign', '-', built])
    fs.rmSync(app, { recursive: true, force: true })
    fs.renameSync(built, app)
    // Finder and the Dock cache icons by bundle mtime
    fs.utimesSync(app, new Date(), new Date())
    fs.writeFileSync(stampFile, stamp)
    return app
  } finally {
    fs.rmSync(work, { recursive: true, force: true })
  }
}

/** Waits briefly for the launched process to fail: an `error`, or an exit with a failing code. Resolves null when it did not. */
function earlyFailure(child) {
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(null), SPAWN_GRACE_MS)
    const done = err => { clearTimeout(timer); resolve(err) }
    child.once('error', done)
    child.once('exit', code => { if (code) done(new Error(`exited with code ${code}`)) })
  })
}

async function launch(spawn, cmd, args) {
  const child = spawn(cmd, args, { detached: true, stdio: 'ignore' })
  const failed = await earlyFailure(child)
  if (!failed) child.unref?.()
  return failed
}

/**
 * The applet writes `ready` once its window is up, or `error.log` and exits non-zero when it cannot (it must never show
 * an error dialog). Throws the logged error; a silent applet is given up on after READY_MS.
 */
async function nativeReady(dir, timeoutMs = READY_MS) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (fs.existsSync(path.join(dir, 'error.log'))) throw new Error(fs.readFileSync(path.join(dir, 'error.log'), 'utf8').trim())
    if (fs.existsSync(path.join(dir, 'ready'))) return
    await new Promise(r => setTimeout(r, 100))
  }
  throw new Error('the app did not report ready')
}

async function openNative(url, { dir, width, height, ensure, spawn, confirm }) {
  const app = await ensure({ dir })
  fs.mkdirSync(dir, { recursive: true })
  // The applet reads these on start and polls url.txt, so a relaunch on another port just navigates
  fs.writeFileSync(path.join(dir, 'size.txt'), `${width}x${height}`)
  fs.writeFileSync(path.join(dir, 'url.txt'), url)
  for (const name of ['ready', 'error.log']) fs.rmSync(path.join(dir, name), { force: true })
  const failed = await launch(spawn, 'open', ['-a', app])
  if (failed) throw failed
  await confirm(dir)
  return { kind: 'native', path: app }
}

/** The .desktop entry that lets a Linux shell group the window under the q-pilot icon (StartupWMClass matches --class). */
function writeDesktopEntry({ desktopDir, iconDir, icon = ICON_SVG }) {
  fs.mkdirSync(desktopDir, { recursive: true })
  fs.mkdirSync(iconDir, { recursive: true })
  const iconCopy = path.join(iconDir, 'icon.svg')
  fs.copyFileSync(icon, iconCopy)
  const entry = path.join(desktopDir, `${WM_CLASS}.desktop`)
  const text = `[Desktop Entry]\nType=Application\nName=${APP_NAME}\nIcon=${iconCopy}\nStartupWMClass=${WM_CLASS}\nNoDisplay=true\nExec=true\n`
  if (!fs.existsSync(entry) || fs.readFileSync(entry, 'utf8') !== text) fs.writeFileSync(entry, text)
}

/**
 * Opens url as a standalone app window. Returns { ok: true, browser } or { ok: false, reason }. Never throws.
 * On macOS it is a native shell (browser.kind 'native') first, then a Chromium-family browser's --app mode.
 * The Chromium profile is dedicated, so the window is apart from the person's browsing and from the browser under test.
 * Launching again with the same user-data-dir hands off to the running instance (a second window of it, not a second
 * browser), so "one window" is for the caller to keep.
 */
export async function openAppWindow(url, {
  platform = process.platform,
  env = process.env,
  profileDir,
  width = 1440,
  height = 900,
  find = findAppBrowser,
  spawn = child_process.spawn,
  native,
  ensure = ensureMacApp,
  confirm = nativeReady,
  desktopDir = path.join(env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'applications'),
  ...opts
} = {}) {
  if (!validLoopbackUrl(url)) return { ok: false, reason: 'only an http://127.0.0.1:<port> URL can open as an app window' }
  const root = cacheRoot(platform, env)
  const reasons = []
  // Injected fakes mean a test: it must never build or launch the real app unless it also injects `ensure`
  const useNative = native ?? (ensure !== ensureMacApp || (find === findAppBrowser && spawn === child_process.spawn))
  if (platform === 'darwin' && useNative) {
    try {
      return { ok: true, browser: await openNative(url, { dir: root, width, height, ensure, spawn, confirm }) }
    } catch (err) {
      reasons.push(`native shell: ${err?.message ?? err}`)
    }
  }
  try {
    const browser = await find({ platform, env, ...opts })
    if (!browser) return { ok: false, reason: [...reasons, 'no Chromium-family browser found (Chrome, Edge, Chromium, Brave, Playwright Chromium)'].join('; ') }
    const dir = profileDir ?? path.join(root, 'dashboard-window')
    fs.mkdirSync(dir, { recursive: true })
    const args = [
      `--app=${url}`,
      `--user-data-dir=${dir}`,
      `--window-size=${width},${height}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate',
    ]
    if (platform === 'linux') {
      args.push(`--class=${WM_CLASS}`)
      try { writeDesktopEntry({ desktopDir, iconDir: root }) } catch {}
    }
    const failed = await launch(spawn, browser.path, args)
    if (failed) return { ok: false, reason: [...reasons, `could not start ${browser.kind}: ${failed.message}`].join('; ') }
    return { ok: true, browser }
  } catch (err) {
    return { ok: false, reason: [...reasons, err?.message ?? String(err)].join('; ') }
  }
}
