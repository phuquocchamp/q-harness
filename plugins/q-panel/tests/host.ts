// Test helpers shared by the q-panel tests: a fake host and short ways to drive the plugin.

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

export const PORCELAIN = [
  '# branch.oid 9f3e21a4b5c6d7e8',
  '# branch.head feat/git-badges',
  '# branch.upstream origin/feat/git-badges',
  '# branch.ab +2 -1',
  '# stash 1',
  '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
  '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
  '1 MM N... 100644 100644 100644 aaa bbb src/c.ts',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/d.ts',
  '? notes.md',
  '? tmp.txt',
].join('\n')

/**
 * An in-memory $.store, a clock that moves 250 ms per read, a session root of /repo, and a
 * `git status` that answers `stdout` (exit code `exitCode`). `gitCalls()` counts the status reads.
 */
export const fakeHost = (on: On, stdout = PORCELAIN, exitCode = 0) => {
  const store = new Map<string, unknown>()
  let now = 1_000
  let gitCalls = 0
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('store.delete', (_$, e) => {
    store.delete(e.key)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: (now += 250) }))
  on('session.root', () => ({ value: '/repo' }))
  on('process.run', () => {
    gitCalls += 1
    return { value: { exitCode, stdout, stderr: exitCode ? 'fatal: not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  on('turn.start', (_$, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('ui.open', () => ({ value: { isPlaced: true } }))
  return { store, gitCalls: () => gitCalls }
}

/** Tool answers: a partial Read, an Edit of +2 −1, a new file, and a failed Bash call. */
export const answers = (on: On) =>
  on('tool.call', (_$, e) => {
    const input = e as unknown as Record<string, unknown>
    if (e.tool === 'Read') return { result: { type: 'text', file: { filePath: input.file_path, content: '', startLine: 1, numLines: 120, totalLines: 480 } } }
    if (e.tool === 'Edit') return { result: { filePath: input.file_path, structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 2, lines: ['-a', '+b', '+c'] }] } }
    if (e.tool === 'Write') return { result: { type: 'create', filePath: input.file_path, content: 'x', structuredPatch: [] } }
    return { result: { stdout: '', stderr: 'boom', interrupted: false }, isError: true }
  })

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-panel', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

export const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])

const BAND_PROPS = { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 120, scroll: { offset: 0, bodyRows: 9 }, view: {} }

export const band = ($: Engine, surface: 'terminal' | 'desktop' = 'terminal') =>
  $.ui.mount({ plugin: 'q-panel', surface, component: 'AbovePrompt', props: BAND_PROPS } as Parameters<Engine['ui']['mount']>[0])

export const pane = ($: Engine, requestId: 'q-panel-files' | 'q-panel-timeline') =>
  $.ui.mount({
    plugin: 'q-panel',
    surface: 'terminal',
    component: 'Pane',
    requestId,
    props: { title: 'Pane', isFocused: true, bodyColumns: 100, placement: 'dock' },
  } as Parameters<Engine['ui']['mount']>[0])

/** A main-loop turn that reads, edits, creates a file and runs a failing Bash command. */
export const busyTurn = async ($: Engine) => {
  await $.turn.start({ text: 'fix it', turnId: 'busy' })
  await $.tool.call({ tool: 'Read', file_path: '/repo/src/app.ts', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  await $.tool.call({ tool: 'Write', file_path: '/repo/src/new.ts', content: 'x', tool_use_id: 'w1' })
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: 'b1' })
}
