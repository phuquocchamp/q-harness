// Runs only with Q_PILOT_LIVE=1 and TYPESAFE_API_KEY: real Jev calls (paid key), so run it rarely.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { copyFileSync, existsSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { main } from './pilot.mjs'
import { DRIFT, makeApp } from './testkit.mjs'

const live = process.env.Q_PILOT_LIVE === '1' && process.env.TYPESAFE_API_KEY
const trace = root => join(root, '.q-pilot', 'traces', 'checkout-coffee.json')
const first = async args => (await main(args, process.env)).flows[0]

test('live: record, replay green, then heal a renamed button', { skip: live ? false : 'set Q_PILOT_LIVE=1 and TYPESAFE_API_KEY' }, async () => {
  const plain = await makeApp(), drifted = await makeApp(DRIFT)
  try {
    rmSync(trace(plain.root))
    const rec = await first(['record', '--root', plain.root, '--flow', 'checkout-coffee'])
    console.error('live record', JSON.stringify({ outcome: rec.outcome, jevCalls: rec.jevCalls, jevMs: rec.jevMs }))
    assert.equal(rec.outcome, 'pass')
    assert.ok(existsSync(trace(plain.root)))

    const green = await first(['run', '--root', plain.root, '--flows', 'checkout-coffee'])
    assert.equal(green.outcome, 'pass')
    assert.equal(green.jevCalls, 0)

    copyFileSync(trace(plain.root), trace(drifted.root))
    const healed = await first(['run', '--root', drifted.root, '--flows', 'checkout-coffee'])
    console.error('live heal', JSON.stringify({ outcome: healed.outcome, jevCalls: healed.jevCalls, jevMs: healed.jevMs, diverged: healed.diverged }))
    assert.equal(healed.outcome, 'drift')
    assert.equal(healed.jevCalls, 1)
    assert.equal(healed.diverged[0].now.name, 'Pay now')
    assert.ok(existsSync(healed.proposal))
  } finally {
    plain.cleanup()
    drifted.cleanup()
  }
})
