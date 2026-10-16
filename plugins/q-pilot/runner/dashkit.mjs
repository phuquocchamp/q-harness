// Test helper (not a test): a real q-pilot Dashboard on a free port for a project root, and what it was asked to do.
import { startDash } from './dash-server.mjs'

/** Runs `fn({ env, sessions, opened, d })` against a dashboard for `root`; `env` is what a runner needs to join it. */
export async function withDashFor(root, env, fn) {
  const opened = []
  const d = await startDash({ root, port: 0, log: () => {}, openUrl: u => opened.push(u), env: { Q_PILOT_HEADLESS: '0', DISPLAY: ':0' } })
  const sessions = async () => {
    const r = await fetch(new URL(`/api/sessions?t=${d.pageToken}`, d.url))
    const body = await r.json()
    return Array.isArray(body) ? body : body.sessions
  }
  try {
    return await fn({ env: { ...env, Q_PILOT_DASH_FILE: d.file }, sessions, opened, d })
  } finally {
    await d.close()
  }
}
