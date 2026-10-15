// Starts the playwright-test MCP server in the project's Playwright folder. The server resolves its
// config from the working directory, and Claude Code starts it in the session's, which may be a
// parent folder (or a subfolder) of the project: from the repo root it finds no tests.
// This walks up from the working directory to the nearest playwright.config.* and runs the server there.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'

const NAMES = ['ts', 'js', 'mts', 'mjs', 'cts', 'cjs'].map(ext => `playwright.config.${ext}`)

let dir = process.cwd()
let config
for (;;) {
  const name = NAMES.find(n => existsSync(join(dir, n)))
  if (name) {
    config = join(dir, name)
    break
  }
  const parent = dirname(dir)
  if (parent === dir) break
  dir = parent
}

// No config anywhere above: start where Claude did, as before.
const args = ['playwright', 'run-test-mcp-server', '--headless', ...(config ? ['-c', config] : []), ...process.argv.slice(2)]
const child = spawn('npx', args, { cwd: config ? dir : process.cwd(), stdio: 'inherit', shell: process.platform === 'win32' })
child.on('exit', (code, signal) => process.exit(code ?? (signal ? 1 : 0)))
for (const sig of ['SIGINT', 'SIGTERM']) process.on(sig, () => child.kill(sig))
