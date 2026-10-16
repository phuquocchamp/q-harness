// Settings from the dashboard: the runner side of the mod's settings, like ask.mjs and settings-save.mjs. The mod is the
// only reader and writer of q-pilot's settings, so a request is written as config-<n>.json, announced on stderr, and
// answered by the mod in config-<n>.answer.json (every answer carries the resolved rows, so one call refreshes the page).
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const CONFIG_MARK = '[q-pilot] config '
const WAIT_MS = 15_000
const POLL_MS = 100

/** Returns call(req): the file is written before the promise of the mod's answer ({ ok, settings, files } or { error }) is returned. */
export function configViaMod({ dir, log = line => console.error(line), waitMs = WAIT_MS }) {
  let n = 0
  return req => {
    n++
    const file = join(dir, `config-${n}.json`)
    const answer = join(dir, `config-${n}.answer.json`)
    writeFileSync(file, JSON.stringify(req))
    log(`${CONFIG_MARK}${JSON.stringify({ n, file })}`)
    return (async () => {
      for (const end = Date.now() + waitMs; Date.now() < end; ) {
        if (existsSync(answer)) {
          try { return JSON.parse(readFileSync(answer, 'utf8')) } catch { return { error: 'the answer file is not JSON' } }
        }
        await new Promise(r => setTimeout(r, POLL_MS).unref?.())
      }
      return { error: `no answer from the Claude Code session within ${waitMs / 1000} s`, timeout: true }
    })()
  }
}
