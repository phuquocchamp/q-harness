// q-graph live viewer: a small HTTP server the q-graph mod starts with $.process.spawn.
// It makes a private temp folder, prints one JSON line `{ ready, port, file, token }` on stdout,
// then serves the viewer page and pushes the graph snapshot the mod writes to `file` over SSE.
// Node 18+ or Bun, no dependencies. It listens on 127.0.0.1 only and every request needs the token.

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, watchFile, unwatchFile, writeFileSync } from 'node:fs'
import { homedir, tmpdir } from 'node:os'
import { basename, dirname, isAbsolute, join, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { TranscriptIndex, buildTimeline, emptyDetail, emptyTimeline, stats } from './transcript.mjs'

const here = dirname(fileURLToPath(import.meta.url))

const alivePid = pid => {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    return err?.code === 'EPERM'
  }
}

/** Viewer folders left behind by a crashed server are removed after this long. */
const STALE_MS = 24 * 60 * 60 * 1000
for (const name of readdirSync(tmpdir())) {
  if (!/^q-graph-[A-Za-z0-9]{6}$/.test(name)) continue
  try {
    const old = join(tmpdir(), name)
    if (Date.now() - statSync(old).mtimeMs <= STALE_MS) continue
    // A long-running viewer's folder keeps its old mtime: spare it while its owner is alive.
    let owner = 0
    try {
      owner = Number(readFileSync(join(old, 'owner.pid'), 'utf8'))
    } catch {
      // Older viewers wrote no owner file.
    }
    if (owner > 0 && alivePid(owner)) continue
    rmSync(old, { recursive: true, force: true })
  } catch {
    // Not ours to clean, or already gone.
  }
}

const dir = mkdtempSync(join(tmpdir(), 'q-graph-'))
writeFileSync(join(dir, 'owner.pid'), String(process.pid), { mode: 0o600 })
const file = join(dir, 'snapshot.json')
const token = randomBytes(16).toString('hex')
const parent = process.ppid

writeFileSync(file, '', { mode: 0o600 })

const PAGE = ['index.html', 'text/html; charset=utf-8']
/** Files that hold no session data: the page's relative links load them without the token. */
const ASSETS = {
  '/reactflow-base.css': ['reactflow-base.css', 'text/css; charset=utf-8'],
  '/q-theme.css': ['q-theme.css', 'text/css; charset=utf-8'],
  '/icon.svg': ['icon.svg', 'image/svg+xml'],
}

const serve = (res, [name, type]) => res.writeHead(200, { 'content-type': type }).end(readFileSync(join(here, name)))

