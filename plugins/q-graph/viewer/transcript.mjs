// q-graph node detail: reads a Claude Code transcript (JSONL) and builds what the viewer shows
// when a node is clicked, and the timeline of every agent's calls. Pure ESM for Node 18+ or Bun, no dependencies.
// A TranscriptIndex remembers how far it has read, so a 15 MB file is parsed once and each later
// request only reads the lines appended since.

import { closeSync, fstatSync, openSync, readSync } from 'node:fs'
import { dirname, resolve, sep } from 'node:path'

export const INPUT_CAP = 4000
export const OUTPUT_CAP = 8000
export const CALL_LIMIT = 50
export const TIMELINE_CALL_CAP = 5000
export const HINT_CAP = 120
export const PROMPT_CAP = 200
/** Calls kept per index; older ones are dropped (and counted in `dropped`). */
export const FULL_CALL_MAX = 2000
export const SLIM_CALL_MAX = TIMELINE_CALL_CAP
const PROMPT_MAX = 2000
const DEPTH_MAX = 8
/** Bytes of transcript parsed so far; lets a test tell a cache hit from a re-parse. */
export const stats = { bytesParsed: 0 }

const CHUNK = 4 * 1024 * 1024
const SPAWN_TOOLS = new Set(['Agent', 'Task'])

/** Mirrors hooks/lib/graph.ts `useKey`. */
export const useKeyOf = (tool, input) => {
  if (SPAWN_TOOLS.has(tool)) return null
  if (tool === 'Skill' && input && typeof input.skill === 'string' && input.skill) return `skill:${input.skill}`
  if (tool.startsWith('mcp__')) return `mcp:${tool.slice(5).split('__')[0] || tool}`
  return tool
}

export const cap = (s, n) => (s.length > n ? `${s.slice(0, n)}…(truncated, ${s.length} chars)` : s)

/** Whitespace collapsed to single spaces, at most `n` chars. */
const oneLine = (s, n) => {
  const t = String(s).replace(/\s+/g, ' ').trim()
  return t.length > n ? `${t.slice(0, n - 1)}…` : t
}

const str = v => (typeof v === 'string' ? v : '')
const baseName = p => p.split(/[\\/]/).filter(Boolean).pop() ?? p

/** One line telling calls of the same tool apart on the timeline. */
export const hintOf = (tool, input) => {
  const i = input && typeof input === 'object' ? input : {}
  let h = ''
  if (tool === 'Bash') h = str(i.command)
  else if (['Read', 'Edit', 'Write', 'NotebookEdit'].includes(tool)) h = baseName(str(i.file_path) || str(i.notebook_path))
  else if (tool === 'Grep' || tool === 'Glob') h = str(i.pattern)
  else if (tool === 'Skill') h = str(i.skill)
  else if (SPAWN_TOOLS.has(tool)) h = str(i.description)
  else if (tool === 'WebFetch') h = str(i.url)
  else if (tool === 'WebSearch') h = str(i.query)
  else if (tool.startsWith('mcp__')) h = tool.split('__').slice(2).join('__')
  return oneLine(h, HINT_CAP)
}

/** Every string inside a tool input capped; image blocks replaced. */
const capDeep = (v, n, depth = 0) => {
  if (typeof v === 'string') return cap(v, n)
  if (v && typeof v === 'object' && depth >= DEPTH_MAX) return '[nested]'
  if (Array.isArray(v)) return v.map(x => capDeep(x, n, depth + 1))
  if (v && typeof v === 'object') {
    if (v.type === 'image') return '[image]'
    const out = {}
    for (const [k, x] of Object.entries(v)) out[k] = capDeep(x, n, depth + 1)
    return out
  }
  return v
}

/** Text of a message content: a string, or blocks joined with newlines. */
const textOf = content => {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return content == null ? '' : JSON.stringify(content)
  return content
    .map(b => {
      if (typeof b === 'string') return b
      if (!b || typeof b !== 'object') return ''
      if (b.type === 'text') return b.text ?? ''
      if (b.type === 'image') return '[image]'
      if (b.type === 'tool_reference') return b.tool_name ?? ''
      return JSON.stringify(b)
    })
    .join('\n')
}

const emptyState = slim => ({
  slim,
  maxCalls: slim ? SLIM_CALL_MAX : FULL_CALL_MAX,
  dropped: 0,
  callBytes: 0,
  calls: new Map(),
  usage: new Map(),
  firstPrompt: null,
  lastPrompt: null,
  prompts: [],
  result: null,
  handback: null,
  model: null,
  startedAt: null,
  endedAt: null,
})

