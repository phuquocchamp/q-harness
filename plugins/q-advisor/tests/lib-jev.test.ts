import { expect, test } from 'claude-code/testing'

import type { Recent } from '../hooks/lib/contract'
import { DEFAULT_JEV_MODEL, RELATION_TEXT, SIZE_TEXT, finishedRequest, keepRequest, parseFinished, parseKeep, parsePrompt, promptRequest } from '../hooks/lib/jev'

const RECENT: Recent = { recentWork: 'Added pagination.', lastReply: 'Done, tests green.', todoState: 'all completed', toolErrors: 'none' }

const choice = (probabilities: Record<string, number>, pick: string) => ({ type: 'choice', choice: pick, confidence: probabilities[pick], probabilities })
const REL = choice({ continuation: 0.95, 'new-task': 0.03, 'side-question': 0.02 }, 'continuation')
const SIZE = choice({ trivial: 0.1, routine: 0.85, deep: 0.05 }, 'routine')

test('promptRequest asks relation and size with the validated criteria', () => {
  const body = JSON.parse(promptRequest({ recent: RECENT, newPrompt: 'add a test' }))
  expect(body.model).toBe(DEFAULT_JEV_MODEL)
  expect(Object.keys(body.questions)).toEqual(['relation', 'size'])
  expect(body.questions.relation.type).toBe('choice')
  expect(body.questions.relation.criteria).toEqual(RELATION_TEXT)
  expect(body.questions.size.criteria).toEqual(SIZE_TEXT)
  expect(body.state).toEqual({ recent_work: 'Added pagination.', last_reply: 'Done, tests green.', todo_state: 'all completed', tool_errors: 'none', new_prompt: 'add a test' })
})

test('finishedRequest asks only finished and sends no new_prompt', () => {
  const body = JSON.parse(finishedRequest({ recent: RECENT, model: 'jev-x' }))
  expect(body.model).toBe('jev-x')
  expect(Object.keys(body.questions)).toEqual(['finished'])
  expect(body.questions.finished.type).toBe('noul')
  expect('new_prompt' in body.state).toBe(false)
})

test('keepRequest builds one noul with criteria per candidate', () => {
  const body = JSON.parse(keepRequest({ remainingWork: 'finish phase 1', candidates: [{ id: 'c1', kind: 'plan', text: 'the plan' }, { id: 'c2', kind: 'todo', text: 'a todo' }] }))
  expect(body.state).toEqual({ remaining_work: 'finish phase 1', item_c1: 'the plan', item_c2: 'a todo' })
  expect(Object.keys(body.questions)).toEqual(['c1', 'c2'])
  expect(body.questions.c1.type).toBe('noul')
  expect(body.questions.c1.instructions).toContain('item_c1')
  expect(typeof body.questions.c1.criteria.true).toBe('string')
  expect(typeof body.questions.c1.criteria.false).toBe('string')
})

test('state strings are redacted, including extra secrets', () => {
  const recent = { ...RECENT, recentWork: 'curl -H "Authorization: Bearer abc12345xyz" and key hunter2secret' }
  const text = promptRequest({ recent, newPrompt: 'use hunter2secret', secrets: ['hunter2secret'] }) + keepRequest({ remainingWork: 'x', candidates: [{ id: 'c1', kind: 'goal', text: 'Bearer abc12345xyz' }], secrets: ['hunter2secret'] })
  expect(text).not.toContain('abc12345xyz')
  expect(text).not.toContain('hunter2secret')
  expect(text).toContain('[redacted]')
})

test('long state fields are capped with a truncation marker', () => {
  const long = 'a '.repeat(3000)
  const body = JSON.parse(promptRequest({ recent: { ...RECENT, recentWork: long, lastReply: long }, newPrompt: long }))
  expect(body.state.recent_work.startsWith('a '.repeat(10))).toBe(true)
  expect(body.state.recent_work).toContain('…[truncated')
  expect(body.state.recent_work.length).toBeLessThan(1600)
  expect(body.state.last_reply.length).toBeLessThan(1300)
  expect(body.state.new_prompt.length).toBeLessThan(1600)
  const keep = JSON.parse(keepRequest({ remainingWork: 'r', candidates: [{ id: 'c1', kind: 'plan', text: long }] }))
  expect(keep.state.item_c1).toContain('…[truncated')
  expect(keep.state.item_c1.length).toBeLessThan(500)
})

test('parsePrompt reads relation and size', () => {
  const r = parsePrompt(JSON.stringify({ answers: { relation: REL, size: SIZE } }))
  expect(r).toEqual({ relation: { label: 'continuation', p: 0.95 }, size: { label: 'routine', p: 0.85 } })
})

test('parsePrompt drops a single invalid question and fails when both are invalid', () => {
  const badSum = choice({ continuation: 0.5, 'new-task': 0.03, 'side-question': 0.02 }, 'continuation')
  expect(parsePrompt(JSON.stringify({ answers: { relation: badSum, size: SIZE } }))).toEqual({ size: { label: 'routine', p: 0.85 } })
  const notArgmax = { ...REL, choice: 'new-task' }
  expect(parsePrompt(JSON.stringify({ answers: { relation: notArgmax, size: SIZE } }))).toEqual({ size: { label: 'routine', p: 0.85 } })
  expect(parsePrompt(JSON.stringify({ answers: { relation: badSum, size: notArgmax } }))).toBeUndefined()
  expect(parsePrompt(JSON.stringify({ answers: { size: SIZE } }))).toEqual({ size: { label: 'routine', p: 0.85 } })
  expect(parsePrompt(JSON.stringify({}))).toBeUndefined()
  expect(parsePrompt('not json')).toBeUndefined()
})

test('parseFinished returns a noul in range only', () => {
  expect(parseFinished(JSON.stringify({ answers: { finished: { type: 'noul', noul: 0.93 } } }))).toBe(0.93)
  expect(parseFinished(JSON.stringify({ answers: { finished: { noul: 1.2 } } }))).toBeUndefined()
  expect(parseFinished(JSON.stringify({ answers: { finished: { noul: -0.1 } } }))).toBeUndefined()
  expect(parseFinished(JSON.stringify({ answers: { finished: { noul: 'high' } } }))).toBeUndefined()
  expect(parseFinished(JSON.stringify({ answers: {} }))).toBeUndefined()
  expect(parseFinished('{bad')).toBeUndefined()
})

test('parseKeep returns every id or nothing', () => {
  const ok = JSON.stringify({ answers: { c1: { noul: 0.9 }, c2: { noul: 0.1 } } })
  expect(parseKeep(ok, ['c1', 'c2'])).toEqual({ c1: 0.9, c2: 0.1 })
  expect(parseKeep(ok, ['c1', 'c2', 'c3'])).toBeUndefined()
  expect(parseKeep(JSON.stringify({ answers: { c1: { noul: 0.9 }, c2: { noul: 2 } } }), ['c1', 'c2'])).toBeUndefined()
  expect(parseKeep('nope', ['c1'])).toBeUndefined()
  expect(parseKeep(ok, [])).toEqual({})
})
