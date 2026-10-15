// Draws a laid-out graph into the cells of a terminal `Raster`: cards with a rounded border in the
// agent's colour, edges routed at right angles with box-drawing lines (one trunk per parent, a
// `├──▸` branch per child), a dot that moves along the branch of every running agent, under each
// card the list of what that agent used (tools, skills, MCP servers, rules; filled while in use),
// and the session's harness card. Text uses the terminal's own colour, so the graph reads on light
// and dark terminals alike.
// Each cell is [codePoint, foreground, background] (RasterProps.cells).

import type { AgentKind, AgentNode, Harness, SessionGraph, UseKind } from '../../types'
import { STATUS_TEXT, agentUses, formatElapsed, formatTokens, harnessLines, needsYou, shortModel, type Use } from './graph'
import { MAX_USES, TILE_ROWS, type Box, type HarnessBox, type Layout } from './layout'

/** The terminal's own colour (RasterProps: bit 24 alone). */
export const DEFAULT = 0x01000000

export const COLORS = {
  dim: 0x727d8c,
  edge: 0x5c6878,
  ok: 0x4cbf7f,
  warn: 0xc07a10,
  bad: 0xf0675a,
  tool: 0xb0720c,
  ink: 0x15191f,
} as const

export const KIND_COLOR: Record<AgentKind, number> = { main: 0x7d8cff, subagent: 0x2fbfae, teammate: 0xe46db6 }
/** One hue per kind of use under a card. */
export const USE_COLOR: Record<UseKind, number> = { tool: COLORS.tool, skill: 0xa98bf0, mcp: 0x4aa3df, rule: 0x7fb35a }
/** The same hues, quieter: the border of a card that is not running. */
const KIND_DIM: Record<AgentKind, number> = { main: 0x5b66a8, subagent: 0x2b7d74, teammate: 0x93507c }

// Keyed by string so a status the union does not list yet (`lost`) still has a colour.
const STATUS_COLOR: Record<string, number> = {
  pending: COLORS.dim,
  running: KIND_COLOR.subagent,
  waiting: COLORS.dim,
  idle: COLORS.dim,
  completed: COLORS.ok,
  failed: COLORS.bad,
  killed: COLORS.dim,
  lost: COLORS.warn,
}

const SPINNER = '◐◓◑◒'
/** Cells a moving dot advances per frame. */
const DOT_STEP = 1

// Line directions, combined per cell into one box-drawing glyph.
const U = 1
const D = 2
const L = 4
const R = 8
const GLYPH: Record<number, number> = {
  [U | D]: 0x2502, // │
  [L | R]: 0x2500, // ─
  [D | R]: 0x256d, // ╭
  [D | L]: 0x256e, // ╮
  [U | R]: 0x2570, // ╰
  [U | L]: 0x256f, // ╯
  [U | D | R]: 0x251c, // ├
  [U | D | L]: 0x2524, // ┤
  [L | R | D]: 0x252c, // ┬
  [L | R | U]: 0x2534, // ┴
  [U | D | L | R]: 0x253c, // ┼
  [U]: 0x2502,
  [D]: 0x2502,
  [L]: 0x2500,
  [R]: 0x2500,
}
/** Dashed lines for messages between agents. */
const DASH_H = 0x2504 // ┄
const DASH_V = 0x2506 // ┆
const ARROW = 0x25b8 // ▸
const ARROW_BACK = 0x25c2 // ◂
const DOT = 0x25cf // ●

/** Marks, format and unassigned characters, emoji drawn as pictures: none of them is one column wide. */
const NOT_ONE_COLUMN = /[\p{M}\p{Cf}\p{Cn}\p{Cc}\p{Co}\p{Emoji_Presentation}]/u

/** Left out without a trace: combining marks, variation selectors and the zero-width joiner have no cell of their own. */
const DROPPED = /[\p{M}\u200d\ufe00-\ufe0f]/u

