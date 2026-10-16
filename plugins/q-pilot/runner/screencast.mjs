// Live view of the page under test: a CDP screencast out, Playwright mouse and keyboard in (take control).
// The dashboard client (dash-client.mjs) owns when it runs; nothing here is called for a run that types a secret.

const KEY = /^[\w+\- ]{1,32}$/
const BUTTONS = ['left', 'right', 'middle']
const MAX_TEXT = 200
const MAX_WHEEL = 2000

/**
 * Starts a screencast of `page`. `onFrame(jpegBuffer, metadata)` gets at most `fps` frames per second and none while the
 * previous call (a promise it returns) is still pending. Returns { page, stop() }; throws when CDP is unavailable.
 * Every frame is acked, kept or not: Chrome stops sending until it is.
 */
export async function startLive(page, onFrame, { quality = 55, maxWidth = 1280, maxHeight = 900, fps = 8 } = {}) {
  const cdp = await page.context().newCDPSession(page)
  let last = 0, inFlight = false, stopped = false
  cdp.on('Page.screencastFrame', ({ data, metadata, sessionId }) => {
    cdp.send('Page.screencastFrameAck', { sessionId }).catch(() => {})
    const now = Date.now()
    if (stopped || inFlight || now - last < 1000 / fps) return
    last = now
    try {
      const r = onFrame(Buffer.from(data, 'base64'), metadata)
      if (r && typeof r.then === 'function') {
        inFlight = true
        r.then(() => {}, () => {}).then(() => { inFlight = false })
      }
    } catch {}
  })
  try {
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality, maxWidth, maxHeight, everyNthFrame: 1 })
  } catch (e) {
    await cdp.detach().catch(() => {})
    throw e
  }
  return {
    page,
    async stop() {
      if (stopped) return
      stopped = true
      await cdp.send('Page.stopScreencast').catch(() => {})
      await cdp.detach().catch(() => {})
    },
  }
}

const frac = v => typeof v === 'number' && Number.isFinite(v) && v >= 0 && v <= 1

/**
 * A point given as fractions (0..1) of the shown frame, in CSS px of the page. `meta` is the latest screencast metadata
 * (deviceWidth/deviceHeight, offsetTop, pageScaleFactor); without it the viewport size is used.
 */
export function toPoint(ev, meta, viewport) {
  if (!frac(ev.x) || !frac(ev.y)) throw new Error('x and y must be fractions between 0 and 1')
  const w = meta?.deviceWidth || viewport?.width, h = meta?.deviceHeight || viewport?.height
  if (!(w > 0) || !(h > 0)) throw new Error('the page size is unknown')
  const scale = meta?.pageScaleFactor > 0 && meta.pageScaleFactor !== 1 ? meta.pageScaleFactor : 1
  return { x: Math.round((ev.x * w) / scale), y: Math.max(0, Math.round((ev.y * h - (meta?.offsetTop ?? 0)) / scale)) }
}

/**
 * Applies one take-control event with Playwright (the same for a launched and an attached browser, and it lands in the
 * trace). Throws on a malformed event. Returns the trail text for the person's action, or null when it is not worth a row
 * (move, wheel). Typed text is never returned, only its length; a single typed key counts as typed text, not a key name.
 */
export async function sendInput(page, ev, meta = null) {
  if (!ev || typeof ev !== 'object') throw new Error('bad input event')
  const point = () => toPoint(ev, meta, page.viewportSize?.())
  switch (ev.type) {
    case 'click':
    case 'dblclick': {
      const { x, y } = point()
      const button = ev.button ?? 'left'
      if (!BUTTONS.includes(button)) throw new Error('bad mouse button')
      if (ev.type === 'click') await page.mouse.click(x, y, { button })
      else await page.mouse.dblclick(x, y, { button })
      return `${ev.type === 'click' ? 'click' : 'double click'} at (${x}, ${y})`
    }
    case 'move': {
      const { x, y } = point()
      await page.mouse.move(x, y)
      return null
    }
    case 'wheel': {
      const d = v => (typeof v === 'number' && Number.isFinite(v) ? Math.max(-MAX_WHEEL, Math.min(MAX_WHEEL, v)) : 0)
      if (ev.x !== undefined) {
        const { x, y } = point()
        await page.mouse.move(x, y)
      }
      await page.mouse.wheel(d(ev.dx), d(ev.dy))
      return null
    }
    case 'key': {
      if (typeof ev.key !== 'string' || !KEY.test(ev.key)) throw new Error('bad key')
      await page.keyboard.press(ev.key)
      return ev.key.length === 1 ? 'typed 1 chars' : `press ${ev.key}`
    }
    case 'text': {
      if (typeof ev.text !== 'string' || !ev.text.length || ev.text.length > MAX_TEXT) throw new Error(`text must be 1 to ${MAX_TEXT} characters`)
      await page.keyboard.type(ev.text)
      return `typed ${ev.text.length} chars`
    }
    default:
      throw new Error('unknown input type')
  }
}

/**
 * What the browser is, for the dashboard chip: { kind: 'chromium' | 'chrome-cdp' | 'electron', label }. An attached
 * browser is told apart by its User-Agent at <Q_PILOT_CDP_URL>/json/version (Electron says "Electron/x"). Never throws.
 */
export async function targetOf(browser, env = process.env) {
  const version = (() => { try { return String(browser.version?.() ?? '') } catch { return '' } })()
  const major = version.split('.')[0]
  if (!env.Q_PILOT_CDP_URL) return { kind: 'chromium', label: major ? `Chromium ${major}` : 'Chromium' }
  try {
    const res = await fetch(new URL('/json/version', env.Q_PILOT_CDP_URL), { signal: AbortSignal.timeout(1500) })
    const ua = String((await res.json())['User-Agent'] ?? '')
    const electron = /Electron\/([\d.]+)/.exec(ua)
    if (electron) return { kind: 'electron', label: `Electron ${electron[1].split('.')[0]}` }
  } catch {}
  return { kind: 'chrome-cdp', label: 'Chrome (CDP)' }
}
