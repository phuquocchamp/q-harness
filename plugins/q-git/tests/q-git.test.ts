import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

import { parseStatus, statusLine, toEvents, touchesGit } from '../hooks/lib'

const PORCELAIN = [
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

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-git', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

/** Answers `git status` with `stdout`, and keeps $.store in memory. */
const fakeHost = (on: On, stdout = PORCELAIN, exitCode = 0) => {
  const store = new Map<string, unknown>()
  let calls = 0
  on('process.run', () => {
    calls += 1
    return { value: { exitCode, stdout, stderr: exitCode ? 'fatal: not a git repository' : '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('store.get', (_$, e) => ({ value: store.get(e.key) }))
  on('store.set', (_$, e) => {
    store.set(e.key, e.value)
    return { value: undefined }
  })
  on('clock.now', () => ({ value: Date.UTC(2026, 9, 13, 9, 30) }))
  return { store, calls: () => calls }
}

test('parseStatus reads branch, tracking, changes and stash', () => {
  expect(parseStatus(PORCELAIN)).toEqual({
    branch: 'feat/git-badges',
    detached: false,
    upstream: 'origin/feat/git-badges',
    ahead: 2,
    behind: 1,
    staged: 2,
    modified: 2,
    untracked: 2,
    conflicts: 1,
    stash: 1,
  })
  const detached = parseStatus('# branch.oid 1234567890\n# branch.head (detached)\n')
  expect(detached).toMatchObject({ detached: true, branch: '1234567' })
  expect(statusLine(detached)).toMatch(/✓ clean/)
})

test('git operations become timeline events', () => {
  const events = toEvents(
    { commit: { sha: 'abcdef123456', kind: 'committed', branch: 'main' }, push: { branch: 'main' }, pr: { number: 7, url: 'https://x/pr/7', action: 'created' } },
    'git commit && git push && gh pr create',
    1,
  )
  expect(events.map(e => e.label)).toEqual(['committed abcdef1 on main', 'pushed main', 'PR #7 created'])
  expect(events[2]).toMatchObject({ kind: 'pr', url: 'https://x/pr/7' })
  expect(touchesGit('cd x && git status')).toBe(true)
  expect(touchesGit('ls digit')).toBe(false)
})

test('/q-git status prints the summary, and says so outside a repository', async ($, on) => {
  fakeHost(on)
  const r = await run($, 'status')
  expect(r.text).toMatch(/⎇ feat\/git-badges/)
  expect(r.text).toMatch(/↑2 ↓1/)
  expect(r.text).toMatch(/✖1 conflicts/)
})

test('outside a repository the band draws nothing of its own', async ($, on) => {
  fakeHost(on, '', 128)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  expect((await run($, 'status')).text).toMatch(/Not inside a git repository/)
  const ui = await $.ui.mount({
    plugin: 'q-git',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  } as Parameters<Engine['ui']['mount']>[0])
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('the band shows the status and hides on press', async ($, on) => {
  fakeHost(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['engine band'] }))
  await run($, 'refresh')
  const ui = await $.ui.mount({
    plugin: 'q-git',
    surface: 'terminal',
    component: 'AbovePrompt',
    props: { hasSurvey: false, isWorking: false, maxRows: 10, bodyColumns: 100, scroll: { offset: 0, bodyRows: 9 }, view: {} },
  } as Parameters<Engine['ui']['mount']>[0])
  expect(await ui.find({ type: 'Text', text: /feat\/git-badges/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /●2 staged/ })).toBeDefined()
  await ui.press({ key: 'q-git-hide' })
  expect(await ui.find({ type: 'Text', text: 'engine band' })).toBeDefined()
  await ui.unmount()
})

test('a Bash call with git activity lands in the timeline and refreshes the status', async ($, on) => {
  const host = fakeHost(on)
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abcdef123456', kind: 'committed', branch: 'main' } } },
  }))
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x', tool_use_id: 'c1' })
  expect(host.calls()).toBeGreaterThan(0)

  const pane = await $.ui.mount({
    plugin: 'q-git',
    surface: 'terminal',
    component: 'Pane',
    requestId: 'q-git-timeline',
    props: { title: 'Git timeline', isFocused: false, bodyColumns: 80, placement: 'dock' },
  } as Parameters<Engine['ui']['mount']>[0])
  expect(await pane.find({ type: 'Button', text: /committed abcdef1 on main/ })).toBeDefined()
  await pane.unmount()
})

test('/q-git band off is remembered', async ($, on) => {
  const host = fakeHost(on)
  await run($, 'band off')
  expect(host.store.get('band')).toBe(false)
  expect(await run($, 'band maybe')).toMatchObject({ exitCode: 2 })
})
