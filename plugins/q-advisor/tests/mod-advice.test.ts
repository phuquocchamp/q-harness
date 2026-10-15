// turn.complete and the band: shadow mode only logs, mode on shows one line with its buttons.

import { expect, test } from 'claude-code/testing'

import { adviceLogOf, completeMain, decisionsOf, fakeHost, mountBand, settle, start, stateOf, userPrompt } from './host'
import type { Host } from './host'

const ON = { options: { mode: 'on', jevApiKey: 'k' } }

/** Context at `percent`, Jev saying the task finished at `finished`; one turn ends. */
const endTurn = async ($: Parameters<typeof start>[0], host: Host, percent: number, finished: number) => {
  host.usage.percent = percent
  host.jev = { status: 200, finished, keep: 0.9 }
  await completeMain($)
  await settle(host)
}

test('shadow mode logs the advice and shows nothing', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.9)
  expect(adviceLogOf(host)).toEqual([expect.objectContaining({ kind: 'compact-now', mode: 'shadow', shown: false })])
  expect(decisionsOf(host).map(d => d.question)).toContain('finished')
  expect(host.suggested).toEqual([])
  expect(host.toasts).toEqual([])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /q-advisor/ })).toBeUndefined()
  await band.unmount()
})

test('mode on shows compact-now at 65% context with the task finished (p 0.9)', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.9)
  expect(adviceLogOf(host)).toEqual([expect.objectContaining({ kind: 'compact-now', mode: 'on', shown: true, outcome: 'pending' })])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /compact now/ })).toBeDefined()
  expect(await band.find({ key: 'accept' })).toBeDefined()
  expect(await band.find({ key: 'dismiss' })).toBeDefined()
  await band.unmount()
  // The context is below the focus line, so no /compact suggestion yet.
  expect(host.suggested).toEqual([])
})

test('the band stays out of the way while Claude is working', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.9)
  const band = await mountBand($, { isWorking: true })
  expect(await band.find({ type: 'Text', text: /compact now/ })).toBeUndefined()
  await band.unmount()
})

test('a finished verdict below its threshold stays quiet', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.6)
  expect(adviceLogOf(host)).toEqual([])
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /q-advisor/ })).toBeUndefined()
  await band.unmount()
})

test('below the compact line nothing is asked or advised', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 30, 0.9)
  // Jev's "finished" is only asked once the context is big enough to matter.
  expect(host.fetches).toEqual([])
  expect(adviceLogOf(host)).toEqual([])
})

test('Accept compacts with the focus; the record says accepted', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.9)
  const band = await mountBand($)
  await band.press({ key: 'accept' })
  await band.unmount()
  expect(host.compactInputs.length).toBe(1)
  // A plugin's own compaction carries no trigger until the engine stamps one.
  expect(host.compactInputs[0]!.trigger ?? 'plugin').toBe('plugin')
  expect(host.compactInputs[0]!.instructions).toMatch(/\S/)
  expect(adviceLogOf(host)[0]!.outcome).toBe('accepted')
  expect(stateOf(host, 'compactions')).toBe(1)
  const after = await mountBand($)
  expect(await after.find({ type: 'Text', text: /compact now/ })).toBeUndefined()
  await after.unmount()
})

test('Dismiss records dismissed and takes the line down', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.9)
  const band = await mountBand($)
  await band.press({ key: 'dismiss' })
  await band.unmount()
  expect(adviceLogOf(host)[0]!.outcome).toBe('dismissed')
  expect(host.compactInputs).toEqual([])
  const after = await mountBand($)
  expect(await after.find({ type: 'Text', text: /compact now/ })).toBeUndefined()
  await after.unmount()
})

test('at 75% the focus is precomputed and offered as a /q-advisor compact suggestion', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 75, 0.9)
  expect(stateOf<{ source: string }>(host, 'focus')?.source).toBe('jev')
  expect(host.completes.length).toBe(1)
  expect(host.suggested).toEqual(['/q-advisor compact'])
})