/** True for a code point a Raster cell takes: printable, one column wide, in the BMP. */
const isCellChar = (cp: number) => {
  const inRange =
    (cp >= 0x20 && cp < 0x7f) ||
    (cp > 0xad && cp < 0x300) ||
    (cp >= 0xa0 && cp < 0xad) ||
    (cp >= 0x370 && cp < 0x590) || // Greek, Cyrillic, Armenian; right-to-left scripts and Indic marks left out
    (cp >= 0x1e00 && cp < 0x2000) ||
    (cp >= 0x2010 && cp < 0x2028) ||
    (cp >= 0x2030 && cp < 0x2060) ||
    (cp >= 0x2070 && cp < 0x2329) ||
    (cp > 0x232a && cp < 0x2c00)
  return inRange && !NOT_ONE_COLUMN.test(String.fromCharCode(cp))
}

export type Frame = { columns: number; rows: number; cells: string }

type Cell = readonly [number, number]

/** The row an edge meets a card on: its title row. */
const edgeRow = (b: { y: number }) => b.y + 1

/** Lanes the message arcs spread over, right of the furthest card; further messages share a lane. */
const ARC_LANES = 6

type Painter = {
  put: (x: number, y: number, ch: number, f: number, b?: number) => void
  text: (x: number, y: number, s: string, f: number, max: number, b?: number) => number
}

const painter = (columns: number, rows: number, glyph: Uint32Array, fg: Uint32Array, bg: Uint32Array): Painter => {
  const put: Painter['put'] = (x, y, ch, f, b) => {
    if (x < 0 || y < 0 || x >= columns || y >= rows) return
    const i = y * columns + x
    glyph[i] = ch
    fg[i] = f
    if (b !== undefined) bg[i] = b
  }
  // Text longer than `max` ends in `…`; what a cell cannot hold becomes one `?` per run.
  const text: Painter['text'] = (x, y, s, f, max, b) => {
    if (max <= 0) return 0
    let cps: number[] = []
    let replaced = false
    for (const ch of s.normalize('NFC')) {
      if (DROPPED.test(ch)) continue
      const cp = ch.codePointAt(0) ?? 0x3f
      if (isCellChar(cp)) {
        cps.push(cp)
        replaced = false
      } else if (!replaced) {
        cps.push(0x3f)
        replaced = true
      }
    }
    if (cps.length > max) cps = [...cps.slice(0, max - 1), 0x2026]
    cps.forEach((cp, n) => put(x + n, y, cp, f, b))
    return cps.length
  }
  return { put, text }
}

/** The part of a frame that only changes with the graph's shape and statuses: lines, arrows, dot paths. */
type StaticLayer = { key: string; glyph: Uint32Array; fg: Uint32Array; dirs: Uint8Array; moving: { path: Cell[]; color: number }[] }

let staticLayer: StaticLayer | null = null

/** What the static layer depends on: placement, parents, which agents run, and the message pairs. */
const staticKey = (g: SessionGraph, layout: Layout) => {
  let key = `${layout.columns}x${layout.rows}`
  for (const b of layout.boxes) {
    const a = g.agents[b.id]
    key += `\n${b.id},${b.x},${b.y},${b.w},${a?.parentId ?? ''},${a?.status === 'running' ? a.kind : ''}`
  }
  for (const m of g.messages) key += `\n${m.from}>${m.to}`
  return key
}