// The page has inline script and style and loads React, React Flow, marked and DOMPurify from two CDNs.
const CSP = [
  "default-src 'none'",
  "script-src 'self' 'unsafe-inline' https://cdnjs.cloudflare.com https://cdn.jsdelivr.net",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data:",
  "font-src 'self' data:",
  "connect-src 'self'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ')

const digest = v => createHash('sha256').update(v).digest()
const tokenOk = given => given !== null && timingSafeEqual(digest(given), digest(token))

const MAX_CLIENTS = 16

/** Every open SSE response. */
const clients = new Set()

const readSnapshot = () => {
  try {
    const text = readFileSync(file, 'utf8')
    return text.trim() ? text : null
  } catch {
    return null
  }
}

/**
 * LRU of incremental indexes, bounded by their approximate size instead of their count, so a
 * scan over many files cannot evict what it still needs. The newest entry is always kept.
 */
class IndexCache {
  constructor(limitBytes, slim) {
    this.limit = limitBytes
    this.slim = slim
    this.map = new Map()
    this.total = 0
  }

  /** The index of `path`, brought up to date; null when the file is missing. */
  get(path, root) {
    const hit = this.map.get(path)
    if (hit) {
      this.map.delete(path)
      this.total -= hit.size
    }
    const index = hit?.index ?? new TranscriptIndex(path, { root, slim: this.slim })
    if (!index.update()) return null
    const size = index.approxBytes()
    // Re-inserted on every use, so the first key is the least recently used.
    this.map.set(path, { index, size })
    this.total += size
    for (const [key, entry] of this.map) {
      if (this.total <= this.limit || entry.index === index) break
      this.map.delete(key)
      this.total -= entry.size
    }
    return index
  }
}

/** Full-detail indexes for /detail; slim ones (no inputs or outputs) for /timeline. */
const full = new IndexCache(64 * 1024 * 1024, false)
const slim = new IndexCache(48 * 1024 * 1024, true)
const AGENT_ID = /^[A-Za-z0-9_@.-]{1,128}$/

// Transcripts live under here; the env override exists for tests.
const projectsRoot = () => {
  try {
    return realpathSync(process.env.Q_GRAPH_PROJECTS_ROOT || join(homedir(), '.claude', 'projects'))
  } catch {
    return null
  }
}

/** The main transcript path from the snapshot, or null unless it is a .jsonl under the projects folder. */
const transcriptPath = () => {
  let transcript = null
  try {
    transcript = JSON.parse(readSnapshot() ?? 'null')?.transcript ?? null
  } catch {
    // A half-written snapshot reads as "not known yet".
  }
  if (typeof transcript !== 'string' || !isAbsolute(transcript) || !transcript.endsWith('.jsonl')) return null
  try {
    const real = realpathSync(transcript)
    const base = projectsRoot()
    return base && real.startsWith(base + sep) ? real : null
  } catch {
    return null
  }
}

/** GET /detail: what happened inside one agent, read on demand from its transcript. */
const detail = (id, use) => {
  const transcript = transcriptPath()
  if (!transcript) return emptyDetail(id, 'no transcript yet')
  if (id !== 'main' && !AGENT_ID.test(id)) return emptyDetail(id, `bad agent id: ${id}`)
  const root = dirname(resolve(transcript))
  const path = resolve(
    id === 'main' ? transcript : join(root, basename(transcript, '.jsonl'), 'subagents', `agent-${id}.jsonl`),
  )
  if (!path.startsWith(root + sep)) return emptyDetail(id, 'transcript outside the project folder')
  const index = full.get(path, root)
  if (!index) return emptyDetail(id, 'transcript not found')
  return index.detail({ id, use: use || null })
}

const META_MAX = 64 * 1024

/** agent-<id>.meta.json parsed, or null when missing, too big or not an object. */
const readMeta = path => {
  try {
    if (statSync(path).size > META_MAX) return null
    const meta = JSON.parse(readFileSync(path, 'utf8'))
    return meta && typeof meta === 'object' && !Array.isArray(meta) ? meta : null
  } catch {
    return null
  }
}

/** GET /timeline: every agent of the session as a lane, read from the transcripts on disk. */
const timeline = () => {
  const transcript = transcriptPath()
  if (!transcript) return emptyTimeline('no transcript yet')
  const root = dirname(resolve(transcript))
  const path = resolve(transcript)
  if (!path.startsWith(root + sep)) return emptyTimeline('transcript outside the project folder')
  const main = slim.get(path, root)
  if (!main) return emptyTimeline('transcript not found')
  const folder = join(root, basename(transcript, '.jsonl'), 'subagents')
  let names = []
  try {
    names = readdirSync(folder)
  } catch {
    // No subagents yet.
  }
  const subagents = []
  for (const name of names) {
    const m = /^agent-(.+)\.jsonl$/.exec(name)
    if (!m || !AGENT_ID.test(m[1])) continue
    const index = slim.get(join(folder, name), root)
    if (index) subagents.push({ id: m[1], index, meta: readMeta(join(folder, `agent-${m[1]}.meta.json`)) })
  }
  return buildTimeline({ main, subagents })
}

const send = (res, text) => res.write(`data: ${text.replace(/\n/g, '')}\n\n`)

// The mod rewrites the file whole; poll its mtime (fs.watch misses atomic renames on some systems).
watchFile(file, { interval: 200 }, () => {
  const text = readSnapshot()
  if (text) for (const res of clients) send(res, text)
})

// An open tab keeps the page it loaded; tell it to reload when the page file changes on disk.
const page = join(here, PAGE[0])
watchFile(page, { interval: 1000 }, (cur, prev) => {
  if (cur.mtimeMs !== prev.mtimeMs) for (const res of clients) res.write('event: reload\ndata: page\n\n')
})

const server = createServer((req, res) => {
  res.setHeader('content-security-policy', CSP)
  res.setHeader('x-content-type-options', 'nosniff')
  res.setHeader('referrer-policy', 'no-referrer')
  res.setHeader('cache-control', 'no-store')
  // Refuses DNS-rebinding pages: the browser sends the attacker's host name here.
  const { port } = server.address()
  if (req.headers.host !== `127.0.0.1:${port}` && req.headers.host !== `localhost:${port}`) {
    res.writeHead(403, { 'content-type': 'text/plain' }).end('q-graph: bad host')
    return
  }
  const url = new URL(req.url ?? '/', 'http://127.0.0.1')
  const asset = ASSETS[url.pathname]
  if (asset) {
    serve(res, asset)
    return
  }
  if (!tokenOk(url.searchParams.get('k'))) {
    res.writeHead(401, { 'content-type': 'text/plain' }).end('q-graph: missing or wrong token. Open the link from /q-graph web.')
    return
  }
  if (url.pathname === '/events') {
    if (clients.size >= MAX_CLIENTS) {
      res.writeHead(503, { 'content-type': 'text/plain' }).end('q-graph: too many open viewers')
      return
    }
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    clients.add(res)
    const now = readSnapshot()
    if (now) send(res, now)
    req.on('close', () => clients.delete(res))
    return
  }
  if (url.pathname === '/stats' && process.env.Q_GRAPH_TEST) {
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(stats))
    return
  }
  if (url.pathname === '/snapshot.json') {
    res.writeHead(200, { 'content-type': 'application/json' }).end(readSnapshot() ?? 'null')
    return
  }
  if (url.pathname === '/detail') {
    let body
    try {
      body = detail(url.searchParams.get('agent') || 'main', url.searchParams.get('use'))
    } catch (e) {
      body = emptyDetail(url.searchParams.get('agent') || 'main', `detail failed: ${e?.message ?? e}`)
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/timeline') {
    let body
    try {
      body = timeline()
    } catch (e) {
      body = emptyTimeline(`timeline failed: ${e?.message ?? e}`)
    }
    res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify(body))
    return
  }
  if (url.pathname === '/') {
    serve(res, PAGE)
    return
  }
  res.writeHead(404, { 'content-type': 'text/plain' }).end('not found')
})

