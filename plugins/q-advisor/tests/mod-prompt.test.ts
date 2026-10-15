// prompt.submit: the person's prompt is never delayed; its judgement (Jev, Haiku, rules) runs in the background.

import { expect, test } from 'claude-code/testing'

import { JEV_URL } from '../hooks/lib/jev'
import type { PromptVerdict } from '../hooks/lib/contract'
import { LONG_PROMPT, decisionsOf, fakeHost, settle, start, stateOf, userPrompt } from './host'

type Verdict = PromptVerdict

test('prompt.submit resolves before Jev answers; the verdict is stored afterwards', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  host.jev = { status: 200, relation: { label: 'new-task', p: 0.95 }, size: { label: 'routine', p: 0.8 } }
  let open = () => {}
  host.jevGate = new Promise<void>(resolve => {
    open = resolve
  })
  await start($)
  const r = await userPrompt($, LONG_PROMPT)
  expect(r).toEqual(expect.objectContaining({ text: LONG_PROMPT }))
  // The prompt is through before any Jev call was even made, and nothing is stored yet.
  expect(host.fetches.length).toBe(0)
  expect(stateOf<unknown>(host, 'verdict') ?? null).toBeNull()
  await settle(host)
  // Started in the background, still waiting for the answer.
  expect(host.fetches.length).toBe(1)
  expect(host.fetches[0]!.url).toBe(JEV_URL)
  expect(host.fetches[0]!.headers.authorization).toBe('Bearer k')
  expect(stateOf<unknown>(host, 'verdict') ?? null).toBeNull()
  open()
  await settle(host)
  const v = stateOf<Verdict>(host, 'verdict')!
  expect(v.source).toBe('jev')
  expect(v.relation).toEqual({ label: 'new-task', p: expect.any(Number) })
  expect(v.size?.label).toBe('routine')
  expect(decisionsOf(host).map(d => d.question)).toEqual(['relation', 'size'])
})

test('a trivial prompt is not classified', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await userPrompt($, 'ok, continue')
  await userPrompt($, '/compact')
  await settle(host)
  expect(host.fetches).toEqual([])
  expect(host.classified).toEqual([])
  expect(stateOf<unknown>(host, 'verdict') ?? null).toBeNull()
})

test('mode off classifies nothing', { options: { jevApiKey: 'k', mode: 'off' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  expect(host.fetches).toEqual([])
  expect(host.classified).toEqual([])
})

test('a plugin-origin prompt is not the person\'s and is not classified', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await $.prompt.submit({ text: LONG_PROMPT, wait: false } as never)
  await settle(host)
  expect(host.fetches).toEqual([])
})

test('Jev fails: Haiku classify answers at p 0.5', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  host.jev = 'throw'
  host.classify = labels => (labels.includes('new-task') ? 'new-task' : 'routine')
  await start($)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  expect(host.fetches.length).toBe(1)
  expect(host.classified.length).toBe(2)
  const v = stateOf<Verdict>(host, 'verdict')!
  expect(v.source).toBe('haiku')
  expect(v.relation).toEqual({ label: 'new-task', p: 0.5 })
  expect(v.size).toEqual({ label: 'routine', p: 0.5 })
  expect(decisionsOf(host).every(d => d.source === 'haiku' && d.p === 0.5)).toBe(true)
})

test('an invalid Jev answer falls back too', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  host.jev = { status: 200 }
  host.classify = labels => labels[0]
  await start($)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  expect(stateOf<Verdict>(host, 'verdict')!.source).toBe('haiku')
})

test('no Jev key goes straight to Haiku', async ($, on) => {
  const host = fakeHost(on)
  host.classify = labels => labels[0]
  await start($)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  expect(host.fetches).toEqual([])
  expect(stateOf<Verdict>(host, 'verdict')!.source).toBe('haiku')
})

test('jev off in the settings skips Jev even with a key', { options: { jevApiKey: 'k' } }, async ($, on) => {
  const host = fakeHost(on)
  host.classify = labels => labels[0]
  await start($)
  await $.command.run({ command: 'q-advisor', args: 'config jev off' } as never)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  expect(host.fetches).toEqual([])
})

test('the key comes from TYPESAFE_API_KEY when the option is empty', async ($, on) => {
  const host = fakeHost(on)
  host.env.set('TYPESAFE_API_KEY', 'from-env')
  host.jev = { status: 200, relation: { label: 'continuation', p: 0.95 } }
  await start($)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  expect(host.fetches[0]!.headers.authorization).toBe('Bearer from-env')
})

test('Jev, Haiku and rules all silent: the verdict says rules and carries no labels', async ($, on) => {
  const host = fakeHost(on)
  await start($)
  await userPrompt($, LONG_PROMPT)
  await settle(host)
  const v = stateOf<Verdict>(host, 'verdict')!
  expect(v.source).toBe('rules')
  expect(v.relation).toBeUndefined()
  expect(v.size).toBeUndefined()
  expect(decisionsOf(host)).toEqual([])
})
