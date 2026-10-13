import { expect, test } from 'claude-code/testing'
import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-bash', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

/** An in-memory $.store and a clock that moves 250 ms per read. */
const fakeHost = (on: On) => {
  const store = new Map<string, unknown>()
  let now = 1_000
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
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return store
}

const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])

test('the guard asks before destructive commands and leaves others alone', async ($, on) => {
  on('tool.check', () => ({ decision: 'allow' }))

  for (const command of [
    'git push --force origin main',
    'git push -f',
    'git reset --hard HEAD~3',
    'git clean -fd',
    'rm -rf ~/',
    'psql -c "DROP TABLE users"',
  ]) {
    const r = await $.tool.check({ tool: 'Bash', input: { command } })
    expect(r).toMatchObject({ decision: 'ask' })
    expect(r.reason).toMatch(/q-bash guard/)
  }

  for (const command of ['git push --force-with-lease', 'git status', 'rm -rf ./dist', 'ls -la']) {
    expect(await $.tool.check({ tool: 'Bash', input: { command } })).toMatchObject({ decision: 'allow' })
  }
})

test('the guard never loosens a deny', async ($, on) => {
  on('tool.check', () => ({ decision: 'deny', reason: 'rule' }))
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'deny', reason: 'rule' })
})

test('the recorder times a Bash call and stores nothing', async ($, on) => {
  const store = fakeHost(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'echo ok', tool_use_id: 'rec1' })

  // No history: a Bash call leaves the store untouched.
  expect([...store.keys()]).toEqual([])

  // The panel of that call shows the recorded duration.
  const ui = await $.ui.mount({
    plugin: 'q-bash',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'rec1',
    props: { tool_use_id: 'rec1', tool: 'Bash', input: { command: 'echo ok' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'ok', stderr: '', interrupted: false } },
  })
  expect(await ui.find({ type: 'Text', text: /· \d+ms/ })).toBeDefined()
  await ui.unmount()
})

test('/q-bash config validates, applies and persists a setting', async ($, on) => {
  const store = fakeHost(on)
  expect(await run($, 'config previewLines zero')).toMatchObject({ exitCode: 2 })

  await run($, 'config previewLines 8')
  expect(store.get('settings')).toMatchObject({ previewLines: 8 })
  expect((await run($, 'config')).text).toMatch(/previewLines\s+8/)
})

test('/q-bash config guard off disables the guard', async ($, on) => {
  fakeHost(on)
  on('tool.check', () => ({ decision: 'allow' }))
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'ask' })
  await run($, 'config guard off')
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'allow' })
})

test('session start deletes the history older versions stored and keeps only current settings', async ($, on) => {
  const store = fakeHost(on)
  store.set('history', [{ id: 'old', command: 'curl -H "Authorization: Bearer secret"', status: 'done', at: 1 }])
  store.set('settings', { previewLines: 6, guard: false, maskSecrets: true, guardRules: [{ pattern: 'x', why: 'y' }] })
  await start($)
  expect(store.has('history')).toBe(false)
  expect((await run($, 'config')).text).toMatch(/previewLines\s+6[\s\S]*guard\s+off[\s\S]*unfoldGroups\s+on/)
  expect((await run($, 'config')).text).not.toMatch(/maskSecrets|guardRules/)
})

test('/q-bash help and unknown subcommands', async ($, on) => {
  fakeHost(on)
  expect((await run($, 'help')).text).toMatch(/config <key> <value>/)
  expect(await run($, 'history')).toMatchObject({ exitCode: 2 })
  expect((await run($, 'config reset')).text).toMatch(/defaults/)
})
