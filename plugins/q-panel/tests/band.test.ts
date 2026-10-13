import { expect, test } from 'claude-code/testing'

import { answers, band, busyTurn, fakeHost, run } from './host'

test('the row shows the git status and the turn counts under what the plugins beneath drew', async ($, on) => {
  fakeHost(on)
  answers(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  await run($, 'status')
  await busyTurn($)

  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await band($, surface)
    expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /feat\/git-badges/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /●2 staged/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: 'read 1 (1 partial)' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /changed 2/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: '+2' })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /created 1/ })).toBeDefined()
    expect(await ui.find({ type: 'Text', text: /bash 1 \(1 failed\)/ })).toBeDefined()
    expect(await ui.find({ type: 'Button', text: 'files' })).toBeDefined()
    expect(await ui.find({ key: 'q-panel-timeline' })).toBeDefined()
    await ui.unmount()
  }
})

test('outside a repository and before any work, the row is only what lies beneath', async ($, on) => {
  fakeHost(on, '', 128)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  expect((await run($, 'status')).text).toMatch(/Not inside a git repository/)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  expect(await ui.find({ key: 'q-panel-hide' })).toBeUndefined()
  await ui.unmount()
})

test('a quiet follow-up turn keeps the last busy turn on the row', async ($, on) => {
  fakeHost(on)
  answers(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  await busyTurn($)
  await $.turn.start({ text: '', turnId: 'quiet' })
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /changed 2/ })).toBeDefined()
  await ui.unmount()
})

test('[ hide ] hides the row for the session; /q-panel band on brings it back', async ($, on) => {
  const host = fakeHost(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  await run($, 'status')
  const ui = await band($)
  await ui.press({ key: 'q-panel-hide' })
  expect(await ui.find({ type: 'Text', text: /feat\/git-badges/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  // Hiding is not saved.
  expect(host.store.has('settings')).toBe(false)

  await run($, 'band on')
  expect(await ui.find({ type: 'Text', text: /feat\/git-badges/ })).toBeDefined()
  await ui.unmount()
})

test('band off hides the row, keeps what is beneath, and only settings reach the store', async ($, on) => {
  const host = fakeHost(on)
  answers(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  await run($, 'status')
  await busyTurn($)
  expect((await run($, 'band off')).text).toMatch(/off/)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: 'below' })).toBeDefined()
  expect(await ui.find({ type: 'Text', text: /changed/ })).toBeUndefined()
  expect(await ui.find({ type: 'Text', text: /feat\/git-badges/ })).toBeUndefined()
  await ui.unmount()

  expect([...host.store.keys()]).toEqual(['settings'])
  expect(host.store.get('settings')).toMatchObject({ band: false })
  expect(await run($, 'band maybe')).toMatchObject({ exitCode: 2 })
})

test('with the git segment off, git status is not read at the end of a turn', async ($, on) => {
  const host = fakeHost(on)
  answers(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  await run($, 'config git off')
  const before = host.gitCalls()
  await busyTurn($)
  await $.turn.complete({ turnId: 'busy', answer: '', durationMs: 10, isAborted: false, reason: 'answer' })
  expect(host.gitCalls()).toBe(before)

  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /changed 2/ })).toBeDefined()
  expect(await ui.find({ key: 'q-panel-timeline' })).toBeUndefined()
  await ui.unmount()
})

test('/q-panel clear empties the files list and the turn counts on the row', async ($, on) => {
  fakeHost(on, '', 128)
  answers(on)
  on('ui.render', () => ({ type: 'Text', props: {}, children: ['below'] }))
  await busyTurn($)
  expect((await run($, 'clear')).text).toMatch(/cleared/)
  const ui = await band($)
  expect(await ui.find({ type: 'Text', text: /changed/ })).toBeUndefined()
  await ui.unmount()
})
