// Copies shared/ui/q-theme.css into each plugin that serves UI (plugins install independently, so
// they cannot import from the repo root). `--check` exits 1 and lists the copies that drifted.
// Run: node scripts/sync-ui.mjs [--check]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const SOURCE = 'shared/ui/q-theme.css'
// Add a plugin's copy here.
export const TARGETS = ['plugins/q-graph/viewer/q-theme.css', 'plugins/q-pilot/runner/inspector/q-theme.css']
export const HEADER = `/* GENERATED from ${SOURCE} by scripts/sync-ui.mjs — do not edit */\n`

/** Writes every target, or with `check` only reports. Returns the targets that differ (or were written). */
export const sync = ({ root, targets = TARGETS, check = false }) => {
  const want = HEADER + readFileSync(join(root, SOURCE), 'utf8')
  const changed = []
  for (const target of targets) {
    const path = join(root, target)
    let have = null
    try {
      have = readFileSync(path, 'utf8')
    } catch {
      // Missing counts as drift.
    }
    if (have === want) continue
    changed.push(target)
    if (!check) {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, want)
    }
  }
  return changed
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const check = process.argv.includes('--check')
  const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
  const changed = sync({ root, check })
  if (check && changed.length) {
    console.error(`UI copies out of date, run: node scripts/sync-ui.mjs\n${changed.map(t => `  ${t}`).join('\n')}`)
    process.exit(1)
  }
  console.log(check ? 'UI copies in sync' : changed.length ? `synced ${changed.join(', ')}` : 'already in sync')
}
