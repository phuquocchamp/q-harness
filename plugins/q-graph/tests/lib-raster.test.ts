import { expect, test } from 'claude-code/testing'

import { emptyGraph, harnessFrom, messageSent, setHarness, spawnAgent, toolFinished, toolStarted, turnEnded } from '../hooks/lib/graph'
import { CARD_H, MAX_ROWS, TILE_ROWS, layoutGraph } from '../hooks/lib/layout'
import { COLORS, DEFAULT, renderFrame, splitFrame, toBase64 } from '../hooks/lib/raster'

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/'

/** Decodes RasterProps.cells back to [codePoint, fg, bg] triplets. */
const decode = (cells: string) => {
  const clean = cells.replace(/=+$/, '')
  const bytes: number[] = []
  for (let i = 0; i < clean.length; i += 4) {
    const n = [0, 1, 2, 3].reduce((acc, k) => (acc << 6) | (k < clean.length - i ? B64.indexOf(clean[i + k]!) : 0), 0)
    bytes.push((n >> 16) & 255, (n >> 8) & 255, n & 255)
  }
  const words: number[] = []
  for (let i = 0; i + 3 < bytes.length; i += 4) words.push((bytes[i]! | (bytes[i + 1]! << 8) | (bytes[i + 2]! << 16) | (bytes[i + 3]! << 24)) >>> 0)
  return words
}

const sample = () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', model: 'claude-haiku-5-5', description: 'x' }, 0)
  g = spawnAgent(g, { id: 'a2', type: 'Plan', model: 'claude-sonnet-5-5', description: 'y' }, 0)
  g = spawnAgent(g, { id: 'a3', parentId: 'a1', type: 'Explore', description: 'nested' }, 0)
  return turnEnded(g, 'a2', { tokens: 14_700, reason: 'answer' }, 20_000)
}

test('toBase64 matches the standard padded encoding', () => {
  const enc = (s: string) => toBase64(new TextEncoder().encode(s))
  expect(enc('')).toBe('')
  expect(enc('f')).toBe('Zg==')
  expect(enc('fo')).toBe('Zm8=')
  expect(enc('foo')).toBe('Zm9v')
  expect(enc('Raster')).toBe('UmFzdGVy')
  // Past one chunk of the encoder, against the reference encoder.
  const big = Uint8Array.from({ length: 20_000 }, (_, i) => (i * 7 + 3) & 255)
  expect(toBase64(big)).toBe(btoa(String.fromCharCode(...big)))
})

test('the tree is laid out one column per depth, each first child level with its parent', () => {
  const layout = layoutGraph(sample(), 120)
  const at = (id: string) => layout.boxes.find(b => b.id === id)!
  expect(at('main').depth).toBe(0)
  expect(at('a1').depth).toBe(1)
  expect(at('a3').depth).toBe(2)
  expect(at('a3').x).toBeGreaterThan(at('a1').x)
  expect(at('a1').y).toBe(at('a3').y)
  expect(at('main').y).toBe(at('a1').y)
  expect(at('a2').y).toBe(at('a3').y + CARD_H + 1)
  expect(layout.rows).toBe(at('a2').y + CARD_H)
  expect(layout.columns).toBeLessThanOrEqual(120)
  expect(layout.harness).toBeNull()
})

test("an agent's uses take rows under its card, and the next agent starts below them", () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', description: '' }, 0)
  g = spawnAgent(g, { id: 'a2', type: 'Plan', description: '' }, 0)
  for (const t of ['Grep', 'Read', 'Glob']) g = toolFinished(toolStarted(g, 'a1', t, 0), 'a1', t, 0)
  for (const t of ['A', 'B', 'C', 'D', 'E', 'F', 'G']) g = toolFinished(toolStarted(g, 'a2', t, 0), 'a2', t, 0)
  const layout = layoutGraph(g, 120)
  const at = (id: string) => layout.boxes.find(b => b.id === id)!
  expect(at('a1').uses).toBe(3)
  expect(at('a2').uses).toBe(7) // every use has its own row, none folded
  expect(at('a2').y).toBe(at('a1').y + CARD_H + 3 + 1)
  expect(layout.rows).toBe(at('a2').y + CARD_H + 7)
  expect(layout.hidden).toBe(0)
})

