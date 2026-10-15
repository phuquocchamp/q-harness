import { test } from 'node:test'
import assert from 'node:assert/strict'
import { match } from './replay.mjs'

const a = (node, over) => ({ node, kind: 'click', role: 'button', name: 'Add', scope: '', ...over })

test('one candidate is acted on', () => {
  const r = match([a(1), a(2, { name: 'Other' })], { op: 'click', role: 'button', name: 'Add', scope: 'x' })
  assert.equal(r.action.node, 1)
})

test('name matching collapses whitespace; op and role must agree', () => {
  assert.equal(match([a(1, { name: 'Add' })], { op: 'click', role: 'button', name: ' Add ' }).action.node, 1)
  assert.equal(match([a(1)], { op: 'fill', role: 'button', name: 'Add' }).action, null)
  assert.equal(match([a(1)], { op: 'click', role: 'link', name: 'Add' }).action, null)
})

test('no candidate is a miss', () => {
  assert.deepEqual(match([a(1)], { op: 'click', role: 'button', name: 'Pay' }), { action: null, candidates: 0 })
})

test('look-alikes are narrowed by scope', () => {
  const list = [a(1, { scope: 'Coffee' }), a(2, { scope: 'Tea' })]
  assert.equal(match(list, { op: 'click', role: 'button', name: 'Add', scope: 'Tea' }).action.node, 2)
})

test('look-alikes that scope cannot tell apart are a miss, never a guess', () => {
  const same = [a(1, { scope: 'Cart' }), a(2, { scope: 'Cart' })]
  assert.deepEqual(match(same, { op: 'click', role: 'button', name: 'Add', scope: 'Cart' }), { action: null, candidates: 2 })
  assert.equal(match(same, { op: 'click', role: 'button', name: 'Add', scope: 'Other' }).action, null)
  assert.equal(match([a(1, { scope: 'A' }), a(2, { scope: 'B' })], { op: 'click', role: 'button', name: 'Add' }).action, null)
})

test('select steps also match the option; one node listed twice counts once', () => {
  const sel = [a(1, { kind: 'select', role: 'combobox', name: 'Size', option: 'S' }), a(1, { kind: 'select', role: 'combobox', name: 'Size', option: 'L' })]
  assert.equal(match(sel, { op: 'select', role: 'combobox', name: 'Size', option: 'L' }).action.option, 'L')
  assert.equal(match([a(1), a(1)], { op: 'click', role: 'button', name: 'Add' }).candidates, 1)
})