/** Applies one parsed JSONL record to the state. Unknown record types are ignored. */
const apply = (st, rec) => {
  if (!rec || typeof rec !== 'object') return
  const ts = typeof rec.timestamp === 'string' ? rec.timestamp : null
  if (ts && (rec.type === 'user' || rec.type === 'assistant')) {
    st.startedAt ??= ts
    st.endedAt = ts
  }
  const msg = rec.message
  if (!msg || typeof msg !== 'object') return

  if (rec.type === 'assistant') {
    if (typeof msg.model === 'string' && msg.model !== '<synthetic>') st.model = msg.model
    if (msg.usage && !st.slim) st.usage.set(msg.id ?? rec.uuid ?? st.usage.size, msg.usage)
    if (!Array.isArray(msg.content)) return
    for (const b of msg.content) {
      if (b?.type === 'text' && typeof b.text === 'string' && b.text.trim()) {
        if (!st.slim) st.result = b.text
      }
      else if (b?.type === 'tool_use' && typeof b.id === 'string' && !st.calls.has(b.id)) {
        const tool = String(b.name ?? '')
        // A background subagent hands its final report back through a tool call, not as text.
        if (!st.slim && tool === 'SubagentHandback' && typeof b.input?.message === 'string') st.handback = b.input.message
        const input = st.slim ? null : capDeep(b.input ?? null, INPUT_CAP)
        const call = {
          id: b.id,
          tool,
          useKey: useKeyOf(tool, b.input),
          hint: hintOf(tool, b.input),
          input,
          output: null,
          persisted: null,
          isError: false,
          startedAt: ts,
          endedAt: null,
          agentId: undefined,
          size: 200 + (input === null ? 0 : JSON.stringify(input).length),
        }
        st.calls.set(b.id, call)
        st.callBytes += call.size
        if (st.calls.size > st.maxCalls) {
          const [oldId, old] = st.calls.entries().next().value
          st.calls.delete(oldId)
          st.callBytes -= old.size
          st.dropped++
        }
      }
    }
    return
  }

  if (rec.type !== 'user') return
  const content = msg.content
  const results = Array.isArray(content) ? content.filter(b => b?.type === 'tool_result') : []
  if (results.length) {
    const tur = rec.toolUseResult && typeof rec.toolUseResult === 'object' ? rec.toolUseResult : null
    for (const r of results) {
      const call = st.calls.get(r.tool_use_id)
      if (!call) continue
      if (!st.slim) {
        call.output = cap(textOf(r.content), OUTPUT_CAP)
        call.size += call.output.length
        st.callBytes += call.output.length
      }
      call.isError = r.is_error === true
      call.endedAt = ts
      if (tur && results.length === 1) {
        if (typeof tur.persistedOutputPath === 'string') call.persisted = tur.persistedOutputPath
        if (SPAWN_TOOLS.has(call.tool) && typeof tur.agentId === 'string') call.agentId = tur.agentId
      }
    }
    return
  }
  if (rec.isMeta) return
  const text = textOf(content)
  if (!text.trim()) return
  if (!st.slim) st.firstPrompt ??= cap(text, OUTPUT_CAP)
  if (!text.trimStart().startsWith('<')) {
    if (!st.slim) st.lastPrompt = cap(text, OUTPUT_CAP)
    if (ts) {
      st.prompts.push({ at: ts, text: oneLine(text, PROMPT_CAP) })
      if (st.prompts.length > PROMPT_MAX) st.prompts.shift()
    }
  }
}

const isUnder = (path, root) => {
  const p = resolve(path)
  const r = resolve(root)
  return p.startsWith(r.endsWith(sep) ? r : r + sep)
}

/**
 * Incremental index of one transcript file. `root` bounds where persisted outputs may be read
 * from (the project dir); it defaults to the file's own folder.
 */
export class TranscriptIndex {
  constructor(file, { root = dirname(file), slim = false } = {}) {
    this.file = file
    this.root = root
    this.slim = slim
    this.offset = 0
    this.ino = null
    this.state = emptyState(slim)
  }

  /** Rough memory held by the parsed state, for cache budgeting. */
  approxBytes() {
    const st = this.state
    return 2048 + st.callBytes + st.prompts.length * 300 + (st.result?.length ?? 0) + (st.handback?.length ?? 0) + (st.slim ? 0 : 2 * OUTPUT_CAP)
  }

