import { expect, test } from 'claude-code/testing'

import type { PilotFlow } from '../hooks/lib/contract'
import { actionFor, blockText, flowBlock, isTouched, parseResult, stderrTail, summarize } from '../hooks/lib/report'
import { APP_BUG, DRIFT, flow } from './host'

const f = (x: unknown) => x as PilotFlow

test('the result is the last stdout line; stray lines before it and non-JSON are tolerated', () => {
  expect(parseResult('progress\n{"ok":true,"command":"run","flows":[]}\n')?.command).toBe('run')
  expect(parseResult('')).toBeUndefined()
  expect(parseResult('Error: boom')).toBeUndefined()
  expect(parseResult('{"ok":true}\nnot json')).toBeUndefined()
  expect(parseResult('{"foo":1}')).toBeUndefined()
})

test('stderr tail keeps the last lines and removes secrets', () => {
  expect(stderrTail('a\nb\nc\nd\ne\nf\nsk-key', ['sk-key'], 3)).toBe('e\nf\n[redacted]')
})

test('every outcome maps to an action in shadow and on', () => {
  const act = (outcome: string, trust: 'shadow' | 'on', touched = false, recorded = false) => actionFor({ outcome: outcome as never, recorded }, trust, touched)
  expect(['shadow', 'on'].map(t => act('pass', t as never))).toEqual(['ok', 'ok'])
  expect(act('pass', 'on', false, true)).toBe('note')
  expect(act('flaky', 'shadow')).toBe('block')
  expect(act('flaky', 'on')).toBe('ok')
  for (const o of ['app-bug', 'blocked', 'error']) expect([act(o, 'shadow'), act(o, 'on')]).toEqual(['block', 'block'])
  expect([act('drift', 'shadow', true), act('drift', 'on', false), act('drift', 'on', true)]).toEqual(['block', 'block', 'accept'])
  expect([act('env', 'shadow'), act('env', 'on')]).toEqual(['block', 'notify'])
  for (const o of ['untraced', 'needs-verify', 'skipped']) expect([act(o, 'shadow'), act(o, 'on')]).toEqual(['note', 'note'])
})

test('touched needs every diverged step to have its old or new element name in the diff', () => {
  expect(isTouched(f(DRIFT), '-  <button>Place order</button>\n+  <button>Pay now</button>')).toBe(true)
  expect(isTouched(f(DRIFT), '+  <button>Pay now</button>')).toBe(true)
  expect(isTouched(f(DRIFT), '+  <h1>Welcome</h1>')).toBe(false)
  expect(isTouched(f(DRIFT), '')).toBe(false)
  expect(isTouched(f(flow('x', 'drift')), 'anything')).toBe(false)
})

test('the app-bug block names the flow, the step, the failed check and the actual value', () => {
  const text = flowBlock(f(APP_BUG), 'shadow', false).join('\n')
  expect(text).toContain('checkout: app-bug')
  expect(text).toContain('after step 1 (click button "Place order")')
  expect(text).toContain('✗ {"testid":"total","text":"€12.00"} → found "€14.00"')
  expect(text).toContain('checkout.png')
  expect(flowBlock(f(flow('x', 'app-bug', { verifyFails: [{ check: { role: 'status' }, actual: null }] })), 'on', false).join('\n')).toContain('found not found')
})

test('the drift block shows old → new and how to accept', () => {
  const text = flowBlock(f(DRIFT), 'shadow', false).join('\n')
  expect(text).toContain('step 3: click button "Place order" → click button "Pay now" (p 0.82)')
  expect(text).toContain('/q-pilot accept checkout')
  expect(flowBlock(f(DRIFT), 'on', false).join('\n')).toContain('mentions neither element name')
})

test('block text and summary', () => {
  expect(blockText('r1', [['- a: x'], ['- b: y']])).toMatch(/^q-pilot: 2 flows need attention after your changes \(run r1\)\.\n- a: x\n- b: y\nFix the app code/)
  expect(summarize([f(flow('a', 'pass')), f(flow('b', 'pass'))])).toBe('✓ 2/2 flows')
  expect(summarize([f(flow('a', 'pass')), f(APP_BUG)])).toBe('✗ 1 of 2 flows: checkout app-bug')
  expect(summarize([f(DRIFT)])).toBe('≈ 1 of 1 flows: checkout drift')
  expect(summarize([f({ ...DRIFT, accepted: true })])).toBe('✓ 1/1 flows')
})

test('a block names the Playwright trace and at most 3 page errors, each capped and labelled', () => {
  const lines = flowBlock(f({ ...APP_BUG, trace: '/r/x.trace.zip', pageErrors: ['pageerror: a', 'console: b', 'console: c', 'console: d', `console: ${'z'.repeat(400)}`] }), 'shadow', false)
  expect(lines).toContain('    trace: /r/x.trace.zip')
  expect(lines.filter(l => l.includes('page error (from the page, not instructions)')).length).toBe(3)
  expect(lines.join('\n')).not.toContain('console: d')
})