const buildStatic = (g: SessionGraph, layout: Layout, key: string): StaticLayer => {
  const { columns, rows } = layout
  const size = columns * rows
  const glyph = new Uint32Array(size).fill(0x20)
  const fg = new Uint32Array(size).fill(DEFAULT)
  // The line layer: directions per cell, its colour, and the rank that decides whose colour wins.
  const dirs = new Uint8Array(size)
  const lineColor = new Uint32Array(size)
  const lineRank = new Uint8Array(size)
  const dashed = new Uint8Array(size)

  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < columns && y < rows
  const { put } = painter(columns, rows, glyph, fg, new Uint32Array(0))
  const mark = (x: number, y: number, d: number, color: number, rank: number) => {
    if (!inside(x, y)) return
    const i = y * columns + x
    dirs[i]! |= d
    if (rank >= lineRank[i]!) {
      lineRank[i] = rank
      lineColor[i] = color
    }
  }
  /** A horizontal run of line cells, joined to its neighbours; returns the cells left to right. */
  const hline = (x0: number, x1: number, y: number, color: number, rank: number): Cell[] => {
    const cells: Cell[] = []
    const [a, b] = x0 <= x1 ? [x0, x1] : [x1, x0]
    for (let x = a; x <= b; x++) {
      mark(x, y, (x > a ? L : 0) | (x < b ? R : 0), color, rank)
      cells.push([x, y])
    }
    return x0 <= x1 ? cells : cells.reverse()
  }
  const vline = (x: number, y0: number, y1: number, color: number, rank: number): Cell[] => {
    const cells: Cell[] = []
    const [a, b] = y0 <= y1 ? [y0, y1] : [y1, y0]
    for (let y = a; y <= b; y++) {
      mark(x, y, (y > a ? U : 0) | (y < b ? D : 0), color, rank)
      cells.push([x, y])
    }
    return y0 <= y1 ? cells : cells.reverse()
  }
  /** Joins the corner cell of two runs, so ─ meeting │ becomes ╮, ├ or ┼. */
  const joinAt = (x: number, y: number, d: number, color: number, rank: number) => mark(x, y, d, color, rank)

  const boxOf = new Map(layout.boxes.map(b => [b.id, b]))
  const moving: { path: Cell[]; color: number }[] = []

  // ---- tree edges: parent ─┬─ trunk ├──▸ child ------------------------------------------------
  const children = new Map<string, Box[]>()
  for (const b of layout.boxes) {
    const a = g.agents[b.id]
    if (!a?.parentId || !boxOf.has(a.parentId)) continue
    children.set(a.parentId, [...(children.get(a.parentId) ?? []), b])
  }
  for (const [parentId, kids] of children) {
    const p = boxOf.get(parentId)!
    const py = edgeRow(p)
    const right = p.x + p.w
    // The trunk sits midway between the parent's column and its children's.
    const childX = Math.min(...kids.map(k => k.x))
    const trunkX = right + Math.max(1, Math.floor((childX - right - 1) / 2))
    const ys = kids.map(edgeRow)
    const top = Math.min(py, ...ys)
    const bottom = Math.max(py, ...ys)
    const base = COLORS.edge
    hline(right, trunkX, py, base, 1)
    vline(trunkX, top, bottom, base, 1)
    joinAt(trunkX, py, L, base, 1)
    for (const k of kids) {
      const a = g.agents[k.id]!
      const ky = edgeRow(k)
      const isHot = a.status === 'running'
      const color = isHot ? KIND_COLOR[a.kind] : base
      const rank = isHot ? 3 : 1
      // A running child lights its own way back to the parent.
      const stub = hline(right, trunkX - 1, py, isHot ? color : base, isHot ? 2 : 1)
      const trunk = vline(trunkX, py, ky, isHot ? color : base, isHot ? 2 : 1)
      const branch = hline(trunkX, k.x - 2, ky, color, rank)
      joinAt(trunkX, ky, R, color, rank)
      put(k.x - 1, ky, ARROW, color)
      if (isHot) moving.push({ path: [...stub, ...trunk.slice(1), ...branch.slice(1)], color })
    }
  }

  // ---- messages between agents: a dashed loop in its own column right of the furthest card ----------
  const maxRight = Math.max(0, ...layout.boxes.map(b => b.x + b.w))
  let lane = 0
  for (const m of g.messages) {
    const from = boxOf.get(m.from)
    const to = boxOf.get(m.to)
    // Between a parent and its child the tree edge already joins them.
    if (!from || !to || g.agents[m.from]?.parentId === m.to || g.agents[m.to]?.parentId === m.from) continue
    const x = maxRight + 1 + (lane++ % ARC_LANES)
    const fy = from.y + 2
    const ty = to.y + 2
    const color = KIND_COLOR.teammate
    for (const [cx, cy] of [...hline(from.x + from.w, x, fy, color, 1), ...vline(x, fy, ty, color, 1), ...hline(x, to.x + to.w + 1, ty, color, 1)]) {
      if (inside(cx, cy)) dashed[cy * columns + cx] = 1
    }
    joinAt(x, fy, L, color, 1)
    joinAt(x, ty, L, color, 1)
    put(to.x + to.w, ty, ARROW_BACK, color)
  }

  for (let i = 0; i < size; i++) {
    const d = dirs[i]!
    if (!d || glyph[i] !== 0x20) continue
    const straightH = d === (L | R) || d === L || d === R
    const straightV = d === (U | D) || d === U || d === D
    glyph[i] = dashed[i] && straightH ? DASH_H : dashed[i] && straightV ? DASH_V : (GLYPH[d] ?? 0x253c)
    fg[i] = lineColor[i]!
  }

  return { key, glyph, fg, dirs, moving }
}

