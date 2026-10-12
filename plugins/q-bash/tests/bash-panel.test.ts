import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-bash', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

const OUTPUT = Array.from({ length: 10 }, (_, i) => `line ${i + 1}`).join('\n')

type Props = {
  input?: Record<string, unknown>
  output?: unknown
  isRunning?: boolean
  isErrored?: boolean
  isInterrupted?: boolean
}

const ROW = (id: string, props: Props = {}) =>
  ({
    plugin: 'q-bash',
    component: 'ToolUse',
    requestId: id,
    props: {
      tool_use_id: id,
      tool: 'Bash',
      input: props.input ?? { command: 'seq 1 10', description: 'Print ten lines' },
      isRunning: props.isRunning ?? false,
      isErrored: props.isErrored ?? false,
      isInterrupted: props.isInterrupted ?? false,
      output: 'output' in props ? props.output : { stdout: OUTPUT, stderr: '', interrupted: false },
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
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'ToolUse',
    props: { tool_use_id: 'x', tool: 'Read', input: { file_path: '/a' }, isRunning: false, isErrored: false, isInterrupted: false },
  })
  expect(await ui.find({ type: 'Text', text: 'engine row' })).toBeDefined()
  await ui.unmount()
})

test('a failed Bash row draws red with the error text', async $ => {
  const ui = await $.ui.mount({
    ...ROW('f1', { input: { command: 'cat missing.yaml' }, isErrored: true, output: 'cat: missing.yaml: No such file or directory' }),
    surface: 'terminal',
  })
  expect(await ui.drawn()).toMatchObject({ props: { borderColor: 'red' } })
  expect(await ui.find({ type: 'Text', text: /failed/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /No such file/ })).toMatchObject({ props: { color: 'red' } })
  await ui.unmount()
})

test('running, interrupted and empty-output states', async $ => {
  const running = await $.ui.mount({ ...ROW('s1', { isRunning: true, output: undefined }), surface: 'terminal' })
  expect(await running.drawn()).toMatchObject({ props: { borderColor: 'yellow' } })
  expect(await running.find({ type: 'Text', text: /running…/ })).toBeDefined()
  expect(await running.find({ type: 'Text', text: /no output/ })).toBeUndefined()
  await running.unmount()

  const cut = await $.ui.mount({ ...ROW('s2', { output: { stdout: 'partial', stderr: '', interrupted: true } }), surface: 'terminal' })
  expect(await cut.find({ type: 'Text', text: /interrupted/ })).toBeDefined()
  await cut.unmount()

  const empty = await $.ui.mount({ ...ROW('s3', { output: { stdout: '', stderr: '', interrupted: false } }), surface: 'terminal' })
  expect(await empty.find({ type: 'Text', text: /\(no output\)/ })).toBeDefined()
  await empty.unmount()
})

test('background and timed-out commands are not shown as done', async $ => {
  const bg = await $.ui.mount({
    ...ROW('bg1', { output: { stdout: '', stderr: '', interrupted: false, backgroundTaskId: 'b7' } }),
    surface: 'terminal',
  })
  expect(await bg.drawn()).toMatchObject({ props: { borderColor: 'blue' } })
  expect(await bg.find({ type: 'Text', text: /background b7/ })).toBeDefined()
  expect(await bg.find({ type: 'Text', text: /no output/ })).toBeUndefined()
  await bg.unmount()

  const slow = await $.ui.mount({
    ...ROW('to1', { output: { stdout: '', stderr: '', interrupted: false, timedOutAfterMs: 120000 } }),
    surface: 'terminal',
  })
  expect(await slow.find({ type: 'Text', text: /timed out after 2m0s/ })).toBeDefined()
  await slow.unmount()
})

test('expand-all opens every panel, a panel can still close, and collapse-all resets choices', async $ => {
  const ui = await $.ui.mount({ ...ROW('e1'), surface: 'terminal' })
  await run($, 'expand-all')
  expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeDefined()

  // B1: under expand-all a panel's own collapse must take effect.
  await ui.press({ key: 'q-bash-toggle-e1' })
  expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeUndefined()

  // Open it again by hand, then collapse-all must close it.
  await ui.press({ key: 'q-bash-toggle-e1' })
  expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeDefined()
  await run($, 'collapse-all')
  expect(await ui.find({ type: 'Text', text: /^line 1$/ })).toBeUndefined()
  await ui.unmount()
})

test('/q-bash with an unknown argument answers with usage instead of collapsing', async $ => {
  const r = await run($, 'expnad-all')
  expect(r).toMatchObject({ exitCode: 2 })
  expect(r.text).toMatch(/Unknown subcommand "expnad-all"/)
  expect(r.text).toMatch(/Usage: \/q-bash/)
})

