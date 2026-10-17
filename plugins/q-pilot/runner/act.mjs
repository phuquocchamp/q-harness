// Performing one action on the page, and turning an observed action into a trace step.
import { observe, pathOf } from './snapshot.mjs'
import { remoteAllowed } from './flow.mjs'

const navs = new WeakMap()

/**
 * Counts main-frame navigations on `page`, started (n) and committed (done), so settle() can tell when an action
 * started a page load and wait for it. Call once per page.
 */
export function trackNetwork(page) {
  // `seq` numbers each XHR/fetch; `open` maps the ones still in flight to their number.
  const state = { n: 0, done: 0, seq: 0, open: new Map() }
  page.on('request', r => {
    if (r.isNavigationRequest() && r.frame() === page.mainFrame()) state.n++
    else if (DATA_TYPES.has(r.resourceType())) state.open.set(r, ++state.seq)
  })
  const finished = r => state.open.delete(r)
  page.on('requestfinished', finished)
  page.on('requestfailed', finished)
  page.on('framenavigated', f => {
    if (f === page.mainFrame()) state.done++
  })
  navs.set(page, state)
}

const DATA_TYPES = new Set(['xhr', 'fetch'])
/** The longest an action waits for the data requests it started (a price grid, a suggestion list). */
const DATA_WAIT_MS = 3000
const count = page => navs.get(page) ?? { n: 0, done: 0, seq: 0, open: new Map() }
/** True while an XHR/fetch numbered above `after` is in flight. */
const loading = (page, after) => [...count(page).open.values()].some(s => s > after)
/**
 * Waits (at most DATA_WAIT_MS) until the data requests started after `after` are done: content that arrives by XHR
 * (Google Flights' date grid shows "0000" placeholders until its prices load) is then on the page Jev sees next.
 * Only requests the action started count, so background polling that was already running does not hold a step.
 */
async function dataLoaded(page, after) {
  for (const end = Date.now() + DATA_WAIT_MS; loading(page, after) && Date.now() < end; ) await new Promise(r => setTimeout(r, 25))
}

const frames = page =>
  page.evaluate(() => new Promise(r => { requestAnimationFrame(() => requestAnimationFrame(r)); setTimeout(r, 50) })).catch(() => {})

/**
 * After an action, like jev-ultrafast: 2 animation frames or 50 ms, whichever comes first. A page load the action
 * started is waited for (domcontentloaded); without one, the XHR/fetch requests the action started (dataLoaded).
 * Background traffic that was already running is not: on real sites the network is rarely idle.
 * `navsBefore`: the navigation count taken before the action.
 */
export async function settle(page, before = { ...count(page) }) {
  await frames(page)
  const now = count(page)
  if (now.n === before.n) return dataLoaded(page, before.seq)
  // waitForLoadState resolves at once while a slow navigation has not committed yet, so wait for the commit first.
  for (const end = Date.now() + 10000; count(page).done === before.done && Date.now() < end; ) await new Promise(r => setTimeout(r, 25))
  await page.waitForLoadState('domcontentloaded', { timeout: 10000 }).catch(() => {})
}

const STABLE_MS = 3000
const LOAD_MS = 10000
/**
 * Before the first decision, like jev-ultrafast (which waits for readyState "complete"): wait for the load event,
 * then until the number of controls stops changing between two looks, so Jev never decides on a half-hydrated app
 * shell (YouTube's first paint shows only its search box). Never fails: a slow page just goes on as it is.
 */
export async function settleStart(page) {
  await page.waitForLoadState('load', { timeout: LOAD_MS }).catch(() => {})
  const size = () => observe(page).then(s => s.actions.filter(a => a.node !== undefined).length, () => -1)
  let prev = await size()
  for (const end = Date.now() + STABLE_MS; Date.now() < end; ) {
    await page.waitForTimeout(250)
    const n = await size()
    if (n === prev && n > 0) return
    prev = n
  }
}

/** Native pickers only take a whole value: they are filled, never typed into key by key. */
const FILL_ONLY = new Set(['date', 'time', 'datetime-local', 'month', 'week', 'number', 'range', 'color'])
const SUGGEST_MS = 1500
const CLICK_CHANGE_MS = 600

/**
 * In the page: how many visible elements near `field` show `value` (case and diacritics folded), plus whether a
 * listbox option is showing. Suggestion lists on booking sites are plain divs (Traveloka's airports have no role),
 * so "an element with the typed text appeared next to the field" is the signal, not [role=option].
 */
