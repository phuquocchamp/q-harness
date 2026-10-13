import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/** An in-memory $.store, a clock and a session root. */
const fakeHost = (on: On) => {
  const store = new Map<string, unknown>()
  let now = 1_000
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: (now += 250) }))
  on('session.root', () => ({ value: '/repo' }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return store
}

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-bash', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

const answers = (on: On) =>
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Read') {
      return { result: { type: 'text', file: { filePath: input.file_path, content: '', startLine: 1, numLines: 120, totalLines: 480 } } }
    }
    if (e.tool === 'Edit') {
      return { result: { filePath: input.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } }
    }
    if (e.tool === 'Write') return { result: { type: 'create', filePath: input.file_path, content: 'x', structuredPatch: [] } }
    return { result: { stdout: 'ok', stderr: '', interrupted: false } }
  })

test('the turn band counts what this turn read and changed', async ($, on) => {
  fakeHost(on)
  answers(on)
  await $.turn.start({ text: 'fix it', turnId: 'turn-1' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'x', tool_use_id: 'w1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b1' })

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: 'q-bash', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: true, maxRows: 10, bodyColumns: 120 } as never })
    expect(await ui.find({ type: 'Text', text: 'this turn' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'read 1 file (1 partial)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'changed 2 files' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'created 1' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'bash 1' })).toBeDefined()
    await ui.unmount()
  }
})

test('the files pane lists each file with its counts and filters to changed files', async ($, on) => {
  fakeHost(on)
  answers(on)
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/guide.md', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  expect((await run($, 'files')).text).toMatch(/Files pane opened/)

  const ui = await $.ui.mount({
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'q-bash-files',
    props: { title: 'Files', isFocused: true, bodyColumns: 120 } as never,
  })
  expect(await ui.find({ type: 'Text', text: /docs\/guide\.md/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /src\/app\.ts/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '25%' })).toBeDefined()

  await ui.press({ key: 'ff-edited' })
  expect(await ui.find({ type: 'Text', text: /docs\/guide\.md/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /src\/app\.ts/ })).toBeDefined()
  await ui.unmount()
})

test('the features pane turns the band off and saves it', async ($, on) => {
  const store = fakeHost(on)
  const ui = await $.ui.mount({
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'q-bash-features',
    props: { title: 'q-bash features', isFocused: true, bodyColumns: 120 } as never,
  })
  expect(await ui.find({ type: 'Button', text: '● Turn band' })).toBeDefined()
  await ui.press({ key: 'feat-btn-band' })
  expect(await ui.find({ type: 'Button', text: '○ Turn band' })).toBeDefined()
  expect(store.get('settings')).toMatchObject({ band: false })
  await ui.unmount()
})

test('a finished Agent call draws as a card with its tool stats', async ($, on) => {
  fakeHost(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine row'] }))
  const output = {
    status: 'completed',
    agentId: 'a1',
    agentType: 'Explore',
    resolvedModel: 'claude-haiku-5-5',
    content: [{ type: 'text', text: 'Found 3 hook events.' }],
    totalToolUseCount: 24,
    totalDurationMs: 102_000,
    totalTokens: 38_200,
    toolStats: { readCount: 14, searchCount: 6, bashCount: 3, editFileCount: 2, linesAdded: 40, linesRemoved: 8, otherToolCount: 0 },
    usage: {},
    prompt: 'Find the hook events',
  }
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({
      plugin: 'q-bash',
      surface,
      component: 'ToolUse',
      requestId: `ag-${surface}`,
      props: { tool_use_id: `ag-${surface}`, tool: 'Agent', input: { description: 'Find hook events', prompt: 'x' }, isRunning: false, isErrored: false, isInterrupted: false, output },
    })
    expect(await ui.find({ type: 'Text', text: 'Agent · Explore' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /38\.2k tokens · 24 tool calls/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '[2 files +40 −8]' })).toBeDefined()
    await ui.press({ key: `q-agent-toggle-ag-${surface}` })
    expect(await ui.find({ type: 'Markdown', text: 'Found 3 hook events.' })).toBeDefined()
    await ui.unmount()
  }

  // While it runs, the engine's own row (with its live progress) is kept.
  const running = await $.ui.mount({
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'ag2',
    props: { tool_use_id: 'ag2', tool: 'Agent', input: { description: 'x', prompt: 'x' }, isRunning: true, isErrored: false, isInterrupted: false },
  })
  expect(await running.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await running.unmount()
})

test('TodoWrite draws a progress bar and marks what changed', async ($, on) => {
  fakeHost(on)
  const oldTodos = [
    { content: 'Read types', status: 'completed', activeForm: 'Reading types' },
    { content: 'Write code', status: 'in_progress', activeForm: 'Writing code' },
  ]
  const newTodos = [
    { content: 'Read types', status: 'completed', activeForm: 'Reading types' },
    { content: 'Write code', status: 'completed', activeForm: 'Writing code' },
    { content: 'Run tests', status: 'in_progress', activeForm: 'Running tests' },
    { content: 'Report', status: 'pending', activeForm: 'Reporting' },
  ]
  const ui = await $.ui.mount({
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'td1',
    props: { tool_use_id: 'td1', tool: 'TodoWrite', input: { todos: newTodos }, isRunning: false, isErrored: false, isInterrupted: false, output: { oldTodos, newTodos } },
  })
  expect(await ui.find({ type: 'Text', text: '2/4' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '50%' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /▸ Running tests/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: '  ← done' })).toBeDefined()
  await ui.unmount()
})

test('the line under a Read says which lines were read', async ($, on) => {
  fakeHost(on)
  const ui = await $.ui.mount({
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'ToolResult',
    requestId: 'rd1',
    props: {
      tool_use_id: 'rd1',
      tool: 'Read',
      isErrored: false,
      output: { type: 'text', file: { filePath: '/repo/big.ts', content: '', startLine: 1, numLines: 120, totalLines: 480 } },
    },
  })
  expect(await ui.find({ type: 'Text', text: 'lines 1–120 of 480 (25%)' })).toBeDefined()
  await ui.unmount()
})

test('a follow-up turn with no tool calls keeps the last busy turn on the band', async ($, on) => {
  fakeHost(on)
  answers(on)
  await $.turn.start({ text: 'edit', turnId: 'busy' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/a.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  await $.turn.start({ text: '', turnId: 'quiet' })

  const ui = await $.ui.mount({ plugin: 'q-bash', surface: 'terminal', component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })
  expect(await ui.find({ type: 'Text', text: 'changed 1 file' })).toBeDefined()
  await ui.unmount()
})
