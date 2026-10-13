// q-panel: the Bash panel and guard, one row above the prompt (git + turn summary), and two panes.
// Every hook and every helper that takes `$` lives in this file (the engine follows `$` only within
// one module); pure helpers are in ./lib.

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileEntry, GitEvent, GitStatus, PanelSettings, TurnStats } from '../types'
import {
  BUILTIN_RULES,
  MAX_EXPANDED_LINES,
  SLOW_MS,
  clip,
  compileRules,
  diffStats,
  formatBytes,
  formatMs,
  gitBadges,
  headTail,
  lines,
  matchRule,
  parseTestSummary,
  previewTail,
  readOutput,
  statusOf,
  type BashInput,
  type Line,
} from './lib/bash'
import { GLYPH, STATUS_ARGV, STATUS_ARGV_OLD, parseStatus, statusLine, toEvents, touchesGit, type GitOperation } from './lib/git'
import { addToTurn, capLedger, changeLabel, groupFiles, hasActivity, newTurn, readNote, recordCall, turnParts } from './lib/ledger'
import { DEFAULT_SETTINGS, USAGE, parseConfig, pickSettings, showSettings } from './lib/settings'

const settings = atom({ plugin: 'q-panel', key: 'settings' } as const, DEFAULT_SETTINGS as PanelSettings)
const hidden = atom({ plugin: 'q-panel', key: 'hidden' } as const, false)
const open = atom({ plugin: 'q-panel', key: 'open' } as const, false)
const duration = atom({ plugin: 'q-panel', key: 'duration' } as const, 0)
const status = atom({ plugin: 'q-panel', key: 'status' } as const, null as GitStatus | null)
const timeline = atom({ plugin: 'q-panel', key: 'timeline' } as const, [] as GitEvent[])
const ledger = atom({ plugin: 'q-panel', key: 'ledger' } as const, [] as FileEntry[])
const turn = atom({ plugin: 'q-panel', key: 'turn' } as const, null as TurnStats | null)
const lastTurn = atom({ plugin: 'q-panel', key: 'lastTurn' } as const, null as TurnStats | null)

const SETTINGS_KEY = 'settings'
const FILES_PANE = 'q-panel-files'
const TIMELINE_PANE = 'q-panel-timeline'
const TIMELINE_LIMIT = 200

const saveSettings = async ($: EngineInterface, next: PanelSettings) => {
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

/** Is the git segment on screen? Only then is `git status` read on its own. */
const isGitShown = async ($: EngineInterface) => {
  const cfg = await read($, settings)
  return cfg.band && cfg.git && !(await read($, hidden))
}

/** Reads `git status` into the session state; null outside a repository. */
const refreshStatus = async ($: EngineInterface) => {
  let r = await $.process.run(STATUS_ARGV, { timeoutMs: 5_000 })
  if (r.exitCode !== 0 && /show-stash|unknown option/.test(r.stderr)) r = await $.process.run(STATUS_ARGV_OLD, { timeoutMs: 5_000 })
  const next = r.exitCode === 0 ? parseStatus(r.stdout) : null
  await update($, status, () => next)
  return next
}

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

/** Copies `text` to the clipboard of the surface that was pressed and says how it went. */
const copyText = async ($: EngineInterface, text: string, surface: Surface, what: string) => {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `${what} copied` : `Could not copy: ${r.reason ?? 'no clipboard'}`)
}

const RULES = compileRules(BUILTIN_RULES)

/** Tools whose calls the files ledger records. */
const TRACKED = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash'])

/** Applies a settings patch, then reads the status at once when the git segment has just come into view. */
const applySettings = async ($: EngineInterface, patch: Partial<PanelSettings>) => {
  const wasShown = await isGitShown($)
  await saveSettings($, { ...(await read($, settings)), ...patch })
  if (!wasShown && (await isGitShown($))) await refreshStatus($).catch(() => null)
}

