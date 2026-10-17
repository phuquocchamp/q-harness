// "Save as default" from the inspector: the runner never writes a settings file (the mod is the only writer).
// Like ask.mjs: it writes settings-save-<n>.json into the run dir, announces it on stderr, and the mod answers with
// settings-save-<n>.answer.json ({ ok, message } or { error }) after applying it to the chosen scope.
import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

export const SAVE_MARK = '[q-pilot] settings-save '
const WAIT_MS = 60_000
const POLL_MS = 150

/** Returns save({ keys, scope }): the file is written before it returns a promise of the mod's answer. */
export function saveViaMod({ runDir, log = line => console.error(line) }) {
  let n = 0
  return ({ keys, scope }) => {
    n++
    const file = join(runDir, `settings-save-${n}.json`)
    const answer = join(runDir, `settings-save-${n}.answer.json`)
    writeFileSync(file, JSON.stringify({ n, keys, scope }))
    log(`${SAVE_MARK}${JSON.stringify({ n, file })}`)
    return (async () => {
      for (const end = Date.now() + WAIT_MS; Date.now() < end; ) {
        if (existsSync(answer)) {
          try { return JSON.parse(readFileSync(answer, 'utf8')) } catch { return { error: 'the answer file is not JSON' } }
        }
        await new Promise(r => setTimeout(r, POLL_MS).unref?.())
      }
      return { error: `no answer from the Claude Code session within ${WAIT_MS / 1000} s` }
    })()
  }
}
