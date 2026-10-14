import { expect, test } from 'claude-code/testing'

import { fakeHost, run, start } from './host'

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
  host.store.set('settings', { previewLines: 6, filePanels: false, guard: true })
  await start($)
  const shown = (await run($, 'config')).text
  expect(shown).toMatch(/filePanels\s+off[\s\S]*previewLines\s+6/)
  expect(shown).not.toMatch(/guard/)
})

test('/q-panel help, and the removed subcommands are unknown', async ($, on) => {
  fakeHost(on)
  expect((await run($, 'help')).text).toMatch(/config <key> <value>/)
  for (const sub of ['files', 'timeline', 'status', 'clear', 'guard on', 'band off']) {
    const r = await run($, sub)
    expect(r).toMatchObject({ exitCode: 2 })
    expect(r.text).toMatch(/Usage: \/q-panel/)
  }
})