test('git activity, changed files and a sandbox override draw as badges', async $ => {
  const ui = await $.ui.mount({
    ...ROW('g1', {
      input: { command: 'git commit -am wip', dangerouslyDisableSandbox: true },
      output: {
        stdout: '[main 9f3e21a] wip',
        stderr: '',
        interrupted: false,
        gitOperation: { commit: { sha: '9f3e21a4b5c6', kind: 'committed', branch: 'main' }, pr: { number: 42, url: 'https://example.com/pr/42', action: 'created' } },
        bashEditDiff: {
          files: [{ filePath: 'a.ts', hunks: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-old', '+new', '+more'] }] }],
          moreFiles: 0,
        },
      },
    }),
    surface: 'terminal',
  })
  expect(await ui.find({ type: 'Text', text: /committed 9f3e21a on main/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /PR #42 created/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /1 files · \+2 −1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /unsandboxed/ })).toBeDefined()
  expect(await ui.find({ key: 'q-bash-pr-g1' })).toBeDefined()

  expect(await ui.find({ type: 'Code' })).toBeUndefined()
  await ui.press({ key: 'q-bash-diff-g1' })
  expect(await ui.find({ type: 'Code' })).toMatchObject({ props: { format: 'diff', path: 'a.ts' } })
  await ui.unmount()
})

test('test-runner output gets a summary chip and exit-code notes are shown', async $ => {
  const ui = await $.ui.mount({
    ...ROW('t1', {
      input: { command: 'npx vitest run' },
      isErrored: true,
      output: { stdout: ' Tests  2 failed | 128 passed (130)', stderr: '', interrupted: false, returnCodeInterpretation: 'Some tests failed' },
    }),
    surface: 'terminal',
  })
  expect(await ui.find({ type: 'Text', text: /✓ 128 {2}✗ 2/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /Some tests failed/ })).toBeDefined()
  await ui.unmount()
})

test('token-like strings are masked until revealed', async $ => {
  const token = 'ghp_' + 'a'.repeat(36)
  const ui = await $.ui.mount({ ...ROW('m1', { output: { stdout: `token=${token}`, stderr: '', interrupted: false } }), surface: 'terminal' })
  expect(await ui.find({ type: 'Text', text: new RegExp(token) })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /reveal 1 secret/ })).toBeDefined()
  await ui.press({ key: 'q-bash-reveal-m1' })
  expect(await ui.find({ type: 'Text', text: new RegExp(token) })).toBeDefined()
  await ui.unmount()
})

test('copied output keeps secrets masked until revealed', async ($, on) => {
  const copied: string[] = []
  on('ui.copy', (_$, e) => {
    copied.push(e.text)
    return { value: { isCopied: true } }
  })
  on('ui.toast', () => ({ value: undefined }))
  const token = 'ghp_' + 'b'.repeat(36)
  const ui = await $.ui.mount({ ...ROW('m2', { output: { stdout: `token=${token}`, stderr: '', interrupted: false } }), surface: 'terminal' })
  await ui.press({ key: 'q-bash-copy-out-m2' })
  await ui.press({ key: 'q-bash-copy-md-m2' })
  expect(copied.length).toBe(2)
  for (const text of copied) expect(text).not.toMatch(new RegExp(token))

  await ui.press({ key: 'q-bash-reveal-m2' })
  await ui.press({ key: 'q-bash-copy-out-m2' })
  expect(copied.at(-1)).toMatch(new RegExp(token))
  await ui.unmount()
})

test('long output, expanded, keeps the head and the tail', async $ => {
  const long = Array.from({ length: 1000 }, (_, i) => `row ${i + 1}`).join('\n')
  const ui = await $.ui.mount({ ...ROW('l1', { output: { stdout: long, stderr: '', interrupted: false } }), surface: 'terminal' })
  await ui.press({ key: 'q-bash-l1' })
  expect(await ui.find({ type: 'Text', text: /^row 1$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /^row 1000$/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /600 lines hidden/ })).toBeDefined()
  await ui.unmount()
})

test('the engine result block under a Bash row is blanked; images and other tools keep theirs', async ($, on) => {
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine result'] }))
  const mount = (id: string, tool: string, output: unknown) =>
    $.ui.mount({ plugin: 'q-bash', surface: 'terminal', component: 'ToolResult', props: { tool_use_id: id, tool, output, isErrored: false } })

  const bash = await mount('r1', 'Bash', { stdout: 'hi', stderr: '', interrupted: false })
  expect(await bash.find({ type: 'Text', text: 'engine result' })).toBeUndefined()
  await bash.unmount()

  const image = await mount('r2', 'Bash', { stdout: 'iVBOR…', stderr: '', interrupted: false, isImage: true })
  expect(await image.find({ type: 'Text', text: 'engine result' })).toBeDefined()
  await image.unmount()

  const read = await mount('r3', 'Read', {})
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
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'ToolGroup',
    props: {
      isActive: false,
      isExpanded: false,
      calls: [{ tool_use_id: 'g1', tool: 'Bash', input: { command: 'ls' }, isRunning: false, isErrored: false, isInterrupted: false }],
    },
  })
  expect(seen).toBe(true)
  await ui.unmount()
})
