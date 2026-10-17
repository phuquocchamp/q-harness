import { test } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { ensureMacApp, findAppBrowser, openAppWindow } from './app-window.mjs'

const has = (...paths) => p => paths.includes(p)
const fakePw = p => ({ chromium: { executablePath: () => p } })

test('macOS: Chrome wins over Edge, then Edge, Chromium, Brave', async () => {
  const chrome = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'
  const edge = '/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge'
  const brave = '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser'
  assert.deepEqual(await findAppBrowser({ platform: 'darwin', exists: has(chrome, edge, brave) }), { kind: 'chrome', path: chrome })
  assert.equal((await findAppBrowser({ platform: 'darwin', exists: has(edge, brave) })).kind, 'edge')
  assert.equal((await findAppBrowser({ platform: 'darwin', exists: has(brave) })).kind, 'brave')
})

test('Windows: searches ProgramFiles, ProgramFiles(x86), LocalAppData', async () => {
  const env = { ProgramFiles: 'C:\\PF', 'ProgramFiles(x86)': 'C:\\PF86', LocalAppData: 'C:\\L' }
  const x86 = 'C:\\PF86\\Google\\Chrome\\Application\\chrome.exe'
  const local = 'C:\\L\\Microsoft\\Edge\\Application\\msedge.exe'
  assert.deepEqual(await findAppBrowser({ platform: 'win32', env, exists: has(x86, local) }), { kind: 'chrome', path: x86 })
  assert.deepEqual(await findAppBrowser({ platform: 'win32', env, exists: has(local) }), { kind: 'edge', path: local })
})

test('Linux: looks for the binaries on PATH in order', async () => {
  const env = { PATH: '/a:/b' }
  const r = await findAppBrowser({ platform: 'linux', env, exists: has('/b/chromium', '/a/brave-browser') })
  assert.deepEqual(r, { kind: 'chromium', path: '/b/chromium' })
})

test('falls back to the Playwright bundled Chromium, then null', async () => {
  const bundled = '/pw/chromium'
  const opts = { platform: 'linux', env: { PATH: '/a' } }
  assert.deepEqual(await findAppBrowser({ ...opts, exists: has(bundled), playwright: fakePw(bundled) }), { kind: 'playwright', path: bundled })
  assert.equal(await findAppBrowser({ ...opts, exists: () => false, playwright: fakePw(bundled) }), null)
  assert.equal(await findAppBrowser({ ...opts, exists: () => false, playwright: { chromium: { executablePath: () => { throw new Error('x') } } } }), null)
})

function fakeSpawn() {
  const calls = []
  const spawn = (cmd, args, o) => {
    const child = new EventEmitter()
    child.unref = () => { child.unrefd = true }
    calls.push({ cmd, args, o, child })
    return child
  }
  return { calls, spawn }
}
const URL_OK = 'http://127.0.0.1:8767/'

const tmp = () => mkdtempSync(join(tmpdir(), 'aw-'))
const chromeFinder = async () => ({ path: '/bin/chrome', kind: 'chrome' })

test('launches detached with the app argv and a created profile dir', async () => {
  const { calls, spawn } = fakeSpawn()
  const profileDir = join(tmp(), 'p', 'dashboard-window')
  const r = await openAppWindow(URL_OK, { platform: 'win32', env: {}, profileDir, find: chromeFinder, spawn })
  assert.deepEqual(r, { ok: true, browser: { path: '/bin/chrome', kind: 'chrome' } })
  const [c] = calls
  assert.equal(c.cmd, '/bin/chrome')
  assert.deepEqual(c.args, [`--app=${URL_OK}`, `--user-data-dir=${profileDir}`, '--window-size=1440,900', '--no-first-run', '--no-default-browser-check', '--disable-features=Translate'])
  assert.deepEqual(c.o, { detached: true, stdio: 'ignore' })
  assert.equal(c.child.unrefd, true)
  assert.ok(existsSync(profileDir))
})

