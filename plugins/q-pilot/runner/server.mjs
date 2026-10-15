// Starts the app from config.server when its url does not answer, and stops it after the run.
import { spawn } from 'node:child_process'

export class ServerError extends Error {}

// Every server this process started, so a signal or the hard deadline can stop them all.
const live = new Set()
export function stopAllServers() {
  for (const stop of [...live]) stop()
}
process.on('exit', stopAllServers)

async function answers(url) {
  try {
    await fetch(url, { signal: AbortSignal.timeout(1000) })
    return true
  } catch {
    return false
  }
}

/** Returns { stop() }. Throws ServerError when the server does not come up within timeoutMs. */
export async function ensureServer(config, root) {
  const s = config.server
  if (!s || (await answers(s.url))) return { stop() {} }
  const [cmd, ...args] = s.command
  // `node` on PATH may be missing or another version: use the runner's own binary.
  const child = spawn(cmd === 'node' ? process.execPath : cmd, args, { cwd: root, stdio: ['ignore', 'ignore', 'pipe'], detached: true })
  let err = '', exited = null
  child.stderr.on('data', d => (err = (err + d).slice(-500)))
  child.on('exit', code => (exited = code ?? 'signal'))
  child.on('error', e => (exited = e.message))
  // The server may have children of its own: kill the whole process group.
  const stop = () => {
    live.delete(stop)
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
  }
  live.add(stop)
  const end = Date.now() + s.timeoutMs
  while (Date.now() < end) {
    if (exited !== null) {
      live.delete(stop)
      throw new ServerError(`server exited (${exited}) before ${s.url} answered: ${err.trim()}`)
    }
    if (await answers(s.url)) return { stop }
    await new Promise(r => setTimeout(r, 100))
  }
  stop()
  throw new ServerError(`server did not answer at ${s.url} within ${s.timeoutMs} ms`)
}