export const renderFrame = (g: SessionGraph, layout: Layout, now: number, phase: number): Frame => {
  const { columns, rows } = layout
  const size = columns * rows
  const key = staticKey(g, layout)
  if (staticLayer?.key !== key) staticLayer = buildStatic(g, layout, key)
  const { dirs, moving } = staticLayer
  // Per tick only what moves is drawn over a copy of the static layer: cards (time, spinner, glow),
  // uses and the dots.
  const glyph = staticLayer.glyph.slice()
  const fg = staticLayer.fg.slice()
  const bg = new Uint32Array(size).fill(DEFAULT)
  const { put, text } = painter(columns, rows, glyph, fg, bg)
  const inside = (x: number, y: number) => x >= 0 && y >= 0 && x < columns && y < rows

  // ---- cards, their uses and the harness card over the lines ---------------------------------------
  for (const b of layout.boxes) {
    const a = g.agents[b.id]
    if (!a) continue
    drawCard(a, b, now, phase, put, text)
    if (b.uses > 0) drawUses(a, b, now, put, text)
  }
  if (layout.harness && g.harness) drawHarness(g.harness, layout.harness, put, text)

  // ---- a dot on each lit path -----------------------------------------------------------------------
  moving.forEach((m, k) => {
    if (m.path.length < 2) return
    const at = m.path[(phase * DOT_STEP + k * 3) % m.path.length]!
    const i = at[1] * columns + at[0]
    if (inside(at[0], at[1]) && dirs[i] && (glyph[i] === GLYPH[dirs[i]!] || glyph[i] === DASH_H || glyph[i] === DASH_V)) put(at[0], at[1], DOT, m.color)
  })

  const words = new Uint32Array(size * 3)
  for (let i = 0; i < size; i++) {
    words[i * 3] = glyph[i]!
    words[i * 3 + 1] = fg[i]!
    words[i * 3 + 2] = bg[i]!
  }
  return { columns, rows, cells: toBase64(new Uint8Array(words.buffer)) }
}

/**
 * Cuts a frame into Rasters of at most `tileRows` rows each, stacked top to bottom. A row is
 * `columns` triplets of 12 bytes, a multiple of 3, so each row is exactly `columns * 16` base64
 * characters and the encoded string splits at row boundaries without re-encoding.
 */
export const splitFrame = (frame: Frame, tileRows = TILE_ROWS): Frame[] => {
  if (frame.rows <= tileRows) return [frame]
  const rowChars = frame.columns * 16
  const tiles: Frame[] = []
  for (let top = 0; top < frame.rows; top += tileRows) {
    const rows = Math.min(tileRows, frame.rows - top)
    tiles.push({ columns: frame.columns, rows, cells: frame.cells.slice(top * rowChars, (top + rows) * rowChars) })
  }
  return tiles
}