const matchesNear = (field, value) => {
  const fold = t => String(t).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase().replace(/\s+/g, ' ').trim()
  const want = fold(value)
  const box = field?.getBoundingClientRect?.()
  const near = r => !box || (r.bottom > box.top - 600 && r.top < box.bottom + 600)
  let n = 0
  if (want.length >= 2) {
    for (const e of document.body.querySelectorAll('div,li,span,a,button,p,td,[role=option]')) {
      if (e === field || e.contains(field) || e.children.length > 6) continue
      const r = e.getBoundingClientRect()
      if (r.width < 4 || r.height < 4 || r.bottom <= 0 || r.top >= innerHeight || !near(r)) continue
      if (fold(e.textContent).includes(want)) n++
    }
  }
  const option = [...document.querySelectorAll('[role=option],[role=listbox] li,datalist option')].some(e => e.getClientRects().length)
  return { n, option }
}

/**
 * Types like a person (jev-ultrafast clicks, selects all, then inserts): click the field, select what it holds, then
 * type key by key, so widgets that filter on key, focus or pointer events react (a single fill() input event left
 * Traveloka's airport list unfiltered). Falls back to fill() when the field did not take the text.
 */
async function type(page, el, value) {
  const kind = await el.evaluate(e => (e.tagName === 'INPUT' ? e.type : '')).catch(() => '')
  if (FILL_ONLY.has(kind)) return await el.fill(value, { timeout: 2000 })
  await el.click({ timeout: 2000 }).catch(() => el.focus().catch(() => {}))
  const selected = await el.selectText({ timeout: 1000 }).then(() => true, () => false)
  if (selected) await page.keyboard.press('Backspace')
  // An element handle has no pressSequentially: focus it and type through the keyboard (unicode goes in as text).
  await el.focus()
  await page.keyboard.type(value, { delay: 10 })
  const now = await el.inputValue({ timeout: 500 }).catch(() => null)
  if (now !== null && !now.includes(value)) await el.fill(value, { timeout: 2000 })
}

/**
 * After typing: until an element near the field shows the typed text (a suggestion), or a listbox option appears,
 * at most SUGGEST_MS. Counted against what showed before typing, so page text that already held it does not count.
 * A page that has not changed at all QUIET_MS after typing has no suggestions coming (a plain email field): no wait.
 * Polled from here, not with waitForFunction: that needs eval in the page, which a strict CSP (Google, YouTube) blocks.
 */
const QUIET_MS = 300
async function suggestions(page, el, value, before, shapeBefore) {
  const t0 = Date.now()
  // A field that announces suggestions (or turns the browser's own autocomplete off, as custom lists do) gets the
  // whole window: a remote airport search often answers after QUIET_MS.
  const listy = await el.evaluate(e => e.getAttribute('role') === 'combobox' || ['aria-autocomplete', 'list', 'aria-haspopup', 'aria-controls', 'aria-owns'].some(a => e.hasAttribute(a)) || e.getAttribute('autocomplete') === 'off').catch(() => false)
  for (;;) {
    const m = await el.evaluate(matchesNear, value).catch(() => null)
    if (!m) return false
    if (m.option || m.n > before) return true
    if (Date.now() - t0 > SUGGEST_MS) return false
    if (!listy && Date.now() - t0 > QUIET_MS && (await shape(page)) === shapeBefore) return false
    await page.waitForTimeout(100)
  }
}

/** The controls and text size of the page: a click that opened a popup (a date picker) changes it. */
const shape = page => page.evaluate(() => `${document.querySelectorAll('a,button,input,select,textarea,[role],[tabindex]').length}:${document.body?.innerText.length ?? 0}`).catch(() => null)

/**
 * Acts through the element handle behind the snapshot node. Playwright's actionability checks run before input.
 * Returns { suggested }: true when typing brought up a suggestion that matches the typed text.
 */
export async function perform(page, action, fixtureValue) {
  const before = { ...count(page) }
  let suggested = false
  if (action.kind === 'scroll') await page.mouse.wheel(0, action.delta)
  // WAIT also waits for data requests already in flight (Jev waits because the page is still loading).
  else if (action.kind === 'wait') await page.waitForTimeout(100).then(() => dataLoaded(page, 0))
  else if (action.kind === 'press') await page.keyboard.press(action.key)
  // Box rescue: a click at a point of the viewport (CSS px), for a control the element list does not have.
  else if (action.kind === 'click_at') await page.mouse.click(action.x, action.y)
  else {
    const el = (await page.evaluateHandle(n => window.__jevFast.nodes.get(n), action.node)).asElement()
    if (!el) throw new Error('element is gone')
    if (action.kind === 'fill') {
      const value = String(fixtureValue ?? '')
      const was = await el.evaluate(matchesNear, value).catch(() => ({ n: 0 }))
      const shaped = await shape(page)
      await type(page, el, value)
      suggested = await suggestions(page, el, value, was.n, shaped)
    } else if (action.kind === 'select') await el.selectOption({ label: action.option }, { timeout: 2000 })
    else {
      const was = await shape(page)
      try {
        await el.click({ timeout: 2000 })
      } catch (e) {
        // The click ran but Playwright timed out waiting for the slow page load it started: not a failure.
        if (count(page).n === before.n) throw e
      }
      // A popup (date picker, dropdown) renders a moment after the click: wait for the page to change, briefly.
      if (count(page).n === before.n && was !== null) {
        for (const end = Date.now() + CLICK_CHANGE_MS; Date.now() < end && (await shape(page)) === was; ) await page.waitForTimeout(50)
      }
    }
  }
  await settle(page, before)
  return { suggested }
}

