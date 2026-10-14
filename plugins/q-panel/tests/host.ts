// Test helpers shared by the q-panel tests: a fake host and short ways to drive the plugin.

import type { Engine } from 'claude-code/testing'
import type { On } from 'claude-code'

/** An in-memory $.store, a clock that moves 250 ms per read, and a session root of /repo. */
export const fakeHost = (on: On) => {
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
  on('session.root', () => ({ value: '/repo' }))
  on('command.register', (_$, e) => ({ value: { command: e.name } }))
  on('session.start', (_$, e) => ({ cwd: e.cwd }))
  return { store }
}

export const run = ($: Engine, args: string) =>
  $.command.run({ command: 'q-panel', args } as Parameters<Engine['command']['run']>[0]) as Promise<{ text: string; exitCode?: number }>

export const start = ($: Engine) => $.session.start({ cwd: '/repo', surface: 'terminal', isInteractive: true } as Parameters<Engine['session']['start']>[0])
