// The turn.complete fallback: when classic.Stop never reached the mod (managed settings can bypass
// it), the main turn's end runs the gate detached and, on red, follows up by the `followUp` option.

import { expect, test } from 'claude-code/testing'

import { APP_BUG, DRIFT, ROOT, calls, completeMain, edit, fakeHost, flow, mainTurn, say, seedProject, settle, start, userPrompt } from './host'

const CHECKOUT = `${ROOT}/src/checkout.html`

test('turn.complete without a prior Stop runs the runner and submits the block as a follow-up', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  await edit($, CHECKOUT)
  await mainTurn($, 't1', 'Changed the label.')
  await settle()
  expect(calls(host.runs, 'run').length).toBe(1)
  expect(host.submitted.length).toBe(1)
  expect(host.submitted[0]!.text).toMatch(/^q-pilot: 1 flow needs attention/)
  expect(host.submitted[0]!.text).toContain('found "€14.00"')
  expect(host.submitted[0]!.origin).toEqual(expect.objectContaining({ kind: 'plugin' }))
})

test('a success claim in the answer leads the follow-up with the contradiction', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  await edit($, CHECKOUT)
  await mainTurn($, 't1', 'Done. Everything works.')
  await settle()
  expect(host.submitted[0]!.text).toMatch(/^You said the flows work, but q-pilot ran 1 flow\(s\) \(checkout\) after your changes: ✗ 1 of 1 flows: checkout app-bug\./)
})

test('a green fallback run submits nothing', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  await edit($, CHECKOUT)
  await mainTurn($, 't1', 'Done.')
  await settle()
  expect(host.submitted).toEqual([])
})

test('a turn whose Stop reached the mod is not gated again at turn.complete', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([flow('checkout', 'pass')])]
  await start($)
  await edit($, CHECKOUT)
  await mainTurn($, 't1', 'Done.', { stop: true })
  await settle()
  expect(calls(host.runs, 'run').length).toBe(1)
  expect(host.submitted).toEqual([])
})

test('at most 2 follow-ups per user prompt; the person\'s own prompt resets the cap', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  for (const t of ['t1', 't2', 't3']) {
    await edit($, CHECKOUT)
    await completeMain($, t, 'Fixed it.')
    await settle()
  }
  expect(host.submitted.length).toBe(2)
  expect(host.toasts.at(-1)).toMatch(/still red after 2 follow-ups/)
  // The third round gave up on its edits and left a note for the next prompt.
  expect(host.appended.at(-1)).toMatch(/^\[q-pilot\] .*q-pilot: 1 flow needs attention/s)
  await userPrompt($, 'try again')
  await edit($, CHECKOUT)
  await completeMain($, 't4', 'Fixed it.')
  await settle()
  expect(host.submitted.filter(s => !(s.origin as { kind: string }).kind.match(/composer/)).length).toBe(3)
})

test('followUp suggest proposes in the prompt box and submits nothing', { options: { followUp: 'suggest' } }, async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  await start($)
  await edit($, CHECKOUT)
  await completeMain($, 't1', 'Done.')
  await settle()
  expect(host.submitted).toEqual([])
  expect(host.suggested).toEqual(['Fix the failing flow(s): checkout (app-bug)'])
})

test('followUp off only notes it; a refused submit falls back to a suggestion', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([APP_BUG])]
  host.submitDrop = 'busy'
  await start($)
  await edit($, CHECKOUT)
  await completeMain($, 't1', 'Done.')
  await settle()
  expect(host.toasts.some(t => /follow-up not submitted \(busy\)/.test(t))).toBe(true)
  expect(host.suggested.length).toBe(1)
  expect(host.appended.at(-1)).toMatch(/^\[q-pilot\]/)
})

test('shadow drift on the fallback path is reported once: no follow-up, one runner call, even over several turns', async ($, on) => {
  const host = fakeHost(on)
  seedProject(host.files)
  host.runner.run = [say([DRIFT])]
  await start($)
  await edit($, CHECKOUT)
  await completeMain($, 't1', 'Renamed the button.')
  await settle()
  expect(host.submitted).toEqual([])
  expect(host.toasts.at(-1)).toMatch(/^q-pilot: 1 flow needs attention.*Run \/q-pilot accept/)
  expect(host.appended.at(-1)).toContain('/q-pilot accept checkout')
  // A follow-up turn with no new edits does not run the gate again.
  await completeMain($, 't2', 'Nothing changed.')
  await settle()
  expect(calls(host.runs, 'run').length).toBe(1)
  expect(host.submitted).toEqual([])
})
