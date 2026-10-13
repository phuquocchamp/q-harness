import { expect, test } from 'claude-code/testing'

import { answers, fakeHost, pane, run } from './host'

test('the files pane groups changed and read-only files and notes partial reads', async ($, on) => {
  fakeHost(on)
  answers(on)
  await $.tool.call({ tool: 'Read', file_path: '/repo/docs/guide.md', tool_use_id: 'r1' })
  await $.tool.call({ tool: 'Edit', file_path: '/repo/src/app.ts', old_string: 'a', new_string: 'b\nc', tool_use_id: 'e1' })
  expect((await run($, 'files')).text).toMatch(/Files pane opened/)

  const ui = await pane($, 'q-panel-files')
  expect(await ui.find({ type: 'Text', text: 'changed' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'read only' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'src/app.ts' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /\+2 −1/ })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: 'docs/guide.md' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /25% read/ })).toBeDefined()
  await ui.unmount()

  await run($, 'clear')
  const empty = await pane($, 'q-panel-files')
  expect(await empty.find({ type: 'Text', text: /No files/ })).toBeDefined()
  await empty.unmount()
})

test('a Bash call with git activity lands in the timeline and refreshes the status', async ($, on) => {
  const host = fakeHost(on)
  on('tool.call', () => ({
    result: { stdout: '', stderr: '', interrupted: false, gitOperation: { commit: { sha: 'abcdef123456', kind: 'committed', branch: 'main' } } },
  }))
  await $.tool.call({ tool: 'Bash', command: 'git commit -m x', tool_use_id: 'c1' })
  expect(host.gitCalls()).toBeGreaterThan(0)

  expect((await run($, 'timeline')).text).toMatch(/timeline pane opened/)
  const ui = await pane($, 'q-panel-timeline')
  expect(await ui.find({ type: 'Button', text: /committed abcdef1 on main/ })).toBeDefined()
  await ui.unmount()
})

test('/q-panel status prints the summary', async ($, on) => {
  fakeHost(on)
  const r = await run($, 'status')
  expect(r.text).toMatch(/⎇ feat\/git-badges/)
  expect(r.text).toMatch(/↑2 ↓1/)
  expect(r.text).toMatch(/✖1 conflicts/)
})