export const register: Register = on => {
  // ---- settings and /q-panel ----------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get(SETTINGS_KEY)
      await update($, settings, () => pickSettings(saved))
    } catch {
      // Defaults stand when the store cannot be read.
    }
    await $.command.register({
      name: 'q-panel',
      description: 'Bash panels and guard, the git and turn row above the prompt, files and git timeline panes',
      argumentHint: 'files | timeline | status | clear | band on|off | guard on|off | config [<key> <value> | reset] | help',
    })
    if (await isGitShown($)) await refreshStatus($).catch(() => null)
    return next(e)
  })

  on('command.run', { command: 'q-panel' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub) {
      case 'files':
        await $.ui.open({ id: FILES_PANE, title: 'Files' })
        return { text: 'Files pane opened.' }
      case 'timeline':
        await $.ui.open({ id: TIMELINE_PANE, title: 'Git timeline' })
        return { text: 'Git timeline pane opened.' }
      case 'status':
      case 'refresh': {
        const s = await refreshStatus($)
        return { text: s ? statusLine(s) : 'Not inside a git repository.' }
      }
      case 'clear':
        // The row reads the turn counts too, so they go with the list.
        await update($, ledger, () => [])
        await update($, turn, () => null)
        await update($, lastTurn, () => null)
        return { text: 'Files list and turn counts cleared.' }
      case 'band':
      case 'guard': {
        const [arg = ''] = rest
        if (arg !== 'on' && arg !== 'off') return { text: `Usage: /q-panel ${sub} on|off`, exitCode: 2 }
        if (sub === 'band') await update($, hidden, () => false)
        await applySettings($, { [sub]: arg === 'on' })
        return { text: sub === 'band' ? `Row above the prompt is ${arg}.` : `Guard is ${arg}.` }
      }
      case 'config': {
        const cfg = await read($, settings)
        if (rest.length === 0) return { text: `q-panel settings:\n${showSettings(cfg)}` }
        if (rest[0] === 'reset') {
          await applySettings($, DEFAULT_SETTINGS)
          return { text: 'q-panel settings restored to the defaults.' }
        }
        const [key = '', value = ''] = rest
        const patch = parseConfig(key, value)
        if (typeof patch === 'string') return { text: patch, exitCode: 2 }
        await applySettings($, patch)
        return { text: `${key} set to ${value}.` }
      }
      case '':
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  })

  // ---- recorders: one tool.call hook for timing, the files ledger and git activity -----------

  on('tool.call', async ($, e, next) => {
    const at = await $.clock.now()
    let ran!: Awaited<ReturnType<typeof next>>
    try {
      ran = await next(e)
    } finally {
      // The row's requestId is the tool_use_id, so the panel reads this member with memberOf(duration, e).
      if (e.tool === 'Bash' && e.tool_use_id) {
        const ms = (await $.clock.now()) - at
        await update($, memberOf(duration, { requestId: e.tool_use_id }), () => ms).catch(() => undefined)
      }
    }

    // Everything below is a view of a call that already ran: a failure here must never change it.
    try {
      if (TRACKED.has(String(e.tool))) {
        const before = await read($, ledger)
        const { ledger: after, delta } = recordCall(before, await $.session.root(), {
          tool: String(e.tool),
          // A tool.call event carries the tool's own arguments at its top level (file_path, command, …).
          input: e as unknown as Record<string, unknown>,
          result: ran.result,
          isError: ran.isError === true || ran.deny !== undefined,
          agentId: e.agentId,
          at: await $.clock.now(),
        })
        if (after !== before) await update($, ledger, () => capLedger(after))
        if (Object.keys(delta).length > 0) await update($, turn, t => (t ? addToTurn(t, delta) : t))
      }

      if (e.tool === 'Bash') {
        const op = (ran.result as { gitOperation?: GitOperation } | undefined)?.gitOperation
        if (op) {
          const events = toEvents(op, e.command, await $.clock.now())
          await update($, timeline, list => [...list, ...events].slice(-TIMELINE_LIMIT))
        }
        if ((op || touchesGit(e.command)) && (await isGitShown($))) await refreshStatus($)
      }
    } catch {
      // The row and the panes are views; leave the call's result as it is.
    }
    return ran
  }).catch(($, e, next) => next(e)) // `next` replays a settled call, so a failure here never runs the tool twice

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    // Keep the previous turn on show until this one does something.
    const prev = await read($, turn)
    if (prev && hasActivity(prev)) await update($, lastTurn, () => prev)
    await update($, turn, () => newTurn(e.turnId, at))
    return next(e)
  })

  // Files may change outside git commands (edits, generators): read the status once per main-loop turn.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) {
      await update($, turn, t => (t && t.turnId === e.turnId ? { ...t, isRunning: false, ms: e.durationMs } : t))
      if (await isGitShown($)) await refreshStatus($).catch(() => null)
    }
    return next(e)
  })

  // ---- guard: ask before destructive commands, even where rules or the mode would allow them

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    if (!(await read($, settings)).guard || verdict.decision === 'deny') return verdict
    const command = (e.input as { command?: string } | undefined)?.command ?? ''
    const hit = matchRule(command, RULES)
    return hit ? { ...verdict, decision: 'ask' as const, reason: `q-panel guard: ${hit.why}` } : verdict
  }).catch(() => ({ decision: 'ask' as const, reason: 'The q-panel guard failed; confirm this command yourself.' }))

  // ---- transcript: unfold Bash-only groups, drop the result block the panel replaces

  // A group made only of Bash calls is unfolded so each call gets its panel. A mixed group
  // (Bash with Read, Grep, …) stays folded: unfolding it would put every read on screen too.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    (await read($, settings)).unfoldGroups && e.props.calls.length > 0 && e.props.calls.every(c => c.tool === 'Bash')
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e),
  )

  // The panel draws the output itself. Image output is the exception: the engine draws the picture, the panel cannot.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== 'Bash' || readOutput(e.props.output).isImage) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // ---- panel -----------------------------------------------------------------------------

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (p.tool !== 'Bash') return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const cfg = await read($, settings)
    const input = (p.input ?? {}) as BashInput
    const command = input.command ?? ''
    const out = readOutput(p.output)

    const isOpen = await read($, memberOf(open, e))
    const toggle = () => update($, memberOf(open, e), v => !v)

    const width = Math.max(20, (e.viewport?.columns ?? 100) - 6)
    const ms = await read($, memberOf(duration, e))

    const stdout = out.isImage ? [] : lines(out.stdout)
    const stderr = lines(out.stderr)
    const all: Line[] = [...stdout.map(t => ({ t, err: false })), ...stderr.map(t => ({ t, err: true }))]

    const [state, color] = statusOf(p, out)
    const took = ms > 0 && !p.isRunning ? ` · ${formatMs(ms)}` : ''

    const cmdLines = command.split('\n')
    const head = clip(cmdLines[0] ?? '', width - 8 - state.length - took.length) + (cmdLines.length > 1 ? ' …' : '')

    const tests = p.isRunning ? undefined : parseTestSummary(`${out.stdout ?? ''}\n${out.stderr ?? ''}`)
    const files = out.bashEditDiff?.files ?? []
    const changed = diffStats(files)
    const badges: { text: string; color: string }[] = [
      ...(tests ? [{ text: `✓ ${tests.passed}  ✗ ${tests.failed}${tests.skipped > 0 ? `  ○ ${tests.skipped}` : ''}`, color: tests.failed > 0 ? 'red' : 'green' }] : []),
      ...(files.length > 0 ? [{ text: `+${changed.added} −${changed.removed}`, color: 'blue' }] : []),
      ...gitBadges(out).map(text => ({ text, color: 'green' })),
      ...(input.dangerouslyDisableSandbox ? [{ text: '⚠ unsandboxed', color: 'red' }] : []),
    ]

    const preview = previewTail(stdout, stderr, cfg.previewLines)
    const hiddenBefore = all.length - preview.length
    const expanded = headTail(all, MAX_EXPANDED_LINES)

    const drawLine = ({ t, err }: Line, i: number) => (
      <Text key={`l${i}`} color={err ? 'red' : undefined} dimColor={!err && !isOpen}>
        {isOpen ? t : clip(t, width)}
      </Text>
    )

    return (
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key={`q-panel-${e.requestId}`} plain onPress={toggle}>
            <Text color={color}>{isOpen ? '▾' : '▸'} </Text>
            <Text bold>$ {head}</Text>
          </Button>
          <Text color={color}>
            {' '}
            {state}
            {took && <Text color={ms >= SLOW_MS ? 'yellow' : color}>{took}</Text>}
          </Text>
        </Box>

        {input.description && <Text dimColor>{input.description}</Text>}

        {badges.length > 0 && (
          <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
            {badges.map((b, i) => (
              <Text key={`b${i}`} color={b.color}>
                [{b.text}]
              </Text>
            ))}
          </Box>
        )}

        {out.returnCodeInterpretation && <Text dimColor>ℹ {out.returnCodeInterpretation}</Text>}

        {isOpen && cmdLines.length > 1 && (
          <Box flexDirection="column" marginTop={1}>
            {cmdLines.map((l, i) => (
              <Text key={`c${i}`} bold>
                {l}
              </Text>
            ))}
          </Box>
        )}

        {all.length > 0 && (
          <Box flexDirection="column" marginTop={isOpen ? 1 : 0}>
            {!isOpen && hiddenBefore > 0 && <Text dimColor>… {hiddenBefore} earlier lines</Text>}
            {!isOpen && preview.map(drawLine)}
            {isOpen && expanded.head.map(drawLine)}
            {isOpen && expanded.gap > 0 && <Text dimColor>… {expanded.gap} lines hidden …</Text>}
            {isOpen && expanded.tail.map((l, i) => drawLine(l, expanded.head.length + i))}
          </Box>
        )}

        {out.isImage && <Text dimColor>(image output, drawn below)</Text>}
        {!p.isRunning && !out.isImage && !out.backgroundTaskId && all.length === 0 && <Text dimColor>(no output)</Text>}
        {out.persistedOutputPath && (
          <Text dimColor>
            full output{out.persistedOutputSize ? ` (${formatBytes(out.persistedOutputSize)})` : ''} saved at {out.persistedOutputPath}
          </Text>
        )}

        <Box flexDirection="row">
          <Button key={`q-panel-copy-${e.requestId}`} plain onPress={press => copyText($, command, press.surface, 'Command')}>
            <Text dimColor>[ copy command ]</Text>
          </Button>
        </Box>
      </Box>
    )
  })

  // ---- row above the prompt -----------------------------------------------------------------

  // The row is shared with other plugins: draw what they drew, then q-panel's row under it.
  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    const cfg = await read($, settings)
    if (e.props.hasSurvey || !cfg.band || (await read($, hidden))) return below

    const s = cfg.git ? await read($, status) : null

    let parts: ReturnType<typeof turnParts> = []
    if (cfg.files) {
      const current = await read($, turn)
      // A follow-up turn that ran no tools (the reply after a background agent) keeps the last busy turn on show.
      const t = current && hasActivity(current) ? current : await read($, lastTurn)
      if (t) {
        const inTurn = new Set(t.files)
        const touched = (await read($, ledger)).filter(f => inTurn.has(f.path))
        parts = turnParts(
          t,
          touched.filter(f => f.reads > 0).length,
          touched.filter(f => f.edits + f.writes > 0).length,
        )
      }
    }
    if (s === null && parts.length === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    const count = (await read($, timeline)).length
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {s && (
            <Text wrap="truncate-end">
              <Text color="blue">{s.detached ? '⎇ detached at' : '⎇'} {s.branch}</Text>
              {s.upstream ? <Text dimColor> → {s.upstream}</Text> : <Text dimColor> (no upstream)</Text>}
              {(s.ahead > 0 || s.behind > 0) && <Text color={s.behind > 0 ? 'yellow' : undefined}>  ↑{s.ahead} ↓{s.behind}</Text>}
              {s.staged > 0 && <Text color="green">  ●{s.staged} staged</Text>}
              {s.modified > 0 && <Text color="yellow">  ✚{s.modified} modified</Text>}
              {s.untracked > 0 && <Text dimColor>  ?{s.untracked} untracked</Text>}
              {s.conflicts > 0 && <Text color="red">  ✖{s.conflicts} conflicts</Text>}
              {s.staged + s.modified + s.untracked + s.conflicts === 0 && <Text color="green">  ✓ clean</Text>}
              {s.stash > 0 && <Text dimColor>  stash {s.stash}</Text>}
            </Text>
          )}
          {s && parts.length > 0 && <Text dimColor>│</Text>}
          {parts.map((p, i) => (
            <Text key={`p${i}`} color={p.tone} dimColor={p.tone === undefined}>
              {i > 0 && !p.text.startsWith('+') && !p.text.startsWith('−') ? '· ' : ''}
              {p.text}
            </Text>
          ))}
          {parts.length > 0 && <Button key="q-panel-files" hotkey="f" label="files" onPress={() => $.ui.open({ id: FILES_PANE, title: 'Files' })} />}
          {s && (
            <Button key="q-panel-timeline" plain onPress={() => $.ui.open({ id: TIMELINE_PANE, title: 'Git timeline' })}>
              <Text dimColor>[ timeline{count > 0 ? ` ${count}` : ''} ]</Text>
            </Button>
          )}
          <Button
            key="q-panel-hide"
            plain
            onPress={async () => {
              await update($, hidden, () => true)
              $.ui.toast('Row hidden for this session. /q-panel band off keeps it hidden.')
            }}
          >
            <Text dimColor>[ hide ]</Text>
          </Button>
        </Box>
      </Box>
    )
  })

  // ---- panes ---------------------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, ledger)
    const { changed, readOnly } = groupFiles(all)
    const width = Math.max(20, e.props.bodyColumns - 24)
    const clip = (s: string) => (s.length > width ? `…${s.slice(s.length - width + 1)}` : s)

    const row = (f: FileEntry, label: string, tone: string | undefined, notes: string[]) => (
      <Button key={`f-${f.path}`} plain onPress={press => copyText($, f.path, press.surface, 'Path')}>
        <Text color={tone}>{label.padEnd(10)}</Text>
        <Text>{clip(f.path)}</Text>
        {notes.length > 0 && <Text color="yellow">{`  ${notes.join(' · ')}`}</Text>}
      </Button>
    )

    return (
      <Box flexDirection="column">
        {all.length === 0 && <Text dimColor>No files read or changed yet.</Text>}
        {changed.length > 0 && <Text bold>changed</Text>}
        {changed.map(f => row(f, changeLabel(f), 'green', [readNote(f)].filter((n): n is string => !!n)))}
        {readOnly.length > 0 && <Text bold>read only</Text>}
        {readOnly.map(f =>
          row(f, '', undefined, [readNote(f), f.rereads > 0 ? `re-read ${f.rereads}×` : undefined].filter((n): n is string => !!n)),
        )}
        <Text dimColor>Press a row to copy its path · /q-panel clear empties the list</Text>
      </Box>
    )
  })

  on('ui.render', { component: 'Pane', requestId: TIMELINE_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, timeline)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    return (
      <Box flexDirection="column">
        {list.length === 0 && <Text dimColor>No commits, pushes or PRs in this session yet.</Text>}
        {list
          .slice(-room)
          .reverse()
          .map((ev, i) => {
            const copyable = ev.url ?? ev.sha
            const time = new Date(ev.at).toTimeString().slice(0, 5)
            return copyable ? (
              <Button key={`ev-${ev.at}-${i}`} plain onPress={press => copyText($, copyable, press.surface, ev.url ? 'PR link' : 'Commit id')}>
                <Text dimColor>{time} </Text>
                <Text color="green">{GLYPH[ev.kind]} </Text>
                {ev.label}
              </Button>
            ) : (
              <Text key={`ev-${ev.at}-${i}`}>
                <Text dimColor>{time} </Text>
                <Text color="green">{GLYPH[ev.kind]} </Text>
                {ev.label}
              </Text>
            )
          })}
        {list.length > 0 && <Text dimColor>Press a commit or PR to copy its id or link.</Text>}
      </Box>
    )
  })
}
