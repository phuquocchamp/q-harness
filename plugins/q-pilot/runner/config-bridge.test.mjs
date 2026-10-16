// The runner side of Settings: request file, mark, the mod's answer file, and the timeout.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CONFIG_MARK, configViaMod } from './config-bridge.mjs'

test('a request is written as config-<n>.json, announced with the mark, and the answer file is returned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-cfg-'))
  try {
    const logs = []
    const call = configViaMod({ dir, log: l => logs.push(l) })
    const first = call({ op: 'get' })
    assert.deepEqual(JSON.parse(readFileSync(join(dir, 'config-1.json'), 'utf8')), { op: 'get' })
    assert.equal(logs[0], `${CONFIG_MARK}${JSON.stringify({ n: 1, file: join(dir, 'config-1.json') })}`)
    writeFileSync(join(dir, 'config-1.answer.json'), JSON.stringify({ ok: true, settings: [], files: {} }))
    assert.deepEqual(await first, { ok: true, settings: [], files: {} })
    const second = call({ op: 'set', key: 'vision', value: 'off', scope: 'user' })
    assert.equal(JSON.parse(readFileSync(join(dir, 'config-2.json'), 'utf8')).key, 'vision')
    writeFileSync(join(dir, 'config-2.answer.json'), 'nope')
    assert.deepEqual(await second, { error: 'the answer file is not JSON' })
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('no answer within the wait gives an error marked as a timeout', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'qp-cfg-'))
  try {
    const r = await configViaMod({ dir, log: () => {}, waitMs: 150 })({ op: 'get' })
    assert.match(r.error, /no answer from the Claude Code session within 0\.15 s/)
    assert.equal(r.timeout, true)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})