test('Linux: sets the window class and writes the desktop entry once', async () => {
  const { calls, spawn } = fakeSpawn()
  const base = tmp()
  const env = { XDG_CACHE_HOME: join(base, 'cache') }
  const desktopDir = join(base, 'applications')
  await openAppWindow(URL_OK, { platform: 'linux', env, desktopDir, find: chromeFinder, spawn })
  assert.ok(calls[0].args.includes('--class=q-pilot-dashboard'))
  assert.ok(calls[0].args.includes(`--user-data-dir=${join(base, 'cache', 'q-pilot', 'dashboard-window')}`))
  const entry = readFileSync(join(desktopDir, 'q-pilot-dashboard.desktop'), 'utf8')
  assert.match(entry, /StartupWMClass=q-pilot-dashboard/)
  assert.match(entry, new RegExp(`Icon=${join(base, 'cache', 'q-pilot', 'icon.svg')}`))
  assert.ok(existsSync(join(base, 'cache', 'q-pilot', 'icon.svg')))
})

test('macOS: opens the native shell with url and size files, kind native', async () => {
  const { calls, spawn } = fakeSpawn()
  const home = tmp()
  const ensured = []
  const r = await openAppWindow(URL_OK, { platform: 'darwin', env: { HOME: home }, width: 1000, height: 700, find: chromeFinder, spawn, confirm: async () => {}, ensure: async o => { ensured.push(o.dir); return join(o.dir, 'App.app') } })
  assert.equal(r.ok, true)
  assert.equal(r.browser.kind, 'native')
  assert.deepEqual(calls.map(c => [c.cmd, c.args]), [['open', ['-a', r.browser.path]]])
  const dir = ensured[0]
  assert.equal(dir, join(home, 'Library', 'Caches', 'q-pilot'))
  assert.equal(readFileSync(join(dir, 'url.txt'), 'utf8'), URL_OK)
  assert.equal(readFileSync(join(dir, 'size.txt'), 'utf8'), '1000x700')
})

test('macOS: a failing shell build falls back to the Chromium --app window', async () => {
  const { calls, spawn } = fakeSpawn()
  const r = await openAppWindow(URL_OK, { platform: 'darwin', profileDir: join(tmp(), 'p'), find: chromeFinder, spawn, confirm: async () => {}, ensure: async () => { throw new Error('osacompile failed') } })
  assert.equal(r.ok, true)
  assert.equal(r.browser.kind, 'chrome')
  assert.equal(calls[0].cmd, '/bin/chrome')
  const none = await openAppWindow(URL_OK, { platform: 'darwin', find: async () => null, spawn, ensure: async () => { throw new Error('osacompile failed') } })
  assert.equal(none.ok, false)
  assert.match(none.reason, /osacompile failed.*no Chromium/)
})

test('macOS: injected find and spawn alone never build or launch the real shell', async () => {
  const { calls, spawn } = fakeSpawn()
  const r = await openAppWindow(URL_OK, { platform: 'darwin', profileDir: join(tmp(), 'p'), find: chromeFinder, spawn })
  assert.equal(r.browser.kind, 'chrome')
  assert.equal(calls[0].cmd, '/bin/chrome')
})

test('macOS: an applet that logs an error makes the launch fall back to Chromium', async () => {
  const { spawn } = fakeSpawn()
  const home = tmp()
  const dir = join(home, 'Library', 'Caches', 'q-pilot')
  mkdirSync(dir, { recursive: true })
  // A stale marker from an earlier run must not count
  writeFileSync(join(dir, 'ready'), '1')
  const r = await openAppWindow(URL_OK, {
    platform: 'darwin', env: { HOME: home }, profileDir: join(home, 'p'), find: chromeFinder, spawn,
    ensure: async o => join(o.dir, 'App.app'),
    confirm: async d => { assert.equal(existsSync(join(d, 'ready')), false); writeFileSync(join(d, 'error.log'), 'boom\n'); throw new Error(readFileSync(join(d, 'error.log'), 'utf8').trim()) },
  })
  assert.equal(r.ok, true)
  assert.equal(r.browser.kind, 'chrome')
})

function fakeTools({ failOn } = {}) {
  const log = []
  const run = async (cmd, args) => {
    log.push([cmd, ...args])
    if (cmd === failOn) throw new Error(`${cmd} failed`)
    const out = args[args.indexOf('-o') + 1]
    if (cmd === 'osacompile') mkdirSync(join(out, 'Contents', 'Resources'), { recursive: true })
  }
  return { log, run }
}
const fixture = () => {
  const d = tmp()
  writeFileSync(join(d, 's.jxa'), 'script')
  writeFileSync(join(d, 'i.icns'), 'icns')
  return { dir: join(d, 'cache'), script: join(d, 's.jxa'), icon: join(d, 'i.icns') }
}

