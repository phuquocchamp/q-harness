// Lays the agent tree out left to right in terminal cells: one column per depth, each agent on its
// own band of rows (its card, then the list of what it used), its first child level with it, and
// the session's harness card on top. Small enough not to need a layout library.

import type { SessionGraph } from '../../types'
import { MAIN, harnessLines } from './graph'

/** An agent's card; `uses` rows under it list what the agent used. */
export type Box = { id: string; x: number; y: number; w: number; h: number; depth: number; uses: number }

/** The harness card: what the session has configured or loaded. */
export type HarnessBox = { x: number; y: number; w: number; h: number }

/** `hidden`: agents the drawing could not place (too deep, past the room, MAX_COLUMNS or MAX_ROWS, or not reachable from main). */
export type Layout = { boxes: Box[]; harness: HarnessBox | null; columns: number; rows: number; hidden: number }

/** Rows of a card: its top border, the title row, the status row, its bottom border. */
export const CARD_H = 4
const ROW_GAP = 1
const COL_GAP = 8
/** The gap between columns shrinks to this before the cards do. */
const MIN_GAP = 4
/** Levels deeper than this are not placed; their agents count as hidden. */
const MAX_DEPTH = 25
const MIN_W = 18
const MAX_W = 32
/** The harness card is wider than an agent card when the pane has room: its lines list names. */
const HARNESS_W = 44
/** Columns past the furthest card that message arcs take (raster.ts: ARC_LANES lanes plus the gap). */
const ARC_ROOM = 8
/** The widest a Raster takes. */
export const MAX_COLUMNS = 512
/** The tallest one Raster takes: a taller drawing is split into stacked tiles (raster.ts splitFrame). */
export const TILE_ROWS = 256
/** The tallest drawing, across its tiles: a bound on memory for very large sessions. */
export const MAX_ROWS = TILE_ROWS * 16

/** Uses listed under one card before the rest fold into a `+N more` row: none fold, every use is listed (see README). */
export const MAX_USES = Number.POSITIVE_INFINITY

/** Rows the use list under a card takes: one per use up to MAX_USES, then one `+N more` row. */
export const useRows = (n: number) => (n > MAX_USES ? MAX_USES + 1 : n)

const compute = (g: SessionGraph, room: number): Layout => {
  const children = new Map<string, string[]>()
  const parentOf = new Map<string, string>()
  for (const id of g.order) {
    const a = g.agents[id]
    if (!a || id === MAIN) continue
    const parent = a.parentId && g.agents[a.parentId] ? a.parentId : MAIN
    parentOf.set(id, parent)
    const kids = children.get(parent)
    if (kids) kids.push(id)
    else children.set(parent, [id])
  }

  // Borders, the title row, one row per line.
  const harnessH = g.harness ? harnessLines(g.harness).length + 3 : 0
  const depthOf = new Map<string, number>()
  const ys = new Map<string, number>()
  const placed: string[] = []
  let cursor = harnessH > 0 ? harnessH + ROW_GAP : 0
  let maxDepth = 0
  // Pre-order, iterative: an agent takes the next free row and its first child sits level with it;
  // the band ends below whichever is lower, its own card and uses or its last descendant's.
  // Agents past MAX_DEPTH, in a parent cycle or never reached from main are not placed.
  type Frame = { id: string; y: number; own: number; kids: string[]; next: number }
  const stack: Frame[] = []
  const seen = new Set<string>()
  const enter = (id: string, depth: number) => {
    seen.add(id)
    depthOf.set(id, depth)
    placed.push(id)
    maxDepth = Math.max(maxDepth, depth)
    ys.set(id, cursor)
    const own = CARD_H + useRows(Object.keys(g.agents[id]?.tools ?? {}).length)
    stack.push({ id, y: cursor, own, kids: depth < MAX_DEPTH ? (children.get(id) ?? []) : [], next: 0 })
  }
  enter(MAIN, 0)
  while (stack.length > 0) {
    const f = stack[stack.length - 1]!
    const k = f.kids[f.next++]
    if (k === undefined) {
      cursor = Math.max(cursor, f.y + f.own + ROW_GAP)
      stack.pop()
    } else if (!seen.has(k)) enter(k, stack.length)
  }

  // Fit the levels into the room: the gap between columns shrinks first, then the cards; levels
  // that still do not fit are hidden.
  const levels = maxDepth + 1
  const widthAt = (gap: number) => Math.floor((room - gap * maxDepth) / levels)
  const gap = maxDepth > 0 && widthAt(COL_GAP) < MIN_W ? Math.max(MIN_GAP, Math.min(COL_GAP, Math.floor((room - MIN_W * levels) / maxDepth))) : COL_GAP
  const w = Math.max(MIN_W, Math.min(MAX_W, widthAt(gap)))
  const fitLevels = Math.max(1, Math.floor((room + gap) / (w + gap)))
  const drawn = new Set<string>()
  const boxes: Box[] = []
  // Parents first, so an agent under a hidden parent is hidden too.
  const boxFor = new Map<string, Box>()
  for (const id of placed) {
    const y = ys.get(id)!
    const depth = depthOf.get(id)!
    const x = depth * (w + gap)
    if (id !== MAIN && !drawn.has(parentOf.get(id) ?? MAIN)) continue
    if (depth >= fitLevels || y + CARD_H > MAX_ROWS || x + w > MAX_COLUMNS) continue
    const uses = Math.min(useRows(Object.keys(g.agents[id]?.tools ?? {}).length), MAX_ROWS - (y + CARD_H))
    drawn.add(id)
    boxFor.set(id, { id, x, y, w, h: CARD_H, depth, uses })
  }
  for (const id of g.order) {
    const b = boxFor.get(id)
    if (b) boxes.push(b)
  }
  const hidden = g.order.filter(id => g.agents[id] && !boxFor.has(id)).length
  const harness = harnessH > 0 ? { x: 0, y: 0, w: Math.min(MAX_COLUMNS, Math.max(w, Math.min(HARNESS_W, room))), h: harnessH } : null
  // Messages between siblings bow out to the right of their column.
  const arcRoom = g.messages.length > 0 ? ARC_ROOM : 0
  const right = [...boxes.map(b => b.x + b.w + arcRoom), ...(harness ? [harness.x + harness.w] : [])]
  const bottom = [...boxes.map(b => b.y + b.h + b.uses), ...(harness ? [harness.y + harness.h] : [])]
  const columns = Math.min(MAX_COLUMNS, Math.max(1, ...right))
  const rows = Math.min(MAX_ROWS, Math.max(1, ...bottom))
  return { boxes, harness, columns, rows, hidden }
}

const memo = new WeakMap<SessionGraph, { room: number; layout: Layout }>()

/** The layout of `g` in `room` columns; the same graph and room give the same Layout object. */
export const layoutGraph = (g: SessionGraph, room: number): Layout => {
  const hit = memo.get(g)
  if (hit && hit.room === room) return hit.layout
  const layout = compute(g, room)
  memo.set(g, { room, layout })
  return layout
}