test('a frame has one triplet per cell, framed cards and box-drawing edges', () => {
  const g = sample()
  const layout = layoutGraph(g, 120)
  const frame = renderFrame(g, layout, 20_000, 3)
  const words = decode(frame.cells)
  expect(words.length).toBe(frame.columns * frame.rows * 3)

  const cell = (x: number, y: number) => {
    const i = (y * frame.columns + x) * 3
    return { cp: words[i]!, fg: words[i + 1]!, bg: words[i + 2]! }
  }
  const plan = layout.boxes.find(b => b.id === 'a2')!
  expect(String.fromCharCode(cell(plan.x + 2, plan.y + 1).cp)).toBe('P')
  expect(String.fromCharCode(cell(plan.x, plan.y).cp)).toBe('╭')
  // Text takes the terminal's own colour, so it reads on light and dark terminals.
  expect(cell(plan.x + 2, plan.y + 1).fg).toBe(DEFAULT)
  expect(String.fromCharCode(cell(plan.x - 1, plan.y + 1).cp)).toBe('▸')
  expect(String.fromCharCode(cell(plan.x + 2, plan.y + 2).cp)).toBe('✓')

  const cps = Array.from({ length: frame.columns * frame.rows }, (_, i) => words[i * 3]!)
  expect(cps.some(cp => cp === 0x251c || cp === 0x256d || cp === 0x2570)).toBe(true) // ├ ╭ ╰ of the trunk
  expect(cps.some(cp => cp >= 0x2800 && cp <= 0x28ff)).toBe(false)
  // Every glyph is one printable, one-column BMP character.
  expect(cps.every(cp => cp >= 0x20 && cp <= 0xffff)).toBe(true)
})

test('text a cell cannot hold is replaced, so the frame is never refused', () => {
  // Astral emoji, CJK, BMP emoji drawn wide (⌚ ✅ ❌ ⭐ ☕), a combining mark, a soft hyphen, Hebrew.
  const g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'E🚀探⌚✅❌⭐☕a\u0301\u00ad\u05d0', description: '' }, 0)
  const frame = renderFrame(g, layoutGraph(g, 80), 0, 0)
  const cps = new Set(decode(frame.cells).filter((_, i) => i % 3 === 0))
  for (const bad of [0x1f680, 0x63a2, 0x231a, 0x2705, 0x274c, 0x2b50, 0x2615, 0x301, 0xad, 0x5d0]) expect(cps.has(bad)).toBe(false)
  expect(cps.has(0x45)).toBe(true) // the E survives
})

/** The text of row `y` from column x0 up to x1. */
const rowOf = (words: number[], columns: number, y: number, x0: number, x1: number) =>
  Array.from({ length: x1 - x0 }, (_, k) => String.fromCharCode(words[(y * columns + x0 + k) * 3]!)).join('')

test('each agent lists its own uses under its card, filled while it runs one', () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', description: '' }, 0)
  g = spawnAgent(g, { id: 'a2', type: 'Plan', description: '' }, 0)
  g = toolFinished(toolStarted(g, 'a1', 'Grep', 0), 'a1', 'Grep', 0)
  g = toolFinished(toolStarted(g, 'a1', 'Grep', 0), 'a1', 'Grep', 0)
  g = toolStarted(g, 'a1', 'Read', 9000)
  g = toolFinished(toolStarted(g, 'a2', 'Grep', 0), 'a2', 'Grep', 0)
  g = toolFinished(toolStarted(g, 'a2', 'Skill', 0, 'skill:commit'), 'a2', 'Skill', 0, 'skill:commit')
  g = toolFinished(toolStarted(g, 'a2', 'mcp__context7__query-docs', 0, 'mcp:context7'), 'a2', 'mcp__context7__query-docs', 0, 'mcp:context7')
  const layout = layoutGraph(g, 120)
  const frame = renderFrame(g, layout, 9500, 0)
  const words = decode(frame.cells)
  const lines = (id: string) => {
    const b = layout.boxes.find(x => x.id === id)!
    return Array.from({ length: b.uses }, (_, i) => rowOf(words, frame.columns, b.y + b.h + i, b.x, b.x + b.w).trim())
  }
  // Both agents called Grep: each card has its own Grep row with its own count.
  expect(lines('a1')).toEqual(['├▸ Grep ×2', '╰▸  Read ×1'])
  expect(lines('a2')).toEqual(['├▸ Grep ×1', '├▸ skill commit', '╰▸ mcp context7 ×1'])
  const a1 = layout.boxes.find(x => x.id === 'a1')!
  const bgAt = (x: number, y: number) => words[(y * frame.columns + x) * 3 + 2]
  expect(bgAt(a1.x + 5, a1.y + a1.h + 1)).not.toBe(bgAt(a1.x + 5, a1.y + a1.h)) // Read runs, Grep is idle
  expect(String.fromCharCode(words[((a1.y + a1.h - 1) * frame.columns + a1.x + 2) * 3]!)).toBe('┬')
})

