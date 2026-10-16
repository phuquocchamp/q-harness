// Run with: node --test scripts/sync-ui.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { COPIES, ICONS, THEME, header, sync } from './sync-ui.mjs'

const ICON = `${ICONS}/q-x.svg`
const copies = [
  { source: THEME, target: 'plugins/a/q-theme.css' },
  { source: THEME, target: 'plugins/b/deep/q-theme.css' },
  { source: ICON, target: 'plugins/a/icon.svg' },
]
const targets = copies.map(c => c.target)
let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-ui-'))
  mkdirSync(join(root, 'shared/ui'), { recursive: true })
  mkdirSync(join(root, ICONS), { recursive: true })
  writeFileSync(join(root, THEME), ':root{--q-bg:#fff}\n')
  writeFileSync(join(root, ICON), '<svg viewBox="0 0 512 512"></svg>\n')
})
after(() => rmSync(root, { recursive: true, force: true }))

test('copies each source under its generated header, creating folders', () => {
  assert.deepEqual(sync({ root, copies }), targets)
  for (const t of targets.slice(0, 2)) assert.equal(readFileSync(join(root, t), 'utf8'), `${header(THEME)}:root{--q-bg:#fff}\n`)
})

test('an icon copy gets an XML comment header and its viewBox cropped to the tile', () => {
  const svg = readFileSync(join(root, 'plugins/a/icon.svg'), 'utf8')
  assert.equal(svg, `${header(ICON)}<svg viewBox="50 50 412 412"></svg>\n`)
  assert.match(header(ICON), /^<!-- GENERATED .* -->\n$/)
})

test('check passes when the copies match and writes nothing', () => {
  assert.deepEqual(sync({ root, copies, check: true }), [])
  assert.deepEqual(sync({ root, copies }), [])
})

test('check lists drifted or missing copies without fixing them', () => {
  writeFileSync(join(root, targets[0]), 'edited by hand')
  rmSync(join(root, targets[2]))
  assert.deepEqual(sync({ root, copies, check: true }), [targets[0], targets[2]])
  assert.equal(readFileSync(join(root, targets[0]), 'utf8'), 'edited by hand')
  assert.deepEqual(sync({ root, copies }), [targets[0], targets[2]])
  assert.deepEqual(sync({ root, copies, check: true }), [])
})

test('every plugin icon copy has a source in the icons folder', () => {
  for (const { source } of COPIES) assert.ok(source === THEME || source.startsWith(`${ICONS}/`), source)
})