test('the focus falls back to the rules and a deterministic text without Jev and Haiku', { options: { mode: 'on' } }, async ($, on) => {
  const host = fakeHost(on)
  host.complete = undefined
  await start($)
  host.usage.percent = 75
  await completeMain($)
  await settle(host)
  expect(host.fetches).toEqual([])
  expect(stateOf<{ source: string; text: string }>(host, 'focus')?.source).toBe('fallback')
  expect(stateOf<{ text: string }>(host, 'focus')?.text).toMatch(/\S/)
})

test('a prompt that follows the turn supersedes its pending judgement', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.percent = 65
  host.jev = { status: 200, finished: 0.9 }
  let open = () => {}
  host.jevGate = new Promise<void>(resolve => {
    open = resolve
  })
  await completeMain($)
  await host.clock.settle()
  await userPrompt($, 'Now add the same pagination to the customers list, please.')
  open()
  await settle(host)
  expect(adviceLogOf(host)).toEqual([])
})

test('Accept on a model suggestion runs /model; a refusal falls back to a suggestion and a toast', ON, async ($, on) => {
  const host = fakeHost(on)
  host.model = 'claude-haiku-5-5'
  host.usage = { percent: 20, tokens: 10_000, five: undefined, usd: 1 }
  host.jev = { status: 200, relation: { label: 'continuation', p: 0.95 }, size: { label: 'deep', p: 0.9 } }
  await start($)
  await userPrompt($, 'Redesign the whole billing architecture and plan the migration.')
  await settle(host)
  await completeMain($)
  await settle(host)
  expect(adviceLogOf(host)).toEqual([expect.objectContaining({ kind: 'model-fit' })])
  host.commandError = 'not now'
  const band = await mountBand($)
  expect(await band.find({ type: 'Text', text: /\/model opus/ })).toBeDefined()
  await band.press({ key: 'accept' })
  await band.unmount()
  expect(host.commands).toEqual([{ command: 'model', args: 'opus' }])
  expect(host.suggested).toEqual(['/model opus'])
  expect(host.toasts.at(-1)).toMatch(/could not run \/model opus/)
})

test('a fresh-session or new-task Accept writes the handoff note and clears', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  for (let i = 0; i < 3; i++) await $.session.compact({ trigger: 'manual', messages: [{ role: 'user', text: 'hello', toolUses: [] }] } as never)
  host.usage = { percent: 40, tokens: 80_000, five: undefined, usd: 1 }
  host.jev = { status: 200, finished: 0.95, keep: 0.9 }
  host.complete = 'GOAL: pagination. NEXT: customers list.'
  await completeMain($)
  await settle(host)
  expect(adviceLogOf(host)).toEqual([expect.objectContaining({ kind: 'fresh-session' })])
  const band = await mountBand($)
  await band.press({ key: 'accept' })
  await band.unmount()
  expect(host.commands).toEqual([{ command: 'clear', args: '' }])
  const r = await $.classic.SessionStart({ source: 'clear' } as never)
  expect(r.additionalContext?.join('\n')).toMatch(/GOAL: pagination/)
})

test('a subagent turn, an aborted turn and a refusal are not judged', ON, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  host.usage.percent = 65
  host.jev = { status: 200, finished: 0.9 }
  await $.turn.complete({ answer: 'x', durationMs: 1, isAborted: false, turnId: 's1', agentId: 'a1', reason: 'answer' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 's2', reason: 'aborted' } as never)
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 's3', reason: 'error' } as never)
  await settle(host)
  expect(host.fetches).toEqual([])
  expect(adviceLogOf(host)).toEqual([])
})

test('mode off does nothing at the turn end', { options: { mode: 'off', jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await endTurn($, host, 65, 0.9)
  expect(host.fetches).toEqual([])
  expect(adviceLogOf(host)).toEqual([])
})