/**
 * True when PRESS_ENTER makes sense: `node` (the element just filled) is still the focused element. Without a node,
 * any focused text input that holds a value counts (used when healing a missed fill step).
 */
export async function canPressEnter(page, node) {
  return page
    .evaluate(n => {
      const e = document.activeElement
      if (n !== undefined) return Boolean(e && e === window.__jevFast?.nodes.get(n))
      return Boolean(e && e.tagName === 'INPUT' && ['text', 'search', 'email', 'url', 'tel', 'number'].includes(e.type) && e.value !== '')
    }, node)
    .catch(() => false)
}

/** The snapshot node id of the focused element, or null. Needs a snapshot taken first (it registers the nodes). */
export const focusedNode = page =>
  page.evaluate(() => [...(window.__jevFast?.nodes ?? [])].find(([, e]) => e === document.activeElement)?.[0] ?? null).catch(() => null)

/** Keeps a run on the base origin. `startError` is always checked; `check` is skipped unless remote access is off. */
export function makeGuard(baseURL, env) {
  const base = new URL(baseURL).origin
  const allow = remoteAllowed(env)
  return {
    startError(start) {
      const o = new URL(start, baseURL).origin
      return o === base ? null : `left the allowed origin: ${o}`
    },
    check(page) {
      if (allow) return null
      let o
      try { o = new URL(page.url()).origin } catch { return null }
      return o === base || o === 'null' ? null : `left the allowed origin: ${o}`
    },
  }
}

/** The step stored in a trace: meaning only (op, role, name, scope), never an index and never a fixture value. */
export function toStep(snap, action, fixture) {
  const url = pathOf(snap.url)
  if (action.kind === 'scroll') return { op: 'scroll', delta: action.delta, url }
  if (action.kind === 'wait') return { op: 'wait', url }
  if (action.kind === 'press') return { op: 'press', key: action.key, url }
  if (action.kind === 'click_at') return { op: 'click_at', x: Math.round(action.x), y: Math.round(action.y), url }
  const step = { op: action.kind, role: action.role, name: action.name, scope: action.scope ?? '' }
  if (action.kind === 'select') step.option = action.option
  if (fixture) step.fixture = fixture
  step.url = url
  return step
}

export const describe = s => (s.role ? `${s.op} ${s.role} "${s.name}"` : s.op === 'press' ? `press ${s.key}` : s.op === 'click_at' ? `click at (${s.x}, ${s.y})` : s.op)

/** True when the page sits on the configured login path (and the flow did not start there). */
export function onLogin(page, loginPath, start) {
  if (!loginPath || pathOf(start).split('?')[0] === loginPath) return false
  return pathOf(page.url()).split('?')[0] === loginPath
}

/** Consent buttons, the refusing ones first. Clicked only inside a container that talks about cookies or privacy. */
const REFUSE = /^(reject all|reject|decline all|decline|refuse all|only necessary|necessary only|only essential|essential only|use necessary cookies only|từ chối tất cả|từ chối|alle ablehnen|ablehnen|tout refuser|rechazar todo)$/i
const ACCEPT = /^(accept all|accept|accept cookies|allow all|i agree|agree|got it|ok|okay|đồng ý|chấp nhận|chấp nhận tất cả|alle akzeptieren|tout accepter|aceptar todo)$/i
const CONSENT_TEXT = /cookie|consent|privacy|gdpr|quyền riêng tư|bảo mật|datenschutz|confidentialité/i

/**
 * Before the first decision, like a person would: close a cookie or consent banner that covers the page (on VNA it
 * hid every control, so Jev saw an empty page and answered BLOCKED). Refuses when it can, else accepts. Answers the
 * label it clicked, or null. Never throws.
 */
export async function dismissConsent(page) {
  for (const re of [REFUSE, ACCEPT]) {
    for (const frame of page.frames()) {
      const buttons = frame.getByRole('button', { name: re })
      const n = await buttons.count().catch(() => 0)
      for (let i = 0; i < Math.min(n, 5); i++) {
        const b = buttons.nth(i)
        if (!(await b.isVisible().catch(() => false))) continue
        const about = await b
          .evaluate((e, src) => {
            for (let p = e, up = 0; p && p !== document.body && up < 6; p = p.parentElement, up++) if (new RegExp(src, 'i').test(p.innerText ?? '')) return true
            return false
          }, CONSENT_TEXT.source)
          .catch(() => false)
        if (!about) continue
        const label = (await b.innerText().catch(() => '')).trim()
        if (await b.click({ timeout: 1500 }).then(() => true, () => false)) {
          await settle(page)
          return label || 'consent'
        }
      }
    }
  }
  return null
}
