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
  on('clock.now', () => ({ value: (now += 250) }))
  return store
}

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

test('the recorder times a Bash call and keeps it in the history', async ($, on) => {
  const store = fakeHost(on)
  on('tool.call', () => ({ result: { stdout: 'ok', stderr: '', interrupted: false } }))
  await $.tool.call({ tool: 'Bash', command: 'echo ok', tool_use_id: 'rec1' })

  expect(store.get('history')).toMatchObject([{ id: 'rec1', command: 'echo ok', status: 'done' }])

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

  expect((await run($, 'stats')).text).toMatch(/1 commands · 0 failed/)
})

test('/q-bash config validates, applies and persists a setting', async ($, on) => {
  const store = fakeHost(on)
  expect(await run($, 'config previewLines zero')).toMatchObject({ exitCode: 2 })

  await run($, 'config previewLines 8')
  expect(store.get('settings')).toMatchObject({ previewLines: 8 })
  expect((await run($, 'config')).text).toMatch(/previewLines\s+8/)
})

test('/q-bash guard off disables the guard; user rules are matched', async ($, on) => {
  fakeHost(on)
  on('tool.check', () => ({ decision: 'allow' }))
  await run($, `guard add 'kubectl\\s+delete' deletes cluster objects`)
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'kubectl delete ns prod' } })).toMatchObject({ decision: 'ask' })

  await run($, 'guard off')
  expect(await $.tool.check({ tool: 'Bash', input: { command: 'git reset --hard' } })).toMatchObject({ decision: 'allow' })
})

test('the history stores long commands truncated, so the store stays small', async ($, on) => {
  const store = fakeHost(on)
  on('tool.call', () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
  const huge = `cat <<'EOF'\n${'x'.repeat(50_000)}\nEOF`
  await $.tool.call({ tool: 'Bash', command: huge, tool_use_id: 'big1' })
  const [entry] = store.get('history') as { command: string; status: string }[]
  expect(entry?.status).toBe('done')
  expect(entry?.command.length).toBeLessThanOrEqual(501)
})
