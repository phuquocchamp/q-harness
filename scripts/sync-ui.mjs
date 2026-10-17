// Copies the shared UI files into each plugin that serves UI (plugins install independently, so they cannot import
// from the repo root): the q-theme.css tokens and the plugin's icon. `--check` exits 1 and lists the copies that drifted.
// Run: node scripts/sync-ui.mjs [--check]

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

export const THEME = 'shared/ui/q-theme.css'
export const ICONS = 'docs/images/icons'
// Add a plugin's copy here.
export const COPIES = [
  { source: THEME, target: 'plugins/q-graph/viewer/q-theme.css' },
  { source: THEME, target: 'plugins/q-pilot/runner/inspector/q-theme.css' },
  { source: `${ICONS}/q-graph.svg`, target: 'plugins/q-graph/viewer/icon.svg' },
  { source: `${ICONS}/q-pilot.svg`, target: 'plugins/q-pilot/runner/inspector/icon.svg' },
]

export const header = source =>
  source.endsWith('.svg')
    ? `<!-- GENERATED from ${source} by scripts/sync-ui.mjs — do not edit -->\n`
    : `/* GENERATED from ${source} by scripts/sync-ui.mjs — do not edit */\n`

// The icons are drawn on the macOS app-icon grid (a 412px tile inside 512px). A web UI shows them as a favicon or a
// header mark, so the copy crops the viewBox to the tile and it fills the box.
export const render = (source, text) =>
  header(source) + (source.endsWith('.svg') ? text.replace('viewBox="0 0 512 512"', 'viewBox="50 50 412 412"') : text)

/** Writes every copy, or with `check` only reports. Returns the targets that differ (or were written). */
export const sync = ({ root, copies = COPIES, check = false }) => {
  const changed = []
  for (const { source, target } of copies) {
    const want = render(source, readFileSync(join(root, source), 'utf8'))
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