test('every use is listed under its card, in first-use order, with no `+N more` row', () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', description: '' }, 0)
  const names = ['A', 'B', 'C', 'D', 'E', 'F', 'G', 'H', 'I']
  names.forEach((t, i) => (g = toolFinished(toolStarted(g, 'a1', t, i * 100), 'a1', t, i * 100)))
  const layout = layoutGraph(g, 120)
  const frame = renderFrame(g, layout, 60_000, 0)
  const words = decode(frame.cells)
  const b = layout.boxes.find(x => x.id === 'a1')!
  const lines = Array.from({ length: b.uses }, (_, i) => rowOf(words, frame.columns, b.y + b.h + i, b.x, b.x + b.w).trim())
  expect(lines).toEqual(names.map((t, i) => `${i === names.length - 1 ? '╰' : '├'}▸ ${t} ×1`))
  expect(lines.some(l => l.includes('more'))).toBe(false)
})

test('a tree taller than one Raster is split into stacked tiles that hold every row', () => {
  let g = emptyGraph(0)
  // 40 agents with 6 uses each: 40 × (4 + 6 + 1) rows, well past one Raster's 256.
  for (let i = 0; i < 40; i++) {
    g = spawnAgent(g, { id: `a${i}`, type: `agent-${i}`, description: '' }, 0)
    for (const t of ['A', 'B', 'C', 'D', 'E', 'F']) g = toolFinished(toolStarted(g, `a${i}`, t, 0), `a${i}`, t, 0)
  }
  const layout = layoutGraph(g, 120)
  expect(layout.hidden).toBe(0)
  expect(layout.boxes.length).toBe(41) // main and all 40
  expect(layout.rows).toBeGreaterThan(TILE_ROWS)
  const frame = renderFrame(g, layout, 0, 0)
  const tiles = splitFrame(frame)
  expect(tiles.length).toBe(Math.ceil(frame.rows / TILE_ROWS))
  expect(tiles.every(t => t.rows <= TILE_ROWS && t.columns === frame.columns)).toBe(true)
  expect(tiles.reduce((n, t) => n + t.rows, 0)).toBe(frame.rows)
  // The tiles are the frame cut at row boundaries: decoding them in order gives the frame back.
  expect(tiles.flatMap(t => decode(t.cells))).toEqual(decode(frame.cells))
  // A frame that fits is one tile, unchanged.
  const small = renderFrame(sample(), layoutGraph(sample(), 120), 0, 0)
  expect(splitFrame(small)).toEqual([small])
})

test('agents past the tallest drawing are counted as hidden instead of dropped silently', () => {
  let g = emptyGraph(0)
  const n = Math.ceil(MAX_ROWS / (CARD_H + 1)) + 5
  for (let i = 0; i < n; i++) g = spawnAgent(g, { id: `a${i}`, type: 'Explore', description: '' }, 0)
  const layout = layoutGraph(g, 120)
  expect(layout.rows).toBeLessThanOrEqual(MAX_ROWS)
  expect(layout.hidden).toBeGreaterThan(0)
  expect(layout.boxes.length + layout.hidden).toBe(n + 1)
})

test('the harness card sits on top and lists what the session has configured or loaded', () => {
  const g = setHarness(sample(), harnessFrom({ hooks: { PreToolUse: [{ hooks: [{}] }] } }, { memoryFiles: [{ path: '/repo/CLAUDE.md' }], mcpTools: [{ serverName: 'context7' }], skills: { totalSkills: 9 } }))
  const layout = layoutGraph(g, 120)
  expect(layout.harness).toMatchObject({ x: 0, y: 0, h: 8 })
  expect(Math.min(...layout.boxes.map(b => b.y))).toBe(9)
  const frame = renderFrame(g, layout, 0, 0)
  const words = decode(frame.cells)
  const h = layout.harness!
  const text = Array.from({ length: h.h }, (_, y) => rowOf(words, frame.columns, y, h.x, h.x + h.w)).join('\n')
  for (const line of ['harness configured · loaded', 'rules 1: CLAUDE.md', 'hooks 1: PreToolUse 1', 'skills 9', 'mcp 1: context7', 'agents 0']) expect(text).toContain(line)
})

