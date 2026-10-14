import { expect, test } from 'claude-code/testing'

import { fakeHost, run } from './host'

type Node = { type?: string; props?: Record<string, unknown>; children?: unknown[] }

/** Every element of `type` in a drawn tree, depth first. */
const all = (tree: unknown, type: string): Node[] => {
  if (!tree || typeof tree !== 'object') return []
  if (Array.isArray(tree)) return tree.flatMap(t => all(t, type))
  const n = tree as Node
  return [...(n.type === type ? [n] : []), ...all(n.children, type)]
}
const sources = async (ui: { drawn: () => Promise<unknown> }, type: 'Code' | 'Markdown') =>
  all(await ui.drawn(), type).map(n => String(n.props?.[type === 'Code' ? 'source' : 'text']))

const REPLY = (requestId: string, text: string) =>
  ({ plugin: 'q-panel', component: 'AssistantMessage', requestId, props: { text, isFirstOfReply: true } }) as const

const LONG = Array.from({ length: 60 }, (_, i) => `line${i + 1}()`).join('\n')

test('a fenced block is drawn framed and highlighted, prose stays markdown', async ($, on) => {
  fakeHost(on)
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ ...REPLY(`m-${surface}`, 'Run this:\n\n```ts\nconst a = 1\n```\n\nDone.'), surface })
    expect(await sources(ui, 'Markdown')).toEqual(['Run this:\n', '\nDone.'])
    const [code] = all(await ui.drawn(), 'Code')
    expect(code?.props).toMatchObject({ source: 'const a = 1', language: 'ts' })
    expect(all(await ui.drawn(), 'Box').some(b => b.props?.borderStyle === 'round')).toBe(true)
    expect(await ui.find({ type: 'Text', text: /▾ ts/ })).toBeDefined()
    // No copy or fold buttons: the header is the only one.
    expect((await ui.findAll({ type: 'Button' })).map(b => String(b.props.key))).toEqual([`q-panel-code-m-${surface}-1`])
    // The terminal gets the reply's bullet back; other surfaces draw none.
    expect(await ui.find({ type: 'Text', text: '⏺' })).toEqual(surface === 'terminal' ? expect.anything() : undefined)
    await ui.unmount()
  }
})

test('a reply without a fence is left to the engine', async ($, on) => {
  fakeHost(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const ui = await $.ui.mount({ ...REPLY('plain', 'Just **text** and `inline`.'), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: 'engine' })).toBeDefined()
  await ui.unmount()
})

test('a short block collapses and expands on press', async ($, on) => {
  fakeHost(on)
  const ui = await $.ui.mount({ ...REPLY('short', '```py\nprint(1)\n```'), surface: 'terminal' })
  expect(await sources(ui, 'Code')).toEqual(['print(1)'])
  await ui.press({ key: 'q-panel-code-short-0' })
  expect(await sources(ui, 'Code')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /▸ py/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 line/ })).toBeDefined()
  await ui.press({ key: 'q-panel-code-short-0' })
  expect(await sources(ui, 'Code')).toEqual(['print(1)'])
  await ui.unmount()
})

test('a long block starts collapsed and shows all of it on press', async ($, on) => {
  fakeHost(on)
  const ui = await $.ui.mount({ ...REPLY('long', '```js\n' + LONG + '\n```'), surface: 'terminal' })
  expect(await sources(ui, 'Code')).toEqual([])
  expect(await ui.find({ type: 'Text', text: /60 lines/ })).toBeDefined()
  await ui.press({ key: 'q-panel-code-long-0' })
  expect(await sources(ui, 'Code')).toEqual([LONG])
  await ui.unmount()
})

test('a block still streaming stays open; codeBlocks off leaves replies alone', async ($, on) => {
  fakeHost(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine'] }))
  const streaming = await $.ui.mount({ ...REPLY('s', '```py\nprint(1)'), surface: 'terminal' })
  expect(await sources(streaming, 'Code')).toEqual(['print(1)'])
  await streaming.unmount()

  await run($, 'config codeBlocks off')
  const off = await $.ui.mount({ ...REPLY('o', '```py\nprint(1)\n```'), surface: 'terminal' })
  expect(await off.find({ type: 'Text', text: 'engine' })).toBeDefined()
  expect(await off.find({ type: 'Code' })).toBeUndefined()
  await off.unmount()
})
