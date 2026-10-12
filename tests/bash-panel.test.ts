import { expect, test } from 'claude-code/testing'

const OUTPUT = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')

const ROW = (id: string) =>
  ({
    plugin: 'q-mods',
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool: 'Bash',
      input: { command: 'seq 1 10', description: 'Print ten lines' },
      isRunning: false,
      isErrored: false,
      isInterrupted: false,
      output: { stdout: OUTPUT, stderr: '' },
    },
  }) as const

test('a Bash row is a bordered panel that previews the tail and expands on press', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const id = `toolu_${surface}`
    const ui = await $.ui.mount({ ...ROW(id), surface })

    expect(await ui.drawn()).toMatchObject({ type: 'Box', props: { borderStyle: 'round' } })
    expect(await ui.find({ type: 'Text', text: /seq 1 10/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /line 10/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeUndefined()
    expect(await ui.find({ type: 'Text', text: /6 earlier lines/ })).toBeDefined()

    await ui.press({ key: `q-bash-${id}` })
    expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeDefined()

    await ui.press({ key: `q-bash-toggle-${id}` })
    expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeUndefined()

    await ui.unmount()
  }
})

test('rows of other tools are left to the engine', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const ui = await $.ui.mount({
    plugin: 'q-mods',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'x', tool: 'Read', input: { file_path: '/a' }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})

test('a failed Bash row draws red with the error text', async $ => {
  const ui = await $.ui.mount({
    plugin: 'q-mods',
    surface: 'terminal',
    component: 'ToolUse',
    props: {
      tool_use_id: 'f1',
      tool: 'Bash',
      input: { command: 'cat missing.yaml' },
      isRunning: false,
      isErrored: true,
      isInterrupted: false,
      output: 'cat: missing.yaml: No such file or directory',
    },
  })
  expect(await ui.drawn()).toMatchObject({ props: { borderColor: 'red' } })
  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No such file/ })).toMatchObject({ props: { color: 'red' } })
  await ui.unmount()
})

test('the engine result block under a Bash row is blanked; other tools keep theirs', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine result'] }))
  const bash = await $.ui.mount({
    plugin: 'q-mods',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'r1', tool: 'Bash', output: { stdout: 'hi', stderr: '' }, isErrored: false },
  })
  expect(await bash.find({ type: 'Text', text: 'engine result' })).toBeUndefined()
  await bash.unmount()

  const read = await $.ui.mount({
    plugin: 'q-mods',
    surface: 'terminal',
    component: 'ToolResult',
    props: { tool_use_id: 'r2', tool: 'Read', output: {}, isErrored: false },
  })
  expect(await read.find({ type: 'Text', text: 'engine result' })).toBeDefined()
  await read.unmount()
})

test('a tool group holding a Bash call is unfolded', async ($, on) => {
  let seen: boolean | undefined
  on('ui.render', { component: 'ToolGroup' }, (_$, e) => {
    seen = e.props.isExpanded
    return { type: 'Text', props: {}, children: ['group'] }
  })
  const ui = await $.ui.mount({
    plugin: 'q-mods',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      isActive: false,
      isExpanded: false,
      calls: [
        { tool_use_id: 'g1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false },
      ],
    },
  })
  expect(seen).toBe(true)
  await ui.unmount()
})
