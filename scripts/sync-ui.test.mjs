// Run with: node --test scripts/sync-ui.test.mjs
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { after, before, test } from 'node:test'
import { HEADER, SOURCE, sync } from './sync-ui.mjs'

const targets = ['plugins/a/q-theme.css', 'plugins/b/deep/q-theme.css']
let root

before(() => {
  root = mkdtempSync(join(tmpdir(), 'sync-ui-'))
  mkdirSync(join(root, 'shared/ui'), { recursive: true })
  writeFileSync(join(root, SOURCE), ':root{--q-bg:#fff}\n')
})
after(() => rmSync(root, { recursive: true, force: true }))

test('copies the source under the generated header, creating folders', () => {
  assert.deepEqual(sync({ root, targets }), targets)
  for (const t of targets) assert.equal(readFileSync(join(root, t), 'utf8'), `${HEADER}:root{--q-bg:#fff}\n`)
})

test('check passes when the copies match and writes nothing', () => {
  assert.deepEqual(sync({ root, targets, check: true }), [])
  assert.deepEqual(sync({ root, targets }), [])
})

test('check lists drifted or missing copies without fixing them', () => {
  writeFileSync(join(root, targets[0]), 'edited by hand')
  rmSync(join(root, targets[1]))
  assert.deepEqual(sync({ root, targets, check: true }), targets)
  assert.equal(readFileSync(join(root, targets[0]), 'utf8'), 'edited by hand')
  assert.deepEqual(sync({ root, targets }), targets)
  assert.deepEqual(sync({ root, targets, check: true }), [])
})