test('ensureMacApp compiles the applet, copies the icns, patches the plist and signs', async () => {
  const f = fixture()
  const { log, run } = fakeTools()
  const app = await ensureMacApp({ ...f, run })
  assert.equal(app, join(f.dir, 'q-pilot Dashboard.app'))
  assert.ok(existsSync(app))
  assert.deepEqual(log.map(l => l[0]).filter((c, i, a) => a.indexOf(c) === i), ['osacompile', 'plutil', 'codesign'])
  assert.deepEqual(log[0].slice(0, 4), ['osacompile', '-l', 'JavaScript', '-s'])
  assert.equal(readFileSync(join(app, 'Contents', 'Resources', 'applet.icns'), 'utf8'), 'icns')
  const plist = log.filter(l => l[0] === 'plutil').map(l => l.slice(1, 3).join(' '))
  assert.deepEqual(plist, ['-remove CFBundleIconName', '-replace CFBundleIdentifier', '-replace CFBundleDisplayName', '-replace NSAppTransportSecurity'])
  assert.deepEqual(readdirSync(f.dir).sort(), ['q-pilot Dashboard.app', 'shell.stamp'])
})

test('ensureMacApp skips the build while script and icon are unchanged, rebuilds when either changes', async () => {
  const f = fixture()
  const first = fakeTools()
  await ensureMacApp({ ...f, run: first.run })
  const same = fakeTools()
  await ensureMacApp({ ...f, run: same.run })
  assert.equal(same.log.length, 0)
  writeFileSync(f.icon, 'icns v2')
  const changed = fakeTools()
  await ensureMacApp({ ...f, run: changed.run })
  assert.ok(changed.log.length > 0)
})

test('ensureMacApp leaves nothing behind and keeps the old app when a step fails', async () => {
  const f = fixture()
  await ensureMacApp({ ...f, run: fakeTools().run })
  writeFileSync(f.script, 'script v2')
  await assert.rejects(ensureMacApp({ ...f, run: fakeTools({ failOn: 'codesign' }).run }), /codesign failed/)
  assert.deepEqual(readdirSync(f.dir).sort(), ['q-pilot Dashboard.app', 'shell.stamp'])
})

test('rejects URLs that are not loopback http with a port', async () => {
  const { calls, spawn } = fakeSpawn()
  const find = async () => ({ path: '/bin/chrome', kind: 'chrome' })
  for (const bad of ['https://127.0.0.1:1/', 'http://localhost:1/', 'http://example.com/', 'http://127.0.0.1/', 'javascript:alert(1)', 'nope', '']) {
    const r = await openAppWindow(bad, { find, spawn })
    assert.equal(r.ok, false, bad)
  }
  assert.equal(calls.length, 0)
})

test('no browser found gives ok:false', async () => {
  const r = await openAppWindow(URL_OK, { platform: 'linux', desktopDir: tmp(), find: async () => null, spawn: fakeSpawn().spawn })
  assert.equal(r.ok, false)
  assert.match(r.reason, /no Chromium/)
})

test('a spawn error becomes ok:false and a throwing find never throws', async () => {
  const profileDir = join(mkdtempSync(join(tmpdir(), 'aw-')), 'p')
  const { calls, spawn } = fakeSpawn()
  const pending = openAppWindow(URL_OK, { platform: 'win32', env: {}, profileDir, find: async () => ({ path: '/nope', kind: 'chrome' }), spawn })
  await new Promise(r => setImmediate(r))
  calls[0].child.emit('error', new Error('ENOENT'))
  const r = await pending
  assert.equal(r.ok, false)
  assert.match(r.reason, /ENOENT/)
  const t = await openAppWindow(URL_OK, { platform: 'win32', env: {}, find: async () => { throw new Error('boom') } })
  assert.deepEqual(t, { ok: false, reason: 'boom' })
})

test('live: opens a real app window', { skip: process.env.Q_PILOT_LIVE !== '1' }, async () => {
  const r = await openAppWindow(URL_OK)
  assert.equal(typeof r.ok, 'boolean')
})
