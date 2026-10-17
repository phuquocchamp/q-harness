import { expect, test } from 'claude-code/testing'

import { fakeHost, run, spawn, start } from './host'

const READY = { ready: true, port: 4321, file: '/tmp/q-graph-test/snapshot.json', token: 'tok' }

test('/q-graph web starts the viewer, prints its link and writes the graph for it', async ($, on) => {
  const writes: { path: string; text: string }[] = []
  const argvs: string[][] = []
  let release: () => void = () => {}
  const exited = new Promise<void>(resolve => (release = resolve))
  on('process.spawn', async function* (_$, e) {
    argvs.push([...e.argv])
    yield { stream: 'stdout' as const, text: `${JSON.stringify(READY)}\n` }
    await exited
    return { value: { code: 0, signal: null } }
  })
  on('fs.write', (_$, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('session.id', () => ({ value: 'sess-1' }))
  const host = fakeHost(on)
  await start($)
  await spawn($, 'Explore', 'scan')

  const r = await run($, 'web')
  expect(r.text).toBe('q-graph live viewer: http://127.0.0.1:4321/?k=tok')
  expect(argvs[0]?.[0]).toBe('node')
  expect(argvs[0]?.[1]).toMatch(/\/viewer\/server\.mjs$/)
  expect(writes[0]?.path).toBe(READY.file)
  const snap = JSON.parse(writes[0]!.text) as { session: string; graph: { order: string[] } }
  expect(snap.session).toBe('sess-1')
  expect(snap.graph.order).toEqual(['main', 'a1'])

  // A second call reuses the running viewer.
  expect((await run($, 'web')).text).toBe(r.text)
  expect(argvs).toHaveLength(1)

  // The pane links to it while it runs.
  const pane = { title: 'q-graph', isFocused: false, bodyColumns: 100, placement: 'dock' }
  const ui = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'Pane', requestId: 'q-graph', props: pane } as Parameters<typeof $.ui.mount>[0])
  expect(await ui.find({ type: 'Link' })).toBeDefined()
  await ui.unmount()

  // When the process exits, the link goes away.
  release()
  await host.clock.advance(0)
  const after = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'Pane', requestId: 'q-graph', props: pane } as Parameters<typeof $.ui.mount>[0])
  expect(await after.find({ type: 'Link' })).toBeUndefined()
  expect(await after.find({ type: 'Button', key: 'open-web' })).toBeDefined()
  await after.unmount()
})

test('the pane button starts the viewer and opens it in the browser', async ($, on) => {
  const opened: string[][] = []
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify(READY)}\n` }
    await new Promise<void>(() => {})
    return { value: { code: 0, signal: null } }
  })
  on('process.run', (_$, e) => {
    opened.push([...e.argv])
    // No macOS `open` here: the button falls through to xdg-open.
    return e.argv[0] === 'open' ? { deny: 'spawn open ENOENT' } : { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })
  on('fs.write', () => ({ value: undefined }))
  fakeHost(on)
  await start($)
  const pane = { title: 'q-graph', isFocused: false, bodyColumns: 100, placement: 'dock' }
  const ui = await $.ui.mount({ plugin: 'q-graph', surface: 'terminal', component: 'Pane', requestId: 'q-graph', props: pane } as Parameters<typeof $.ui.mount>[0])
  await ui.press({ key: 'open-web' })
  expect(opened).toEqual([
    ['open', 'http://127.0.0.1:4321/?k=tok'],
    ['xdg-open', 'http://127.0.0.1:4321/?k=tok'],
  ])
  await ui.unmount()
})

test('/q-graph web tries bun when node is missing, and says what failed when neither runs', async ($, on) => {
  const argvs: string[] = []
  on('process.spawn', async function* (_$, e) {
    argvs.push(e.argv[0]!)
    return { deny: `spawn ${e.argv[0]} ENOENT` }
  })
  fakeHost(on)
  await start($)
  const r = await run($, 'web')
  expect(argvs).toEqual(['node', 'bun'])
  expect(r.exitCode).toBe(1)
  expect(r.text).toMatch(/could not start the viewer \(node: .*ENOENT; bun: .*ENOENT\)/)
})

test('the snapshot names the main transcript: from a main-loop classic hook, else the projects folder', async ($, on) => {
  const writes: string[] = []
  const existing = new Set<string>()
  on('process.spawn', async function* () {
    yield { stream: 'stdout' as const, text: `${JSON.stringify(READY)}\n` }
    await new Promise<void>(() => {})
    return { value: { code: 0, signal: null } }
  })
  on('fs.write', (_$, e) => {
    writes.push(e.text)
    return { value: undefined }
  })
  on('fs.exists', (_$, e) => ({ value: existing.has(e.path) }))
  on('env.get', (_$, e) => ({ value: e.name === 'HOME' ? '/home/me' : undefined }))
  on('session.root', () => ({ value: '/repo/my.app' }))
  on('classic.UserPromptSubmit', () => ({}))
  on('session.id', () => ({ value: 'sess-1' }))
  const host = fakeHost(on)
  await start($)
  const last = () => JSON.parse(writes.at(-1)!) as { session: string; transcript: string | null }

  // Nothing known yet and no file on disk: null.
  await run($, 'web')
  expect(last().transcript).toBeNull()

  // The file appears where Claude Code keeps it: found from HOME, the root and the session id.
  const guess = '/home/me/.claude/projects/-repo-my-app/sess-1.jsonl'
  existing.add(guess)
  await spawn($, 'Explore', 'scan')
  // The miss above is remembered for a few seconds.
  await host.clock.advance(6000)
  expect(last().transcript).toBe(guess)

  // A subagent's hook never names it; the main loop's does.
  await $.classic.UserPromptSubmit({ prompt: 'x', agent_id: 'a1', transcript_path: '/elsewhere/a1.jsonl' } as never)
  await $.classic.UserPromptSubmit({ prompt: 'hi', transcript_path: '/t/proj/sess-1.jsonl' } as never)
  await spawn($, 'Explore', 'again')
  await host.clock.advance(300)
  expect(last().transcript).toBe('/t/proj/sess-1.jsonl')
})
