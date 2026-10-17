// q-graph: records every agent loop of the session (main, subagents, teammates) from the hooks,
// shows the live ones in a band above the prompt, warns when one waits for the person, and draws
// the whole tree in a pane: a terminal Raster with box-drawing edges, a dot on each running edge,
// under each agent what it used (tools, skills, MCP servers, rules), and the session's harness.
// Every hook and every helper that takes `$` lives in this file (the engine follows `$` only within
// one module); pure helpers are in ./lib.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, ThemeKey, Timer } from 'claude-code'

import type { AgentNode, GraphSettings, NodeStatus, SessionGraph } from '../types'
import {
  MAIN,
  describeAgents,
  emptyGraph,
  formatElapsed,
  formatTokens,
  harnessFrom,
  harnessLines,
  hasLiveAgents,
  needsYou,
  RECENT_MS,
  ASK_TOOLS,
  messageSent,
  promptSubmitted,
  resolveRecipient,
  rosterAgents,
  ruleLoaded,
  setHarness,
  spawnAgent,
  syncAgents,
  toolFinished,
  toolStarted,
  turnEnded,
  useKey,
  type Transition,
} from './lib/graph'
import { layoutGraph } from './lib/layout'
import { renderFrame, splitFrame } from './lib/raster'
import { DEFAULT_SETTINGS, USAGE, parseToggle, pickSettings, showSettings, unknownArg } from './lib/settings'

const graph = atom({ plugin: 'q-graph', key: 'graph' } as const, emptyGraph() as SessionGraph)
const settings = atom({ plugin: 'q-graph', key: 'settings' } as const, DEFAULT_SETTINGS as GraphSettings)
const webUrl = atom({ plugin: 'q-graph', key: 'webUrl' } as const, null as string | null)
/** The band lists every agent on wrapped rows instead of what fits one row (its `+N more` button). */
const bandAll = atom({ plugin: 'q-graph', key: 'bandAll' } as const, false as boolean)

const PANE = 'q-graph'
const SETTINGS_KEY = 'settings'
const POLL_MS = 1000
const FRAME_MS = 150
/** How often the live viewer's snapshot file is refreshed (only written when the graph changed). */
const WEB_MS = 300
/** How long a failed transcript lookup is remembered before the next try. */
const TRANSCRIPT_RETRY_MS = 5000
/** How long the viewer process may take to print its address. */
const WEB_START_MS = 8000
/** Runtimes tried in turn for the viewer process. */
const RUNTIMES = ['node', 'bun']
/** The system's "open this URL" commands, tried in order: macOS, Linux, Windows. */
const OPENERS = [['open'], ['xdg-open'], ['cmd', '/c', 'start', '""']]

// Kinds need hex (the theme has no kind colours): mid-luminance, readable on light and dark terminals.
// Status uses the host theme's keys, so it follows the terminal theme.
const KIND_HEX = { main: '#3969de', subagent: '#1f966f', teammate: '#a72f83' } as const
const STATUS_COLOR: Partial<Record<NodeStatus, ThemeKey>> = { completed: 'success', failed: 'error' }
const WARN_COLOR: ThemeKey = 'warning'
const SPINNER = '◐◓◑◒'

