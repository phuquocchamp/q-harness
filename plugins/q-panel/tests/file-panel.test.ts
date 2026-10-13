import { expect, test } from 'claude-code/testing'

import { fakeHost, run } from './host'

type Props = { tool?: string; input?: Record<string, unknown>; output?: unknown; isRunning?: boolean; isErrored?: boolean }

const PATCH = [{ oldStart: 1, oldLines: 3, newStart: 1, newLines: 6, lines: [' a', '-b', '+b1', '+b2', '+b3', '+b4', '+b5', ' c'] }]

const ROW = (id: string, p: Props = {}) =>
  ({
    plugin: 'q-panel',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool: p.tool ?? 'Edit',
      input: p.input ?? { file_path: '/repo/src/app.ts', old_string: 'b', new_string: 'b1' },
      isRunning: p.isRunning ?? false,
      isErrored: p.isErrored ?? false,
      isInterrupted: false,
      output: 'output' in p ? p.output : { filePath: '/repo/src/app.ts', structuredPatch: PATCH },
    },
  }) as const

test('an Edit is a bordered panel with a changed-lines preview that expands to the full diff', async ($, on) => {
  fakeHost(on)
  const ui = await $.ui.mount(ROW('e1'))
  expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { borderStyle: 'round', borderColor: 'green' } })
  expect(await ui.find({ type: 'Text', text: /src\/app\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /done · \+5 −1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '- b' })).toMatchObject({ props: { color: 'red' } })
  expect(await ui.find({ type: 'Text', text: '+ b3' })).toMatchObject({ props: { color: 'green' } })
  expect(await ui.find({ type: 'Text', text: '+ b4' })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /2 more changed lines/ })).toBeDefined()

  await ui.press({ key: 'q-panel-e1' })
  expect(await ui.find({ type: 'Text', text: '+ b5' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /@@ -1,3 \+1,6 @@/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  c' })).toBeDefined()
  await ui.unmount()
})

test('a new file, a running write and a failed edit', async ($, on) => {
  fakeHost(on)
  const created = await $.ui.mount(ROW('w1', { tool: 'Write', input: { file_path: '/repo/new.ts', content: 'x\ny' }, output: { type: 'create', content: 'x\ny', structuredPatch: [] } }))
  expect(await created.find({ type: 'Text', text: /Create/ })).toBeDefined()
  expect(await created.find({ type: 'Text', text: /created · \+2 −0/ })).toBeDefined()
  await created.unmount()

  const running = await $.ui.mount(ROW('w2', { tool: 'Write', input: { file_path: '/repo/new.ts', content: 'x' }, isRunning: true, output: undefined }))
  expect(await running.drawn()).toMatchObject({ props: { borderColor: 'yellow' } })
  expect(await running.find({ type: 'Text', text: /writing…/ })).toBeDefined()
  await running.unmount()

  const failed = await $.ui.mount(ROW('e2', { isErrored: true, output: 'String to replace not found in file.' }))
  expect(await failed.drawn()).toMatchObject({ props: { borderColor: 'red' } })
  expect(await failed.find({ type: 'Text', text: /not found in file/ })).toMatchObject({ props: { color: 'red' } })
  await failed.unmount()
})

test('filePanels off leaves file rows to the engine', async ($, on) => {
  fakeHost(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  await run($, 'config filePanels off')
  const ui = await $.ui.mount(ROW('e3'))
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})