const B64 = new Uint8Array('ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'.split('').map(c => c.charCodeAt(0)))
/** Characters per String.fromCharCode call: below the engines' argument limit. */
const CHUNK = 8192

/** Standard padded base64, the encoding RasterProps.cells takes. */
export const toBase64 = (bytes: Uint8Array) => {
  const out = new Uint8Array(Math.ceil(bytes.length / 3) * 4)
  const full = bytes.length - (bytes.length % 3)
  let o = 0
  for (let i = 0; i < full; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!
    out[o++] = B64[n >> 18]!
    out[o++] = B64[(n >> 12) & 63]!
    out[o++] = B64[(n >> 6) & 63]!
    out[o++] = B64[n & 63]!
  }
  const rest = bytes.length - full
  if (rest > 0) {
    const n = (bytes[full]! << 16) | ((rest > 1 ? bytes[full + 1]! : 0) << 8)
    out[o++] = B64[n >> 18]!
    out[o++] = B64[(n >> 12) & 63]!
    out[o++] = rest > 1 ? B64[(n >> 6) & 63]! : 0x3d
    out[o++] = 0x3d
  }
  let str = ''
  for (let i = 0; i < out.length; i += CHUNK) str += String.fromCharCode.apply(null, out.subarray(i, i + CHUNK) as unknown as number[])
  return str
}

type Put = (x: number, y: number, ch: number, f: number, b?: number) => void
type Text = (x: number, y: number, s: string, f: number, max: number, b?: number) => number

/** A rounded frame of `w` × `h` cells. */
const frame = (x: number, y: number, w: number, h: number, color: number, put: Put) => {
  put(x, y, 0x256d, color) // ╭
  put(x + w - 1, y, 0x256e, color) // ╮
  put(x, y + h - 1, 0x2570, color) // ╰
  put(x + w - 1, y + h - 1, 0x256f, color) // ╯
  for (let i = x + 1; i < x + w - 1; i++) {
    put(i, y, 0x2500, color)
    put(i, y + h - 1, 0x2500, color)
  }
  for (let j = y + 1; j < y + h - 1; j++) {
    put(x, j, 0x2502, color)
    put(x + w - 1, j, 0x2502, color)
    for (let i = x + 1; i < x + w - 1; i++) put(i, j, 0x20, DEFAULT)
  }
}

/** How a use reads under its card: `Bash ×17`, `skill commit`, `mcp context7 ×2`, `rule CLAUDE.md`. */
export const useLabel = (u: Use) => useParts(u).join('')

/** A use's name and its `×N` suffix: a long name is cut before the suffix, never the suffix itself. */
const useParts = (u: Use): [string, string] => {
  const count = u.calls > 1 || u.kind === 'tool' || u.kind === 'mcp' ? ` ×${u.calls}` : ''
  return [`${u.kind === 'tool' ? '' : `${u.kind} `}${u.label}`, u.kind === 'rule' ? '' : count]
}

/** The list under a card: one `├▸` row per use, in first-use order, filled while the agent runs it. */
const drawUses = (a: AgentNode, b: Box, now: number, put: Put, text: Text) => {
  // Beyond MAX_USES the rest fold into one row; the bottom of the drawing (MAX_ROWS) can cut the list short too.
  const all = agentUses(a, now)
  const rows: (Use | number)[] = all.length > MAX_USES ? [...all.slice(0, MAX_USES), all.length - MAX_USES] : all
  const shown = rows.slice(0, b.uses)
  const spine = cardBorder(a)
  const x = b.x + 2
  const room = Math.max(1, b.x + b.w - (x + 3))
  // The list hangs from the card's bottom border.
  put(x, b.y + b.h - 1, 0x252c, spine) // ┬
  shown.forEach((r, i) => {
    const y = b.y + b.h + i
    const isLast = i === shown.length - 1
    put(x, y, isLast ? 0x2570 : 0x251c, typeof r === 'number' || !r.isActive ? spine : USE_COLOR[r.kind]) // ╰ ├
    if (typeof r === 'number') {
      put(x + 1, y, ARROW, COLORS.dim)
      text(x + 3, y, `+${r} more`, COLORS.dim, room)
      return
    }
    const color = USE_COLOR[r.kind]
    put(x + 1, y, ARROW, color)
    const lit = r.isActive
    const avail = room - (lit ? 2 : 0)
    const [name, suffix] = useParts(r)
    const label = name.length + suffix.length > avail && avail > suffix.length + 1 ? `${name.slice(0, avail - suffix.length - 1)}…${suffix}` : name + suffix
    text(x + 3, y, lit ? ` ${label} ` : label, lit ? COLORS.ink : color, room, lit ? color : undefined)
  })
}

