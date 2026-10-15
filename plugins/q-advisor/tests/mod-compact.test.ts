// session.compact: the stored focus joins the engine's own autocompact, nothing else is touched.
// classic.SessionStart: a handoff note rides a /clear once.

import { expect, test } from 'claude-code/testing'

import { compact, completeMain, fakeHost, settle, start, stateOf } from './host'
import type { Host } from './host'

/** A turn end at 75% context: the focus is computed (Haiku's text) and stored. */
const withFocus = async ($: Parameters<typeof start>[0], host: Host) => {
  host.usage.percent = 75
  await completeMain($)
  await settle(host)
  expect(stateOf<{ text: string }>(host, 'focus')?.text).toMatch(/pagination plan/)
}

test('an auto compaction of the main conversation gets the focus, merged with its own instructions', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await withFocus($, host)
  const r = await compact($, 'auto', { instructions: 'be brief' })
  expect(r.skip).toBeUndefined()
  expect(host.compactInputs[0]!.trigger).toBe('auto')
  expect(host.compactInputs[0]!.instructions).toMatch(/be brief/)
  expect(host.compactInputs[0]!.instructions).toMatch(/pagination plan/)
  // It counted, and the focus is spent.
  expect(stateOf(host, 'compactions')).toBe(1)
  expect(stateOf(host, 'focus') ?? null).toBeNull()
  await compact($, 'auto')
  expect(host.compactInputs[1]!.instructions).toBeUndefined()
})

test('manual, plugin, precompute and a subagent compaction pass through untouched', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await withFocus($, host)
  for (const trigger of ['manual', 'plugin', 'precompute'] as const) {
    const r = await compact($, trigger)
    expect(r.skip).toBeUndefined()
  }
  const sub = await compact($, 'auto', { agentId: 'a1' })
  expect(sub.skip).toBeUndefined()
  expect(host.compactInputs.map(i => i.instructions)).toEqual([undefined, undefined, undefined, undefined])
  expect(host.compactInputs[3]!.agentId).toBe('a1')
  // The manual and plugin ones counted for the main conversation; precompute and the subagent did not.
  expect(stateOf(host, 'compactions')).toBe(2)
})

test('focusCompact off leaves autocompact untouched', { options: { focusCompact: 'off' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.percent = 75
  await completeMain($)
  await settle(host)
  expect(stateOf(host, 'focus') ?? null).toBeNull()
  await compact($, 'auto')
  expect(host.compactInputs[0]!.instructions).toBeUndefined()
})

test('a compaction with no stored focus passes through', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await compact($, 'auto')
  expect(host.compactInputs[0]!.instructions).toBeUndefined()
})

test('SessionStart(clear) injects the handoff note exactly once', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.store.set('handoff', { text: 'GOAL: pagination. NEXT: customers list.', at: host.clock.now() })
  const first = await $.classic.SessionStart({ source: 'clear' } as never)
  expect(first.additionalContext?.join('\n')).toMatch(/GOAL: pagination/)
  expect(host.store.has('handoff')).toBe(false)
  const second = await $.classic.SessionStart({ source: 'clear' } as never)
  expect(second.additionalContext ?? []).toEqual([])
})

test('a handoff note older than 30 minutes is dropped, not injected', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.store.set('handoff', { text: 'OLD NOTE', at: host.clock.now() })
  await host.clock.advance(31 * 60_000)
  const r = await $.classic.SessionStart({ source: 'clear' } as never)
  expect(r.additionalContext ?? []).toEqual([])
  expect(host.store.has('handoff')).toBe(false)
})

test('other SessionStart sources leave the handoff note alone', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.store.set('handoff', { text: 'NOTE', at: host.clock.now() })
  for (const source of ['startup', 'resume', 'compact', 'fork'] as const) {
    const r = await $.classic.SessionStart({ source } as never)
    expect(r.additionalContext ?? []).toEqual([])
  }
  expect(host.store.has('handoff')).toBe(true)
})

test('a /clear starts the compaction count over', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await compact($, 'manual')
  expect(stateOf(host, 'compactions')).toBe(1)
  await $.classic.SessionStart({ source: 'clear' } as never)
  expect(stateOf(host, 'compactions')).toBe(0)
  expect(host.compactInputs.length).toBe(1)
})
