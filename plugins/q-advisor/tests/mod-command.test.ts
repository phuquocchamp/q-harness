// /q-advisor: report, mode, stats, config, mute, focus, reset, help.

import { expect, test } from 'claude-code/testing'

import { adviceLogOf, completeMain, fakeHost, run, settle, start } from './host'

test('/q-advisor prints the report', async ($, on) => {
  fakeHost(on)
  await start($)
  const r = await run($, '')
  expect(r.text).toMatch(/q-advisor/)
  expect(r.text).toMatch(/claude-opus-5-5/)
  expect(r.text).toMatch(/context/)
})

test('/q-advisor on, shadow and off set the mode and keep it', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'on')).text).toBe('q-advisor on.')
  expect((host.store.get('overrides') as { mode: string }).mode).toBe('on')
  expect((await run($, 'config')).text).toMatch(/mode on \(override\)/)
  await run($, 'off')
  expect((await run($, 'config')).text).toMatch(/mode off \(override\)/)
  await run($, 'shadow')
  expect((await run($, 'config')).text).toMatch(/mode shadow \(override\)/)
})

test('off stops the advice a turn end would give', { options: { mode: 'on', jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await run($, 'off')
  host.usage.percent = 65
  host.jev = { status: 200, finished: 0.9 }
  await completeMain($)
  await settle(host)
  expect(host.fetches).toEqual([])
  expect(adviceLogOf(host)).toEqual([])
})

test('stats counts what was judged and advised', { options: { mode: 'on', jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'stats')).exitCode).toBeUndefined()
  host.usage.percent = 65
  host.jev = { status: 200, finished: 0.9 }
  await completeMain($)
  await settle(host)
  const text = (await run($, 'stats')).text
  expect(text).toMatch(/finished/)
  expect(text).toMatch(/compact now/)
})

test('config shows the settings and config <key> <value> saves one', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'config')).text).toMatch(/compactAt 60 \(default\)/)
  expect((await run($, 'config compactAt 50')).text).toBe('compactAt set to 50')
  expect((host.store.get('overrides') as { compactAt: number }).compactAt).toBe(50)
  expect((await run($, 'config compactAt 50')).text).toBe('compactAt set to 50')
  expect((await run($, 'config')).text).toMatch(/compactAt 50 \(override\)/)
  expect((await run($, 'config compactAt banana')).text).toMatch(/must be a number/)
  expect((host.store.get('overrides') as { compactAt: number }).compactAt).toBe(50)
  expect((await run($, 'config nope 1')).text).toMatch(/Unknown key/)
})

test('a changed compactAt moves the advice line', { options: { mode: 'on', jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await run($, 'config compactAt 50')
  host.usage.percent = 55
  host.jev = { status: 200, finished: 0.9 }
  await completeMain($)
  await settle(host)
  expect(adviceLogOf(host)).toEqual([expect.objectContaining({ kind: 'compact-now' })])
})

test('mute silences a family and unmute brings it back', { options: { mode: 'on', jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'mute context')).text).toMatch(/compact-now, compact-urgent/)
  expect((host.store.get('overrides') as { muted: string[] }).muted).toEqual(['compact-now', 'compact-urgent'])
  host.usage.percent = 65
  host.jev = { status: 200, finished: 0.9 }
  await completeMain($)
  await settle(host)
  expect(adviceLogOf(host)).toEqual([])
  expect((await run($, 'unmute context')).text).toMatch(/Muted: none/)
  await completeMain($, 't2')
  await settle(host)
  expect(adviceLogOf(host)).toEqual([expect.objectContaining({ kind: 'compact-now' })])
  expect((await run($, 'mute nonsense')).exitCode).toBe(2)
  expect((await run($, 'mute')).exitCode).toBe(2)
})

test('focus says none yet, then shows the computed one', { options: { mode: 'on' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  expect((await run($, 'focus')).text).toMatch(/No focus yet/)
  host.usage.percent = 75
  await completeMain($)
  await settle(host)
  expect((await run($, 'focus')).text).toMatch(/Keep: the pagination plan/)
})

test('reset clears the overrides and the logs', { options: { mode: 'on', jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await run($, 'config compactAt 50')
  host.usage.percent = 65
  host.jev = { status: 200, finished: 0.9 }
  await completeMain($)
  await settle(host)
  expect(host.store.has('adviceLog')).toBe(true)
  expect((await run($, 'reset')).text).toMatch(/reset/)
  for (const key of ['overrides', 'decisions', 'adviceLog', 'handoff']) expect(host.store.has(key)).toBe(false)
  expect((await run($, 'config')).text).toMatch(/compactAt 60 \(default\)/)
})

test('help and an unknown subcommand print the usage', async ($, on) => {
  fakeHost(on)
  await start($)
  expect((await run($, 'help')).text).toMatch(/Usage: \/q-advisor/)
  const r = await run($, 'bogus')
  expect(r.exitCode).toBe(2)
  expect(r.text).toMatch(/Unknown subcommand "bogus"/)
})
