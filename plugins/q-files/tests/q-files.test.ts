import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/** An in-memory $.store, a clock, a session root, and the engine bits the hooks call. */
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
  // What the plugins beneath draw in the band; q-files must keep it.
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  return store
}

/** Tool answers: a partial Read, an Edit of +2 −1, a new file, and a failed Bash call. */
const answers = (on: On) =>
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Read') return { result: { type: 'text', file: { filePath: input.file_path, content: '', startLine: 1, numLines: 120, totalLines: 480 } } }
    if (e.tool === 'Edit') return { result: { filePath: input.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } }
    if (e.tool === 'Write') return { result: { type: 'create', filePath: input.file_path, content: 'x', structuredPatch: [] } }
    return { result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }
  })

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-files', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

const band = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'q-files', surface, component: 'AbovePrompt', props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120 } as never })

const busyTurn = async ($: Engine) => {
  await $.turn.start({ text: 'fix it', turnId: 'busy' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'x', tool_use_id: 'w1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b1' })
}

test('the band counts what the turn read, changed and ran, under what other plugins drew', async ($, on) => {
  fakeHost(on)
  answers(on)
  await busyTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'read 1 (1 partial)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /changed 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /created 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /bash 1 \(1 failed\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'files' })).toBeDefined()
    await ui.unmount()
  }
})

test('with nothing to show, the band is only what the plugins beneath drew', async ($, on) => {
  fakeHost(on)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  expect(await ui.find({ type: 'Button', text: 'files' })).toBeUndefined()
  await ui.unmount()
})

test('a quiet follow-up turn keeps the last busy turn on the band', async ($, on) => {
  fakeHost(on)
  answers(on)
  await busyTurn($)
  await $.turn.start({ text: '', turnId: 'quiet' })
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /changed 2/ })).toBeDefined()
  await ui.unmount()
})

test('band off hides the row but keeps what is beneath, and only settings reach the store', async ($, on) => {
  const store = fakeHost(on)
  answers(on)
  await busyTurn($)
  expect((await run($, 'band off')).text).toMatch(/off/)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed/ })).toBeUndefined()
  await ui.unmount()

  expect([...store.keys()]).toEqual(['settings'])
  expect(store.get('settings')).toEqual({ band: false })
})

test('the pane groups changed and read-only files and notes partial reads', async ($, on) => {
  fakeHost(on)
  answers(on)
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/guide.md', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  expect((await run($, '')).text).toMatch(/Files pane opened/)

  const ui = await $.ui.mount({ plugin: 'q-files', surface: 'terminal', component: 'Pane', requestId: 'q-files', props: { title: 'Files', isFocused: true, bodyColumns: 100 } as never })
  expect(await ui.find({ type: 'Text', text: 'changed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'read only' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/app.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+2 −1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'docs/guide.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /25% read/ })).toBeDefined()
  await ui.unmount()

  expect((await run($, 'clear')).text).toMatch(/cleared/)
  const empty = await $.ui.mount({ plugin: 'q-files', surface: 'terminal', component: 'Pane', requestId: 'q-files', props: { title: 'Files', isFocused: true, bodyColumns: 100 } as never })
  expect(await empty.find({ type: 'Text', text: /No files/ })).toBeDefined()
  await empty.unmount()
})

test('unknown subcommands print the usage', async ($, on) => {
  fakeHost(on)
  const r = await run($, 'nope')
  expect(r.exitCode).toBe(2)
  expect(r.text).toMatch(/Usage: \/q-files/)
})