async function saveSettings($: EngineInterface, next: GraphSettings) {
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

function openPane($: EngineInterface) {
  return $.ui.open({ id: PANE, title: 'q-graph' })
}

/** The one-line state of an agent in the band. */
const bandStatus = (a: AgentNode, now: number) => {
  if (needsYou(a)) return `⚠ needs you ${formatElapsed(now - (a.waitingSince ?? now))}`
  if (a.status === 'running') return `${SPINNER[Math.floor(now / 1000) % SPINNER.length]} ${a.currentTool ?? formatElapsed(now - a.startedAt)}`
  if (a.status === 'waiting') return '⏸ waiting'
  if (a.status === 'completed') return `✓ ${formatElapsed((a.endedAt ?? now) - a.startedAt)}`
  if (a.status === 'failed') return '✗ failed'
  if (a.status === 'idle') return '○ idle'
  if (a.status === 'killed') return '■ stopped'
  if (a.status === 'lost') return '? lost'
  return '· starting'
}

// Module timers: a reload starts them over, and the engine cancels the old ones with the module.
let poll: Timer | null = null
/** Counts every ensurePoll call, so a tick can tell that one arrived while it ran. */
let pollWanted = 0
/** True while the sleep that redraws the band after the last finished chips expire is pending. */
let expiryPending = false
let frames: Timer | null = null
/** The pane's width at its last draw: the frames between draws lay the graph out for it. */
let paneRoom = 80
/** The cells last blitted, per tile: an unchanged tile is not sent again. */
let lastCells: string[] = []
let framesBusy = false

/** Shows a toast, and a native notification when that setting is on. Callers do not wait for it. */
function alert($: EngineInterface, a: AgentNode, text: string) {
  void (async () => {
    $.ui.toast(`q-graph: ${text}`, { timeoutMs: 8000 })
    if ((await read($, settings)).notify) await $.ui.notify(a.description ? `${text}: ${a.description}` : text, { title: 'q-graph' })
  })().catch(() => undefined)
}

/** Tells the person about an agent that failed; one first seen already failed is not news. */
function announce($: EngineInterface, g: SessionGraph, transitions: readonly Transition[]) {
  for (const t of transitions) {
    const a = g.agents[t.id]
    if (a && t.to === 'failed' && t.from !== null) alert($, a, `${a.label} failed`)
  }
}

/**
 * Reads what the session's harness holds for the harness card: the settings hooks, and from the
 * context the memory files, skills, MCP servers and custom agents. `summary` counts locally, so the
 * read sends no request.
 */
async function refreshHarness($: EngineInterface) {
  try {
    const [cfg, usage] = await Promise.all([$.settings.read(), $.session.usage({ breakdown: 'summary' })])
    const harness = harnessFrom(cfg as { hooks?: unknown }, usage.context.breakdown)
    await update($, graph, g => setHarness(g, harness))
  } catch {
    // The card keeps what it last read.
  }
}

/** The harness card as one status line: `harness · rules 2: CLAUDE.md, … · hooks 1 · …`. */
const harnessStatus = (g: SessionGraph) => (g.harness ? `harness · ${harnessLines(g.harness).join(' · ')}` : null)

/** Reads the engine's agent list once a second while agents are alive, for statuses no hook raises (waiting, idle). */
function ensurePoll($: EngineInterface) {
  pollWanted++
  if (poll) return
  let busy = false
  poll = $.clock.every(POLL_MS, async () => {
    // A tick that is still waiting on the list is not overlapped.
    if (busy) return
    busy = true
    const wanted = pollWanted
    try {
      const list = await $.agent.list()
      const now = await $.clock.now()
      // The sync runs inside the updater, so a retry after another hook's write works on that write.
      let transitions: Transition[] = []
      const after = await update($, graph, g => {
        const r = syncAgents(g, list, now)
        transitions = r.transitions
        return r.graph
      })
      announce($, after, transitions)
      const live = hasLiveAgents(after)
      // The band and the pane show elapsed time, so they redraw each tick while something is alive.
      if (live || transitions.length > 0) $.ui.invalidate('ui.render')
      // A spawn, a message or a tool call starts the poll again; one that arrived during this tick keeps it.
      if (!live && wanted === pollWanted) {
        poll?.cancel()
        poll = null
        expireChips($)
      }
    } catch {
      // A failed list read skips this tick; the next one tries again.
    } finally {
      busy = false
    }
  })
}

/** Redraws once the finished chips of the band have expired, which no poll is left to do. */
function expireChips($: EngineInterface) {
  if (expiryPending) return
  expiryPending = true
  void $.clock
    .sleep(RECENT_MS)
    .then(() => $.ui.invalidate('ui.render'))
    .catch(() => undefined)
    .finally(() => {
      expiryPending = false
    })
}

/** Repaints the pane's Raster in place while an agent runs, so the dots move without a redraw. */
function ensureFrames($: EngineInterface) {
  if (frames) return
  const stop = () => {
    frames?.cancel()
    frames = null
  }
  frames = $.clock.every(FRAME_MS, async () => {
    if (framesBusy) return
    framesBusy = true
    try {
      const g = await read($, graph)
      if (!hasLiveAgents(g)) {
        stop()
        $.ui.invalidate('ui.render')
        return
      }
      const now = await $.clock.now()
      const tiles = splitFrame(renderFrame(g, layoutGraph(g, paneRoom), now, Math.floor(now / FRAME_MS)))
      // More or fewer tiles than are mounted: only a redraw can add or drop a Raster.
      if (tiles.length !== lastCells.length) {
        stop()
        $.ui.invalidate('ui.render')
        return
      }
      for (const [i, t] of tiles.entries()) {
        if (t.cells === lastCells[i]) continue
        lastCells[i] = t.cells
        const r = await $.ui.blit({ requestId: PANE, key: `graph-${i}`, cells: t.cells, columns: t.columns, rows: t.rows })
        // Not mounted, another tab shown, or the size changed: the next draw starts the frames again.
        if (r.deny) return stop()
      }
    } catch {
      stop()
    } finally {
      framesBusy = false
    }
  })
}

// ---- live browser viewer -------------------------------------------------------------------------

type Viewer = { url: string; file: string; child: AsyncGenerator<unknown, unknown> }
let viewer: Viewer | null = null
let webWriter: Timer | null = null
let lastSnapshot = ''
/** The start in progress, shared by concurrent callers so two never spawn two servers. */
let starting: Promise<string | { error: string }> | null = null
let writing = false
/** A transcript lookup that found nothing, kept for TRANSCRIPT_RETRY_MS. */
let transcriptMiss: { id: string; until: number } | null = null

type Ready = { port: number; file: string; token: string }

/** Reads the child's stdout until its first line, `{ ready, port, file, token }`. */
async function readReady(child: AsyncGenerator<{ stream: string; text: string }, unknown>): Promise<Ready | null> {
  let out = ''
  for (;;) {
    const step = await child.next()
    if (step.done) return null
    if (step.value.stream !== 'stdout') continue
    out += step.value.text
    const line = out.split('\n')[0]
    if (out.includes('\n') && line) {
      const parsed = JSON.parse(line) as Partial<Ready> & { ready?: boolean }
      return parsed.ready && parsed.port && parsed.file && parsed.token ? (parsed as Ready) : null
    }
  }
}

/**
 * The main session's transcript (JSONL), as the last main-loop classic hook reported it in
 * `transcript_path`; null until one fired. The viewer reads node details from it on demand.
 */
let transcript: string | null = null

/** Keeps a classic hook's `transcript_path` when the main loop raised it (no `agent_id`). */
function noteTranscript(e: { transcript_path?: string; agent_id?: string }) {
  const path = e.transcript_path
  if (!e.agent_id && typeof path === 'string' && path.endsWith('.jsonl')) transcript = path
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1)

/**
 * The main transcript of session `id`: the noted path when its file name is the session id, else
 * where Claude Code stores it, `~/.claude/projects/<root with every non-alphanumeric as ->/<id>.jsonl`,
 * when that file exists; null otherwise. Never throws.
 */
async function transcriptFor($: EngineInterface, id: string): Promise<string | null> {
  if (transcript && baseName(transcript) === `${id}.jsonl`) return transcript
  const now = await $.clock.now().catch(() => 0)
  if (transcriptMiss?.id === id && now < transcriptMiss.until) return null
  const miss = () => {
    transcriptMiss = { id, until: now + TRANSCRIPT_RETRY_MS }
    return null
  }
  try {
    const [home, root] = await Promise.all([$.env.get('HOME'), $.session.root()])
    if (!home || !id) return miss()
    const guess = `${home}/.claude/projects/${root.replace(/[^A-Za-z0-9]/g, '-')}/${id}.jsonl`
    if (!(await $.fs.exists(guess))) return miss()
    transcript = guess
    return guess
  } catch {
    return miss()
  }
}

/** Writes the graph for the viewer whenever it changed. */
async function writeSnapshot($: EngineInterface) {
  // Ticks do not overlap: a slow write is not started again underneath itself.
  if (!viewer || writing) return
  writing = true
  try {
    const file = viewer.file
    const session = await $.session.id()
    const text = JSON.stringify({ session, transcript: await transcriptFor($, session), graph: await read($, graph) })
    if (text === lastSnapshot) return
    await $.fs.write(file, text)
    // Only a written snapshot counts as sent, so a failed write is tried again on the next tick.
    lastSnapshot = text
  } finally {
    writing = false
  }
}

/** Ends the viewer process and forgets its address. */
async function stopViewer($: EngineInterface) {
  const was = viewer
  viewer = null
  webWriter?.cancel()
  webWriter = null
  lastSnapshot = ''
  transcriptMiss = null
  if (was) await was.child.return(undefined as never).catch(() => undefined)
  await update($, webUrl, () => null)
}

/**
 * Starts the viewer (viewer/server.mjs) with the first runtime that runs, and answers its address.
 * Concurrent callers share one start. The child lives as long as the loop that drains it: the module
 * unloading, `stopViewer` or the child exiting ends it.
 */
function startViewer($: EngineInterface): Promise<string | { error: string }> {
  if (viewer) return Promise.resolve(viewer.url)
  return (starting ??= launchViewer($).finally(() => {
    starting = null
  }))
}

async function launchViewer($: EngineInterface): Promise<string | { error: string }> {
  const script = `${$.plugin.root}/viewer/server.mjs`
  const tried: string[] = []
  for (const runtime of RUNTIMES) {
    let child: ReturnType<EngineInterface['process']['spawn']> | undefined
    let ready: Ready | null = null
    let why = ''
    try {
      child = $.process.spawn({ argv: [runtime, script] })
      const got = await Promise.race([readReady(child), $.clock.sleep(WEB_START_MS).then(() => 'timeout' as const)])
      if (got === 'timeout') why = `no address within ${WEB_START_MS / 1000}s`
      else if (got) ready = got
      else why = 'exited before printing its address'
    } catch (err) {
      // The runtime is missing, or the child printed something that is not its address.
      why = err instanceof Error ? err.message : String(err)
    }
    if (!ready || !child) {
      tried.push(`${runtime}: ${why}`)
      await child?.return(undefined as never).catch(() => undefined)
      continue
    }
    const started = child
    const url = `http://127.0.0.1:${ready.port}/?k=${ready.token}`
    const mine: Viewer = { url, file: ready.file, child: started }
    viewer = mine
    await update($, webUrl, () => url)
    await writeSnapshot($).catch(() => undefined)
    webWriter?.cancel()
    webWriter = $.clock.every(WEB_MS, () => void writeSnapshot($).catch(() => undefined))
    // Drain the child's output for its whole life; when it exits, forget it.
    void (async () => {
      try {
        while (!(await started.next()).done) {
          // The viewer prints nothing after its address; anything else is ignored.
        }
      } catch {
        // Killed or failed: handled below.
      }
      if (viewer === mine) await stopViewer($).catch(() => undefined)
    })()
    return url
  }
  return { error: `could not start the viewer (${tried.join('; ')}). It needs Node 18+ or Bun on PATH.` }
}

/** Starts the viewer if needed and opens it in the default browser; a toast says what failed. */
async function openInBrowser($: EngineInterface) {
  const web = await startViewer($)
  if (typeof web !== 'string') return void $.ui.toast(`q-graph: ${web.error}`, { timeoutMs: 8000 })
  for (const opener of OPENERS) {
    try {
      const r = await $.process.run([...opener, web], { timeoutMs: 5000 })
      if (r.exitCode === 0) return
    } catch {
      // Not on this system: try the next opener.
    }
  }
  $.ui.toast(`q-graph: could not open a browser; visit ${web}`, { timeoutMs: 8000 })
}

export const register: Register = on => {
  // ---- settings and /q-graph ------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get(SETTINGS_KEY)
      await update($, settings, () => pickSettings(saved))
    } catch {
      // Defaults stand when the store cannot be read.
    }
    // A reload ends the old module's viewer process with it; a live viewer of this module stays.
    await update($, webUrl, () => viewer?.url ?? null).catch(() => undefined)
    await $.command.register({
      name: 'q-graph',
      description: 'Show the subagents and teammates of this session as a live graph',
      argumentHint: 'open [--web] | web [stop] | close | status | band on|off | notify on|off | config | help',
    })
    await refreshHarness($)
    return next(e)
  })

  on('command.run', { command: 'q-graph' }, async ($, e) => {
    const [sub = 'open', ...rest] = e.args.trim().toLowerCase().split(/\s+/).filter(Boolean)
    const extra = unknownArg(sub, rest)
    if (extra !== undefined) return { text: `Unknown argument "${extra}" for "${sub}".\n${USAGE}`, exitCode: 2 }
    switch (sub) {
      case 'open': {
        const r = await openPane($)
        const pane = r.isPlaced ? 'q-graph pane opened.' : 'q-graph pane opens when there is room for it.'
        if (!rest.includes('--web')) return { text: pane }
        const web = await startViewer($)
        return typeof web === 'string' ? { text: `${pane}\nLive viewer: ${web}` } : { text: `${pane}\n${web.error}`, exitCode: 1 }
      }
      case 'web': {
        if (rest[0] === 'stop') {
          await stopViewer($)
          return { text: 'q-graph live viewer stopped.' }
        }
        const web = await startViewer($)
        return typeof web === 'string' ? { text: `q-graph live viewer: ${web}` } : { text: web.error, exitCode: 1 }
      }
      case 'close':
        await $.ui.close({ id: PANE })
        return { text: 'q-graph pane closed.' }
      case 'status': {
        const g = await read($, graph)
        const lines = describeAgents(g, await $.clock.now())
        const harness = harnessStatus(g)
        const agents = lines.length > 1 ? lines.join('\n') : 'No subagents or teammates in this session yet.'
        return { text: harness ? `${agents}\n${harness}` : agents }
      }
      case 'band':
      case 'notify': {
        const patch = parseToggle(sub, rest[0] ?? '')
        if (typeof patch === 'string') return { text: patch, exitCode: 2 }
        await saveSettings($, { ...(await read($, settings)), ...patch })
        return { text: `${sub} ${rest[0]}.` }
      }
      case 'config':
        return { text: `q-graph settings:\n${showSettings(await read($, settings))}` }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  })

  // ---- event recorder ---------------------------------------------------------------------------

  on('prompt.submit', async ($, e, next) => {
    const now = await $.clock.now()
    await update($, graph, g => promptSubmitted(g, now))
    // MCP servers connect and skills load after the session starts: the card is read again each prompt.
    void refreshHarness($)
    return next(e)
  }).catch(($, e, next) => next(e))

  on('agent.spawn', async ($, e, next) => {
    const r = await next(e)
    if (r.agentId) {
      const now = await $.clock.now()
      await update($, graph, g =>
        spawnAgent(
          g,
          {
            id: r.agentId!,
            parentId: e.parentAgentId ?? MAIN,
            isTeammate: e.isTeammate === true,
            type: e.subagentType,
            name: e.name,
            teammateId: r.teammateId,
            model: r.model ?? e.model,
            description: e.description,
          },
          now,
        ),
      )
      ensurePoll($)
    }
    return r
  }).catch(($, e, next) => next(e)) // `next` replays a settled spawn, so a failure here never starts the agent twice

  on('tool.call', async ($, e, next) => {
    const id = e.agentId ?? MAIN
    const callId = e.tool_use_id ?? null
    // A skill by name and an MCP server stand for the call; a spawn is the child's own card.
    const key = useKey(e.tool, e as { skill?: unknown })
    const now = await $.clock.now()
    // An agent no spawn has recorded yet gets a stub that the spawn merges into.
    const after = await update($, graph, g => toolStarted(g, id, e.tool, now, key, callId))
    const agent = after.agents[id]
    // A call by an agent that was not live (lost, or woken by a message) brings the poll back.
    if (hasLiveAgents(after)) ensurePoll($)
    // A subagent or teammate asking a question or for plan approval: the main loop's own asks are on screen already.
    if (agent && agent.kind !== 'main' && ASK_TOOLS.has(e.tool)) {
      alert($, agent, e.tool === 'ExitPlanMode' ? `${agent.label} waits for plan approval` : `${agent.label} is asking you`)
    }
    try {
      return await next(e)
    } finally {
      const done = await $.clock.now().catch(() => 0)
      const ended = await update($, graph, g => toolFinished(g, id, e.tool, done, key, callId)).catch(() => undefined)
      if (ended && hasLiveAgents(ended)) ensurePoll($)
    }
  }).catch(($, e, next) => next(e))

  // The main transcript's path, for the viewer's node details: a start, resume, /clear or fork
  // names the session's file; every main-loop prompt repeats it.
  on('classic.SessionStart', async ($, e, next) => {
    const r = await next(e)
    noteTranscript(e)
    return r
  }).catch(($, e, next) => next(e))

  on('classic.UserPromptSubmit', async ($, e, next) => {
    const r = await next(e)
    noteTranscript(e)
    return r
  }).catch(($, e, next) => next(e))

  // A CLAUDE.md or rules file loaded by an agent: at session start for main, on a path-matched rule
  // or a nested CLAUDE.md for whichever agent read the file (`agent_id`, absent for main).
  on('classic.InstructionsLoaded', async ($, e, next) => {
    const r = await next(e)
    noteTranscript(e)
    const id = e.agent_id ?? MAIN
    const now = await $.clock.now()
    const after = await update($, graph, g => ruleLoaded(g, id, e.file_path, now))
    if (hasLiveAgents(after)) ensurePoll($)
    return r
  }).catch(($, e, next) => next(e))

  on('turn.complete', async ($, e, next) => {
    const r = await next(e)
    const id = e.agentId ?? MAIN
    const u = e.usage
    // Cache reads are left out: every request re-reads the cached prefix (see AgentNode.tokens).
    const tokens = u ? (u.input_tokens ?? 0) + (u.output_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) : 0
    const now = await $.clock.now()
    // Worked out inside the updater, so a retry sees the writes of the hooks that ran meanwhile.
    let was: NodeStatus | null = null
    const after = await update($, graph, g => {
      was = g.agents[id]?.status ?? null
      return turnEnded(g, id, { tokens, reason: e.reason, model: u?.model }, now)
    })
    const to = after.agents[id]?.status
    if (to && to !== was) announce($, after, [{ id, from: was, to }])
    return r
  }).catch(($, e, next) => next(e))

  on('session.end', async ($, e, next) => {
    await stopViewer($).catch(() => undefined)
    return next(e)
  })

  on('session.send', async ($, e, next) => {
    const r = await next(e)
    if (r.isDelivered) {
      await update($, graph, g => {
        const to = resolveRecipient(g, e.to)
        return to ? messageSent(g, e.agentId ?? MAIN, to) : g
      })
      ensurePoll($)
    }
    return r
  }).catch(($, e, next) => next(e))

  // ---- band above the prompt -------------------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cfg = await read($, settings)
    if (!cfg.band || e.props.hasSurvey) return next(e)
    const g = await read($, graph)
    const now = await $.clock.now()
    const agents = rosterAgents(g, now)
    if (agents.length === 0) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const all = await read($, bandAll)
    const room = Math.max(20, e.props.bodyColumns - 12)
    const chips: { a: AgentNode; label: string; status: string }[] = []
    let width = 0
    for (const a of agents) {
      const status = bandStatus(a, now)
      const tokens = a.tokens ? ` ${formatTokens(a.tokens)}` : ''
      const chip = { a, label: a.label, status: status + tokens }
      const w = chip.label.length + chip.status.length + 4
      // Folded, the band keeps to one row; unfolded, every agent is listed and the row wraps.
      if (!all && width + w > room && chips.length > 0) break
      chips.push(chip)
      width += w
    }
    const more = agents.length - chips.length
    const setAll = (expand: boolean) => void update($, bandAll, () => expand).catch(() => undefined)

    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        {chips.map(c => (
          <Text key={`chip-${c.a.id}`} wrap="truncate">
            <Text color={KIND_HEX[c.a.kind]}>{c.label}</Text>{' '}
            <Text color={needsYou(c.a) ? WARN_COLOR : STATUS_COLOR[c.a.status]} dimColor={!needsYou(c.a) && !STATUS_COLOR[c.a.status]}>
              {c.status}
            </Text>
          </Text>
        ))}
        {more > 0 && <Button key="band-all" label={`+${more} more`} onPress={() => setAll(true)} />}
        {all && width > room && <Button key="band-fold" label="show less" onPress={() => setAll(false)} />}
        <Button key="open-graph" label="graph" onPress={() => void openPane($)} />
      </Box>
    )
  })

  // ---- the graph pane ---------------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const g = await read($, graph)
    const now = await $.clock.now()
    const { Box, Text } = $.ui.resolve(e)
    const summary = (() => {
      const all = g.order.map(id => g.agents[id]).filter((a): a is AgentNode => !!a && a.kind !== 'main')
      const count = (s: NodeStatus) => all.filter(a => a.status === s).length
      const tokens = all.reduce((n, a) => n + a.tokens, 0)
      return `${all.length} agents · ${count('running')} running · ${all.filter(needsYou).length} need you · ${formatTokens(tokens)} tok`
    })()

    if (e.surface === 'terminal') {
      const { Raster, Link } = $.ui.resolve(e)
      const url = await read($, webUrl)
      const { Button } = $.ui.resolve(e)
      paneRoom = Math.max(40, e.props.bodyColumns)
      const layout = layoutGraph(g, paneRoom)
      // One Raster holds at most 256 rows: a taller tree is drawn as several, stacked.
      const tiles = splitFrame(renderFrame(g, layout, now, Math.floor(now / FRAME_MS)))
      lastCells = tiles.map(t => t.cells)
      if (hasLiveAgents(g)) ensureFrames($)
      const openWeb = () => void openInBrowser($).catch(() => undefined)
      return (
        <Box flexDirection="column" gap={1}>
          <Box flexDirection="row" gap={2}>
            <Text dimColor>{summary}</Text>
            <Button key="open-web" label="↗ open in browser" onPress={openWeb} />
            {url && <Link href={url} label={url} />}
          </Box>
          <Box flexDirection="column">
            {tiles.map((t, i) => (
              <Raster key={`graph-${i}`} columns={t.columns} rows={t.rows} cells={t.cells} />
            ))}
          </Box>
          {layout.hidden > 0 && (
            <Box flexDirection="row" gap={2}>
              <Text color={WARN_COLOR}>+{layout.hidden} agents too deep or too many to draw here</Text>
              <Button key="show-all" label="show all in browser" onPress={openWeb} />
            </Box>
          )}
        </Box>
      )
    }

    // Surfaces without a Raster get the same tree as text.
    const harness = harnessStatus(g)
    const lines = harness ? [...describeAgents(g, now), harness] : describeAgents(g, now)
    return (
      <Box flexDirection="column">
        <Text dimColor>{summary}</Text>
        {lines.map((line, i) => (
          <Text key={`line-${i}`} wrap="truncate">
            {line}
          </Text>
        ))}
      </Box>
    )
  })
}

