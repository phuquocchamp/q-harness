import { expect, test } from 'claude-code/testing'

import { fakeHost, run, start } from './host'

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
    expect(r.reason).toMatch(/q-panel guard/)
  }

  for (const command of ['git push --force-with-lease', 'git status', 'rm -rf ./dist', 'ls -la']) {
    expect(await $.tool.check({ tool: 'Bash', input: { command } })).toMatchObject({ decision: 'allow' })
  }
})

test('the guard never loosens a deny', async ($, on) => {
  on('tool.check', () => ({ decision: 'deny', reason: 'rule' }))
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'deny', reason: 'rule' })
})

test('/q-panel guard off disables the guard and is remembered', async ($, on) => {
  const host = fakeHost(on)
  on('tool.check', () => ({ decision: 'allow' }))
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'ask' })
  await run($, 'guard off')
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'allow' })
  expect(host.store.get('settings')).toMatchObject({ guard: false })
  expect(await run($, 'guard maybe')).toMatchObject({ exitCode: 2 })
})

test('a Bash call is timed for its panel and leaves the store untouched', async ($, on) => {
  const host = fakeHost(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'echo ok', tool_use_id: 'rec1' })

  expect([...host.store.keys()]).toEqual([])

  const ui = await $.ui.mount({
    plugin: 'q-panel',
    surface: 'terminal',
    component: 'ToolUse',
    requestId: 'rec1',
    props: { tool_use_id: 'rec1', tool: 'Bash', input: { command: 'echo ok' }, isRunning: false, isErrored: false, isInterrupted: false, output: { stdout: 'ok', stderr: '', interrupted: false } },
  })
  expect(await ui.find({ type: 'Text', text: /· \d+ms/ })).toBeDefined()
  await ui.unmount()
})

test('/q-panel config validates, applies and persists a setting', async ($, on) => {
  const host = fakeHost(on)
  expect(await run($, 'config previewLines zero')).toMatchObject({ exitCode: 2 })
  await run($, 'config previewLines 8')
  expect(host.store.get('settings')).toMatchObject({ previewLines: 8 })
  expect((await run($, 'config')).text).toMatch(/previewLines\s+8/)
  expect((await run($, 'config reset')).text).toMatch(/defaults/)
  expect((await run($, 'config')).text).toMatch(/previewLines\s+4/)
})

test('session start loads stored settings and ignores unknown keys', async ($, on) => {
  const host = fakeHost(on)
  host.store.set('settings', { previewLines: 6, guard: false, maskSecrets: true })
  await start($)
  const shown = (await run($, 'config')).text
  expect(shown).toMatch(/guard\s+off[\s\S]*previewLines\s+6/)
  expect(shown).not.toMatch(/maskSecrets/)
})

test('/q-panel help and unknown subcommands', async ($, on) => {
  fakeHost(on)
  expect((await run($, 'help')).text).toMatch(/config <key> <value>/)
  const r = await run($, 'history')
  expect(r).toMatchObject({ exitCode: 2 })
  expect(r.text).toMatch(/Usage: \/q-panel/)
})
