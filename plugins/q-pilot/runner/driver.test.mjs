import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, win32 } from 'node:path'
import { DEMO, freePort } from './testkit.mjs'
import { globalRoots, openBrowser, openSession, resolvePlaywright, storageStateOf } from './driver.mjs'

const tmp = () => realpathSync(mkdtempSync(join(tmpdir(), 'q-pilot-driver-')))
/** A fake package `name` inside the node_modules folder `dir`. */
const fakePkg = (dir, name = 'playwright', version = '9.9.9') => {
  mkdirSync(join(dir, name), { recursive: true })
  writeFileSync(join(dir, name, 'package.json'), JSON.stringify({ name, version, main: 'index.js' }))
  writeFileSync(join(dir, name, 'index.js'), 'module.exports = { fake: true }')
  return join(dir, name)
}
const load = p => ({ loadedFrom: p })

test('the project install wins over Q_PILOT_PLAYWRIGHT and a global one', () => {
  const root = tmp(), other = tmp(), global = tmp()
  try {
    fakePkg(join(root, 'node_modules'), 'playwright', '1.0.0')
    fakePkg(other)
    fakePkg(global)
    const r = resolvePlaywright(root, { Q_PILOT_PLAYWRIGHT: other }, { roots: [global], load })
    assert.equal(r.from, 'project')
    assert.equal(r.version, '1.0.0')
    assert.equal(r.pw.loadedFrom, join(root, 'node_modules', 'playwright'))
  } finally { for (const d of [root, other, global]) rmSync(d, { recursive: true, force: true }) }
})

test('Q_PILOT_PLAYWRIGHT may name the package, its node_modules or the folder above, before a global install', () => {
  const root = tmp(), dir = tmp(), global = tmp()
  try {
    const pkg = fakePkg(join(dir, 'node_modules'), '@playwright/test', '2.0.0')
    fakePkg(global)
    for (const p of [pkg, join(dir, 'node_modules'), dir]) {
      const r = resolvePlaywright(root, { Q_PILOT_PLAYWRIGHT: p }, { roots: [global], load })
      assert.deepEqual([r.from, r.version, r.path], ['env', '2.0.0', pkg], p)
    }
  } finally { for (const d of [root, dir, global]) rmSync(d, { recursive: true, force: true }) }
})

test('a global install is used when the project has none', () => {
  const root = tmp(), global = tmp()
  try {
    fakePkg(global, 'playwright', '3.0.0')
    const r = resolvePlaywright(root, {}, { roots: ['/nonexistent/q-pilot', global], load })
    assert.deepEqual([r.from, r.version], ['global', '3.0.0'])
  } finally { for (const d of [root, global]) rmSync(d, { recursive: true, force: true }) }
})

