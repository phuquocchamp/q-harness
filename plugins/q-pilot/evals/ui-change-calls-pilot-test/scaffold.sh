#!/usr/bin/env bash
# Seeds a two-page static shop with a broken total, a q-pilot config and a small non-UI module.
set -euo pipefail
mkdir -p site lib
cat > site/index.html <<'HTML'
<!doctype html><title>Shop</title><h1>Products</h1>
<ul><li>Coffee beans <a href="checkout.html?item=coffee">Buy coffee beans</a></li></ul>
HTML
cat > site/checkout.html <<'HTML'
<!doctype html><title>Checkout</title><h1>Checkout</h1>
<p>Coffee beans × 1</p><p>Total: <span data-testid="total">€1.20</span></p>
<form onsubmit="event.preventDefault(); document.getElementById('ok').hidden = false">
  <label>Email <input type="email" required></label><button>Place order</button>
</form>
<p id="ok" role="status" hidden>Order confirmed</p>
HTML
cat > lib/money.js <<'JS'
function fmt(cents) { return `€${(cents / 100).toFixed(2)}` }
module.exports = { total: items => fmt(items.reduce((s, i) => s + i.cents, 0)) }
JS
cat > server.mjs <<'JS'
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
createServer(async (req, res) => {
  const path = new URL(req.url, 'http://x').pathname
  try { res.end(await readFile(`site${path === '/' ? '/index.html' : path}`)) } catch { res.statusCode = 404; res.end() }
}).listen(4732)
JS
cat > q-pilot.config.json <<'JSON'
{ "baseURL": "http://localhost:4732", "server": { "command": ["node", "server.mjs"], "url": "http://localhost:4732" } }
JSON
git init -q && git add -A && git -c user.email=e@x -c user.name=e commit -qm init