  /** Reads bytes appended since the last call. Returns false when the file is missing. */
  update() {
    let fd
    try {
      fd = openSync(this.file, 'r')
    } catch {
      return false
    }
    try {
      const { size, ino } = fstatSync(fd)
      // A shrunk file or a new inode (replaced by rotation) is read again from the start.
      if (size < this.offset || (this.ino !== null && ino !== this.ino)) {
        this.offset = 0
        this.state = emptyState(this.slim)
      }
      this.ino = ino
      let carry = Buffer.alloc(0)
      let pos = this.offset
      while (pos < size) {
        const buf = Buffer.allocUnsafe(Math.min(CHUNK, size - pos))
        const n = readSync(fd, buf, 0, buf.length, pos)
        if (n <= 0) break
        pos += n
        stats.bytesParsed += n
        const data = carry.length ? Buffer.concat([carry, buf.subarray(0, n)]) : buf.subarray(0, n)
        const nl = data.lastIndexOf(0x0a)
        if (nl < 0) {
          carry = data
          continue
        }
        this.parse(data.subarray(0, nl).toString('utf8'))
        // `data` always starts at `this.offset`: the carry is the unread tail of the last chunk.
        this.offset += nl + 1
        carry = data.subarray(nl + 1)
      }
      // A partial last line stays unread until its newline arrives.
      return true
    } finally {
      closeSync(fd)
    }
  }

  parse(text) {
    for (const line of text.split('\n')) {
      if (!line.trim()) continue
      let rec
      try {
        rec = JSON.parse(line)
      } catch {
        continue
      }
      apply(this.state, rec)
    }
  }

  /** The persisted file's text, read once, only when it lies under the root. */
  outputOf(call) {
    if (call.persisted && !call.persistedRead) {
      call.persistedRead = true
      try {
        if (isUnder(call.persisted, this.root)) {
          const fd = openSync(call.persisted, 'r')
          try {
            const size = fstatSync(fd).size
            const buf = Buffer.alloc(Math.min(size, OUTPUT_CAP))
            const n = readSync(fd, buf, 0, buf.length, 0)
            call.output = buf.toString('utf8', 0, n) + (size > n ? `…(truncated, ${size} bytes)` : '')
          } finally {
            closeSync(fd)
          }
        }
      } catch {
        // Keep the preview from the tool_result.
      }
    }
    return call.output
  }

  /** Builds the Detail object. `main` picks the latest real prompt instead of the first one. */
  detail({ id = 'main', use = null, main = id === 'main', limit = CALL_LIMIT } = {}) {
    const st = this.state
    const usage = { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 }
    for (const u of st.usage.values()) {
      usage.input += u.input_tokens ?? 0
      usage.output += u.output_tokens ?? 0
      usage.cacheCreate += u.cache_creation_input_tokens ?? 0
      usage.cacheRead += u.cache_read_input_tokens ?? 0
    }
    const calls = []
    const all = [...st.calls.values()]
    for (let i = all.length - 1; i >= 0 && calls.length < limit; i--) {
      const c = all[i]
      if (use && c.useKey !== use) continue
      const startMs = Date.parse(c.startedAt ?? '')
      const endMs = Date.parse(c.endedAt ?? '')
      calls.push({
        id: c.id,
        tool: c.tool,
        useKey: c.useKey,
        input: c.input,
        output: this.outputOf(c),
        isError: c.isError,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        durationMs: Number.isFinite(startMs) && Number.isFinite(endMs) ? endMs - startMs : null,
        ...(c.agentId ? { agentId: c.agentId } : {}),
      })
    }
    return {
      agent: {
        id,
        file: this.file,
        prompt: main ? st.lastPrompt : st.firstPrompt,
        result: st.handback ?? st.result,
        model: st.model,
        usage,
        startedAt: st.startedAt,
        endedAt: st.endedAt,
        toolCalls: st.calls.size + st.dropped,
      },
      calls,
    }
  }
}

/** The Detail returned when there is nothing to read. */
export const emptyDetail = (id, error) => ({
  agent: {
    id,
    file: null,
    prompt: null,
    result: null,
    model: null,
    usage: { input: 0, output: 0, cacheCreate: 0, cacheRead: 0 },
    startedAt: null,
    endedAt: null,
    toolCalls: 0,
  },
  calls: [],
  error,
})

const msOf = t => {
  const ms = Date.parse(t ?? '')
  return Number.isFinite(ms) ? ms : null
}
const earliest = (a, b) => (a == null ? b : b == null ? a : msOf(b) < msOf(a) ? b : a)
const latest = (a, b) => (a == null ? b : b == null ? a : msOf(b) > msOf(a) ? b : a)