test('a message between siblings bows out right and stays inside the frame', () => {
  let g = spawnAgent(emptyGraph(0), { id: 't1', isTeammate: true, type: 'teammate', teammateId: 'a@x', description: '' }, 0)
  g = spawnAgent(g, { id: 't2', isTeammate: true, type: 'teammate', teammateId: 'b@x', description: '' }, 0)
  g = messageSent(g, 't1', 't2')
  const layout = layoutGraph(g, 120)
  const right = Math.max(...layout.boxes.map(b => b.x + b.w))
  const frame = renderFrame(g, layout, 0, 0)
  const words = decode(frame.cells)
  const dashedRight = Array.from({ length: frame.rows }, (_, y) => words[(y * frame.columns + right + 1) * 3]!).filter(cp => cp === 0x2506 || cp === 0x256e || cp === 0x256f)
  expect(dashedRight.length).toBeGreaterThan(0)
})

test('a running agent gets a moving dot on its edge at some phase', () => {
  const g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', description: '' }, 0)
  const layout = layoutGraph(g, 80)
  const hasDot = (phase: number) => decode(renderFrame(g, layout, 0, phase).cells).some((w, i) => i % 3 === 0 && w === 0x25cf)
  expect([0, 3, 6, 9, 12].some(hasDot)).toBe(true)
})

test("a use's branch takes its colour only while the agent runs it", () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', description: '' }, 0)
  g = toolFinished(toolStarted(g, 'a1', 'Grep', 0), 'a1', 'Grep', 0)
  const ambers = (graph: typeof g, now: number) => {
    const frame = renderFrame(graph, layoutGraph(graph, 120), now, 0)
    const words = decode(frame.cells)
    // Line glyphs in the tool colour.
    return Array.from({ length: frame.columns * frame.rows }, (_, i) => i).filter(i => words[i * 3 + 1] === COLORS.tool && words[i * 3]! >= 0x2500 && words[i * 3]! <= 0x257f).length
  }
  const idle = ambers(g, 60_000)
  const running = ambers(toolStarted(g, 'a1', 'Grep', 60_000), 60_100)
  expect(running).toBeGreaterThan(idle)
})

test('a model name is shown whole or not at all', () => {
  const g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'general-purpose', model: 'claude-opus-5-5', description: '' }, 0)
  const layout = layoutGraph(g, 40)
  const frame = renderFrame(g, layout, 84_000, 0)
  const words = decode(frame.cells)
  const b = layout.boxes.find(x => x.id === 'a1')!
  const row = Array.from({ length: b.w }, (_, k) => String.fromCharCode(words[((b.y + 1) * frame.columns + b.x + k) * 3]!)).join('')
  expect(row.includes('opu') && !row.includes('opus')).toBe(false)
})

const chain = (depth: number) => {
  let g = emptyGraph(0)
  for (let i = 1; i <= depth; i++) g = spawnAgent(g, { id: `a${i}`, parentId: i > 1 ? `a${i - 1}` : undefined, type: 'Explore', description: '' }, 0)
  return g
}

test('a deep tree does not outgrow the pane: columns shrink, then deeper levels are hidden', () => {
  const layout = layoutGraph(chain(4), 80)
  expect(layout.columns <= 80 || layout.hidden > 0).toBe(true)
  expect(layout.hidden).toBeGreaterThan(0)
  expect(layout.boxes.length + layout.hidden).toBe(5)
  // A tree that fits by narrowing the gap and cards is fully drawn.
  const fit = layoutGraph(chain(2), 80)
  expect(fit.hidden).toBe(0)
  expect(fit.columns).toBeLessThanOrEqual(80)
})

test('agents that main cannot reach, and the ones under a hidden parent, are counted as hidden', () => {
  const g = chain(3)
  // a1 and a2 point at each other; neither is reachable from main once a1's parent is a2.
  const cyc = { ...g, agents: { ...g.agents, a1: { ...g.agents.a1!, parentId: 'a2' }, a2: { ...g.agents.a2!, parentId: 'a1' } } }
  const layout = layoutGraph(cyc, 120)
  expect(layout.boxes.map(b => b.id)).toEqual(['main'])
  expect(layout.hidden).toBe(3)
  // 30 levels: placement is capped, the rest is hidden, and nothing overflows the stack.
  const deep = layoutGraph(chain(30), 4000)
  expect(deep.hidden).toBeGreaterThan(0)
  expect(deep.boxes.length + deep.hidden).toBe(31)
})