let closed = false
const shutdown = () => {
  if (closed) return
  closed = true
  unwatchFile(file)
  unwatchFile(page)
  for (const res of clients) res.end()
  server.close()
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The OS cleans its temp folder in the end.
  }
  process.exit(0)
}

// Heartbeats keep proxies and browsers from dropping an idle stream; the parent check ends an
// orphaned viewer when Claude Code exits without killing it.
setInterval(() => {
  for (const res of clients) res.write(': ping\n\n')
  let alive = true
  try {
    process.kill(parent, 0)
  } catch {
    alive = false
  }
  if (!alive || process.ppid !== parent) shutdown()
}, 5000).unref()

for (const sig of ['SIGTERM', 'SIGINT', 'SIGHUP']) process.on(sig, shutdown)
for (const ev of ['uncaughtException', 'unhandledRejection']) process.on(ev, shutdown)
// Last resort for exits that skip shutdown().
process.on('exit', () => {
  try {
    rmSync(dir, { recursive: true, force: true })
  } catch {
    // The OS cleans its temp folder in the end.
  }
})

server.listen(0, '127.0.0.1', () => {
  const { port } = server.address()
  // Fails loudly when the folder vanished before the mod could learn it.
  statSync(file)
  process.stdout.write(`${JSON.stringify({ ready: true, port, file, token })}\n`)
})