/**
 * Builds the Timeline object. `main` is the main transcript's index; `subagents` are
 * `{ id, index, meta }` with `meta` the parsed agent-<id>.meta.json (or null).
 */
export const buildTimeline = ({ main, subagents = [], now = new Date().toISOString(), callCap = TIMELINE_CALL_CAP }) => {
  const sources = [{ id: 'main', index: main, meta: null }, ...subagents.filter(s => s.id !== 'main')]
  // Which lane holds each tool_use, and which Agent/Task call reported each child id.
  const owner = new Map()
  const spawnedBy = new Map()
  for (const s of sources) {
    for (const c of s.index.state.calls.values()) {
      owner.set(c.id, s.id)
      if (c.agentId) spawnedBy.set(c.agentId, { laneId: s.id, callId: c.id })
    }
  }

  const lanes = new Map()
  for (const s of sources) {
    const st = s.index.state
    const meta = s.meta && typeof s.meta === 'object' ? s.meta : {}
    let parentId = null
    let spawnCallId = null
    if (s.id !== 'main') {
      const via = typeof meta.toolUseId === 'string' ? owner.get(meta.toolUseId) : undefined
      const fallback = spawnedBy.get(s.id)
      if (via && via !== s.id) [parentId, spawnCallId] = [via, meta.toolUseId]
      else if (fallback && fallback.laneId !== s.id) [parentId, spawnCallId] = [fallback.laneId, fallback.callId]
      else parentId = 'main'
    }
    const name = str(meta.name)
    const team = str(meta.teamName)
    // A named background subagent has `name` too; only a team member is a teammate.
    const kind = s.id === 'main' ? 'main' : team || meta.taskKind === 'in_process_teammate' ? 'teammate' : 'subagent'
    const label =
      kind === 'main' ? 'main' : kind === 'teammate' ? (name && team ? `${name}@${team}` : name || team) : name || str(meta.agentType) || 'subagent'
    const all = [...st.calls.values()]
    const kept = all.length > callCap ? all.slice(all.length - callCap) : all
    lanes.set(s.id, {
      id: s.id,
      parentId,
      depth: 0,
      spawnCallId,
      kind,
      label,
      description: str(meta.description) || null,
      model: str(meta.model) || st.model,
      startedAt: st.startedAt,
      endedAt: st.endedAt,
      calls: kept.map(c => ({
        id: c.id,
        tool: c.tool,
        useKey: c.useKey,
        startedAt: c.startedAt,
        endedAt: c.endedAt,
        isError: c.isError,
        hint: c.hint ?? '',
        ...(c.agentId ? { agentId: c.agentId } : {}),
      })),
      truncated: st.dropped + all.length - kept.length,
      prompts: s.id === 'main' ? st.prompts : [],
    })
  }

  // A parent chain that loops back (bad meta) hangs off main instead.
  for (const lane of lanes.values()) {
    const seen = new Set([lane.id])
    for (let p = lane.parentId; p && p !== 'main'; p = lanes.get(p)?.parentId) {
      if (seen.has(p) || !lanes.has(p)) {
        lane.parentId = 'main'
        lane.spawnCallId = null
        break
      }
      seen.add(p)
    }
  }

  const children = new Map()
  for (const lane of lanes.values()) {
    if (!lane.parentId) continue
    if (!children.has(lane.parentId)) children.set(lane.parentId, [])
    children.get(lane.parentId).push(lane)
  }
  const byStart = (a, b) => (msOf(a.startedAt) ?? Infinity) - (msOf(b.startedAt) ?? Infinity) || (a.id < b.id ? -1 : 1)
  const ordered = []
  const walk = (lane, depth) => {
    lane.depth = depth
    ordered.push(lane)
    for (const c of (children.get(lane.id) ?? []).sort(byStart)) walk(c, depth + 1)
  }
  walk(lanes.get('main'), 0)

  let startedAt = null
  let endedAt = null
  for (const lane of ordered) {
    startedAt = earliest(startedAt, lane.startedAt)
    endedAt = latest(endedAt, lane.endedAt)
  }
  return { now, startedAt, endedAt, lanes: ordered }
}

/** The Timeline returned when there is nothing to read. */
export const emptyTimeline = (error, now = new Date().toISOString()) => ({ now, startedAt: null, endedAt: null, lanes: [], error })