test('message arcs run in their own columns right of every card, one lane per pair', () => {
  let g = spawnAgent(emptyGraph(0), { id: 't1', isTeammate: true, type: 'teammate', teammateId: 'a@x', description: '' }, 0)
  g = spawnAgent(g, { id: 't2', isTeammate: true, type: 'teammate', teammateId: 'b@x', description: '' }, 0)
  g = spawnAgent(g, { id: 't3', isTeammate: true, type: 'teammate', teammateId: 'c@x', description: '' }, 0)
  g = messageSent(messageSent(g, 't1', 't2'), 't2', 't3')
  const layout = layoutGraph(g, 120)
  const right = Math.max(...layout.boxes.map(b => b.x + b.w))
  const frame = renderFrame(g, layout, 0, 0)
  const words = decode(frame.cells)
  const column = (x: number) => Array.from({ length: frame.rows }, (_, y) => words[(y * frame.columns + x) * 3]!)
  // Each pair's vertical run sits in a lane of its own.
  expect(column(right + 1).some(cp => cp === 0x2506)).toBe(true)
  expect(column(right + 2).some(cp => cp === 0x2506)).toBe(true)
  expect(frame.columns).toBeGreaterThan(right + 2)
})

test('marks and joiners are dropped, runs of unsupported characters become one `?`', () => {
  const g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'A\u200d\ufe0fB\u{1f680}\u{1f680}\u5bb6\u5bb6C', description: '' }, 0)
  const layout = layoutGraph(g, 80)
  const b = layout.boxes.find(x => x.id === 'a1')!
  const frame = renderFrame(g, layout, 0, 0)
  expect(rowOf(decode(frame.cells), frame.columns, b.y + 1, b.x + 2, b.x + 8)).toBe('AB?C  ')
})

test('cut text ends in an ellipsis, and a use keeps its `×N` suffix', () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'a-very-long-agent-name-indeed', description: '' }, 0)
  const tool = 'mcp__a_very_long_tool_name_that_does_not_fit'
  g = toolFinished(toolStarted(g, 'a1', tool, 0), 'a1', tool, 0)
  const layout = layoutGraph(g, 40)
  const b = layout.boxes.find(x => x.id === 'a1')!
  const frame = renderFrame(g, layout, 60_000, 0)
  const words = decode(frame.cells)
  expect(rowOf(words, frame.columns, b.y + 1, b.x + 2, b.x + b.w - 2)).toMatch(/…$/)
  expect(rowOf(words, frame.columns, b.y + b.h, b.x, b.x + b.w).trim()).toMatch(/…( ×1)$/)
})

test('a needs-you card says so in plain ASCII, and a lost agent has a status of its own', () => {
  let g = spawnAgent(emptyGraph(0), { id: 'a1', type: 'Explore', description: '' }, 0)
  g = toolStarted(g, 'a1', 'AskUserQuestion', 0)
  const asking = renderFrame(g, layoutGraph(g, 80), 0, 0)
  const cps = decode(asking.cells).filter((_, i) => i % 3 === 0)
  expect(cps.includes(0x26a0)).toBe(false)
  const b = layoutGraph(g, 80).boxes.find(x => x.id === 'a1')!
  expect(rowOf(decode(asking.cells), asking.columns, b.y + 2, b.x + 2, b.x + 13)).toBe('! needs you')
  const lost = { ...g, agents: { ...g.agents, a1: { ...g.agents.a1!, status: 'lost', currentTool: null, inFlight: [] } } } as unknown as typeof g
  const frame = renderFrame(lost, layoutGraph(lost, 80), 0, 0)
  expect(rowOf(decode(frame.cells), frame.columns, b.y + 2, b.x + 2, b.x + 8)).toContain('?')
})

test('the tool, warn and dim colours have 3:1 contrast on white', () => {
  const lum = (h: number) => {
    const [r, g, b] = [h >> 16, (h >> 8) & 255, h & 255].map(v => {
      const c = v / 255
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4
    })
    return 0.2126 * r! + 0.7152 * g! + 0.0722 * b!
  }
  for (const c of [COLORS.tool, COLORS.warn, COLORS.dim]) expect(1.05 / (lum(c) + 0.05)).toBeGreaterThanOrEqual(3)
})
