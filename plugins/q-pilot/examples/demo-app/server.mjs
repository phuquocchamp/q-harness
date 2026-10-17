// Zero-dependency static server for the demo: serves ./src on PORT (default 4731).
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { extname, join, normalize } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(fileURLToPath(new URL('.', import.meta.url)), 'src')
const port = Number(process.env.PORT ?? 4731)
const types = { '.html': 'text/html; charset=utf-8', '.css': 'text/css', '.js': 'text/javascript' }

createServer(async (req, res) => {
  const path = new URL(req.url ?? '/', 'http://x').pathname
  const file = normalize(join(root, path === '/' ? 'index.html' : path))
  if (!file.startsWith(root)) return res.writeHead(403).end()
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': types[extname(file)] ?? 'application/octet-stream' }).end(body)
  } catch {
    res.writeHead(404, { 'content-type': 'text/plain' }).end('Not found')
  }
}).listen(port, '127.0.0.1', () => console.log(`demo app on http://localhost:${port}`))