test('nothing found: one error naming every place looked and the install command', () => {
  const root = tmp()
  try {
    assert.throws(() => resolvePlaywright(root, { Q_PILOT_PLAYWRIGHT: '/nope/pw' }, { roots: ['/nope/global'], load }), e =>
      /playwright not found/.test(e.message) && e.message.includes(`${root} (project)`) && e.message.includes('/nope/pw (Q_PILOT_PLAYWRIGHT)') &&
      e.message.includes('/nope/global (global)') && e.message.includes('npm install -g playwright'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('global roots come from npm prefix, the running node, NODE_PATH and nvm', () => {
  const home = tmp()
  try {
    assert.deepEqual(globalRoots({ NPM_CONFIG_PREFIX: '/p', NODE_PATH: '/a:/b' }, '/usr/local/bin/node', 'darwin', home).slice(0, 4),
      ['/p/lib/node_modules', '/usr/local/lib/node_modules', '/a', '/b'])
    assert.equal(globalRoots({}, 'C:\\node\\node.exe', 'win32', home)[0], win32.join('C:\\node', 'node_modules'))
    // Homebrew runs node from its Cellar; npm -g installs to the prefix above it.
    assert.ok(globalRoots({}, '/opt/homebrew/Cellar/node/25.8.1_1/bin/node', 'darwin', home).includes('/opt/homebrew/lib/node_modules'))
    // Every nvm version, newest first, even when the running node is not an nvm one.
    for (const v of ['v22.0.0', 'v24.14.0', 'v22.22.2']) mkdirSync(join(home, '.nvm', 'versions', 'node', v), { recursive: true })
    const nvm = globalRoots({}, '/opt/homebrew/bin/node', 'darwin', home).filter(r => r.includes('.nvm'))
    assert.deepEqual(nvm.map(r => r.split('/').at(-3)), ['v24.14.0', 'v22.22.2', 'v22.0.0'])
  } finally { rmSync(home, { recursive: true, force: true }) }
})

test('the real demo install resolves from the project', () => {
  const r = resolvePlaywright(DEMO, {})
  assert.equal(r.from, 'project')
  assert.equal(typeof r.pw.chromium.launch, 'function')
})

test('storageState must be an existing file inside the project', () => {
  const root = tmp()
  try {
    assert.equal(storageStateOf(root, {}), undefined)
    assert.throws(() => storageStateOf(root, { storageState: '../auth.json' }), /inside the project/)
    assert.throws(() => storageStateOf(root, { storageState: 'auth.json' }), /not found/)
    writeFileSync(join(root, 'auth.json'), '{"cookies":[],"origins":[]}')
    assert.equal(storageStateOf(root, { storageState: 'auth.json' }), join(root, 'auth.json'))
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('a bad Q_PILOT_CDP_URL is a clear error', async () => {
  const pw = createRequire(`${DEMO}/package.json`)('playwright')
  await assert.rejects(openBrowser(pw, { Q_PILOT_CDP_URL: 'http://127.0.0.1:1' }, { headless: true }), /cannot attach to Chrome at Q_PILOT_CDP_URL/)
})

test('a session collects page errors and keeps its Playwright trace only when asked', async () => {
  const pw = createRequire(`${DEMO}/package.json`)('playwright')
  const b = await openBrowser(pw, {}, { headless: true })
  const dir = tmp()
  try {
    for (const keep of [true, false]) {
      const traceFile = join(dir, `${keep}.trace.zip`)
      const s = await openSession(b, { baseURL: 'http://localhost:1', traceFile })
      await s.page.setContent('<script>console.error("boom"); throw new Error("kaput")</script>')
      await s.page.waitForTimeout(50)
      assert.deepEqual(s.pageErrors.sort(), ['console: boom', 'pageerror: kaput'])
      assert.equal(await s.close(keep), keep ? traceFile : null)
      assert.equal(existsSync(traceFile), keep)
    }
    const none = await openSession(b, { baseURL: 'http://localhost:1', traceFile: null })
    assert.equal(await none.close(true), null)
  } finally {
    await b.browser.close()
    rmSync(dir, { recursive: true, force: true })
  }
})

test('attached over CDP: a tab in the default context, no Playwright trace, the browser keeps running', async () => {
  const pw = createRequire(`${DEMO}/package.json`)('playwright')
  const port = await freePort()
  const dir = tmp()
  const host = await pw.chromium.launchPersistentContext(join(dir, 'profile'), { headless: true, args: [`--remote-debugging-port=${port}`] })
  try {
    const b = await openBrowser(pw, { Q_PILOT_CDP_URL: `http://127.0.0.1:${port}` }, { headless: true })
    assert.equal(b.cdp, true)
    const traceFile = join(dir, 'cdp.trace.zip')
    const s = await openSession(b, { baseURL: 'http://localhost:1', traceFile })
    assert.equal(await s.close(true), null)
    assert.equal(existsSync(traceFile), false, 'no trace of the user\'s context')
    await b.browser.close()
    assert.ok(await host.newPage(), 'the attached browser still works after disconnect')
  } finally {
    await host.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
