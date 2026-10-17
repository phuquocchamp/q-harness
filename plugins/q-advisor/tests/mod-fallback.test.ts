// Fallbacks that only use hooks that run even where managed settings bypass session.compact and
// classic.SessionStart: /q-advisor compact, the handoff on the first prompt, the missed-compaction heuristic.

import { expect, test } from 'claude-code/testing'

import { completeMain, fakeHost, run, settle, start, stateOf, userPrompt } from './host'

const NOTE = 'GOAL: pagination. NEXT: customers list.'

test('/q-advisor compact compacts with the stored focus, counts it and spends the focus', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.percent = 75
  await completeMain($)
  await settle(host)
  expect(stateOf(host, 'focus')).toBeTruthy()
  const r = await run($, 'compact')
  expect(r.exitCode).toBeUndefined()
  expect(r.text).toMatch(/compacting with the focus/)
  await settle(host)
  expect(host.toasts.at(-1)).toMatch(/compacted with a focus/)
  expect(host.compactInputs).toEqual([expect.objectContaining({ instructions: expect.stringMatching(/pagination plan/) })])
  expect(stateOf(host, 'compactions')).toBe(1)
  expect(stateOf(host, 'focus') ?? null).toBeNull()
})

test('/q-advisor compact builds a focus from the messages when none is stored', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await run($, 'compact')
  await settle(host)
  expect(host.compactInputs[0]!.instructions).toMatch(/\S/)
  expect(stateOf(host, 'compactions')).toBe(1)
})

test('/q-advisor compact says so when the engine refuses', async ($, on) => {
  const host = fakeHost(on)
  host.compactError = 'a turn is running'
  await start($)
  await run($, 'compact')
  await settle(host)
  expect(host.toasts.at(-1)).toMatch(/could not compact/)
  expect(stateOf(host, 'compactions')).toBeUndefined()
  expect((await run($, 'help')).text).toMatch(/compact /)
})

test('the first prompt of a fresh session carries the handoff note once', async ($, on) => {
  const host = fakeHost(on)
  host.turns = 0
  await start($)
  host.store.set('handoff', { text: NOTE, at: host.clock.now() })
  await userPrompt($, 'Continue with the customers list, please.')
  expect(host.contexts.at(-1)?.join('\n')).toMatch(/GOAL: pagination/)
  expect(host.store.has('handoff')).toBe(false)
  await userPrompt($, 'And then the invoices list, please.')
  expect(host.contexts.at(-1)).toBeUndefined()
})

test('the handoff waits while the session has turns, and the SessionStart path takes it first', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.store.set('handoff', { text: NOTE, at: host.clock.now() })
  await userPrompt($, 'Continue with the customers list, please.')
  expect(host.contexts.at(-1)).toBeUndefined()
  expect(host.store.has('handoff')).toBe(true)
  host.turns = 0
  const r = await $.classic.SessionStart({ source: 'clear' } as never)
  expect(r.additionalContext?.join('\n')).toMatch(/GOAL: pagination/)
  await userPrompt($, 'Continue with the customers list, please.')
  expect(host.contexts.at(-1)).toBeUndefined()
})

test('a stale handoff note is not injected on a prompt', async ($, on) => {
  const host = fakeHost(on)
  host.turns = 0
  await start($)
  host.store.set('handoff', { text: NOTE, at: host.clock.now() })
  await host.clock.advance(31 * 60_000)
  await userPrompt($, 'Continue with the customers list, please.')
  expect(host.contexts.at(-1)).toBeUndefined()
})

test('a context that fell by more than half between turns counts as a compaction', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.percent = 75
  host.usage.tokens = 150_000
  await completeMain($)
  await settle(host)
  expect(stateOf(host, 'focus')).toBeTruthy()
  host.usage.percent = 20
  host.usage.tokens = 40_000
  await completeMain($, 't2')
  await settle(host)
  expect(stateOf(host, 'compactions')).toBe(1)
  expect(stateOf(host, 'focus') ?? null).toBeNull()
})

test('a smaller drop is no compaction', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.tokens = 100_000
  await completeMain($)
  await settle(host)
  host.usage.tokens = 70_000
  await completeMain($, 't2')
  await settle(host)
  expect(stateOf(host, 'compactions') ?? 0).toBe(0)
})

test('our own compaction is not counted again by the next turn', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.tokens = 100_000
  await completeMain($)
  await settle(host)
  await run($, 'compact')
  await settle(host)
  host.usage.tokens = 20_000
  await completeMain($, 't2')
  await settle(host)
  expect(stateOf(host, 'compactions')).toBe(1)
})

test('a turn count that went down means a /clear: the compaction count starts over', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await run($, 'compact')
  await settle(host)
  host.turns = 8
  await completeMain($)
  await settle(host)
  host.turns = 1
  await completeMain($, 't2')
  await settle(host)
  expect(stateOf(host, 'compactions')).toBe(0)
})