/** The harness card: one line per kind, its name in that kind's colour. */
const drawHarness = (h: Harness, box: HarnessBox, put: Put, text: Text) => {
  frame(box.x, box.y, box.w, box.h, COLORS.dim, put)
  const inner = box.w - 4
  const x = box.x + 2
  const used = text(x, box.y + 1, 'harness', DEFAULT, inner)
  text(x + used + 1, box.y + 1, 'configured · loaded', COLORS.dim, inner - used - 1)
  const head: Record<string, number> = { rules: USE_COLOR.rule, hooks: COLORS.warn, skills: USE_COLOR.skill, mcp: USE_COLOR.mcp, agents: KIND_COLOR.subagent }
  harnessLines(h).forEach((line, i) => {
    const name = line.split(' ')[0]!
    const n = text(x, box.y + 2 + i, name, head[name] ?? DEFAULT, inner)
    text(x + n, box.y + 2 + i, line.slice(name.length), DEFAULT, inner - n)
  })
}

/** A card's border: amber while it asks the person, its kind's colour while it runs, quieter after. */
const cardBorder = (a: AgentNode) => (needsYou(a) ? COLORS.warn : a.status === 'running' ? KIND_COLOR[a.kind] : KIND_DIM[a.kind])

const drawCard = (a: AgentNode, b: Box, now: number, phase: number, put: Put, text: Text) => {
  const asking = needsYou(a)
  const border = cardBorder(a)
  frame(b.x, b.y, b.w, b.h, border, put)

  const inner = b.w - 4
  const x = b.x + 2
  // Title row: label, model, and the time on the right when it fits.
  const time = a.startedAt > 0 ? formatElapsed((a.endedAt ?? now) - a.startedAt) : ''
  const labelMax = Math.max(4, inner - (time ? time.length + 1 : 0))
  let used = text(x, b.y + 1, a.label, a.status === 'pending' ? COLORS.dim : DEFAULT, labelMax)
  const model = shortModel(a.model)
  // The model is shown whole or not at all.
  if (model && used + 1 + model.length <= labelMax) used += 1 + text(x + used + 1, b.y + 1, model, COLORS.dim, model.length)
  if (time && used + 1 + time.length <= inner) text(x + inner - time.length, b.y + 1, time, COLORS.dim, time.length)

  // Status row: what it does now, and its tokens on the right.
  const status = asking
    ? '! needs you'
    : a.status === 'running'
      ? `${SPINNER[phase % SPINNER.length]} ${a.currentTool ?? (a.kind === 'main' ? 'working' : 'running')}`
      : (STATUS_TEXT as Record<string, string | undefined>)[a.status] ?? `? ${a.status}`
  const color = asking ? COLORS.warn : a.status === 'running' ? KIND_COLOR[a.kind] : (STATUS_COLOR[a.status] ?? COLORS.dim)
  const tokens = a.tokens ? formatTokens(a.tokens) : ''
  const statusMax = Math.max(4, inner - (tokens ? tokens.length + 1 : 0))
  text(x, b.y + 2, status, color, statusMax)
  if (tokens && inner >= statusMax + tokens.length) text(x + inner - tokens.length, b.y + 2, tokens, COLORS.dim, tokens.length)
}
