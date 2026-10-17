// q-panel: bordered panels for Bash and file-changing tool calls (Write, Edit, NotebookEdit), and
// framed, collapsible code blocks in replies.
// Every hook and every helper that takes `$` lives in this file (the engine follows `$` only within
// one module); pure helpers are in ./lib.

import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { PanelSettings } from '../types'
import {
  MAX_EXPANDED_LINES,
  SLOW_MS,
  clip,
  diffStats,
  formatBytes,
  formatMs,
  gitBadges,
  headTail,
  lines,
  parseTestSummary,
  previewTail,
  readOutput,
  statusOf,
  type BashInput,
  type Line,
} from './lib/bash'
import { FILE_TOOLS, fileChange, previewChanges, relativeTo, type DiffLine } from './lib/files'
import { hasFence, splitFences } from './lib/markdown'
import { DEFAULT_SETTINGS, USAGE, parseConfig, pickSettings, showSettings } from './lib/settings'

const settings = atom({ plugin: 'q-panel', key: 'settings' } as const, DEFAULT_SETTINGS as PanelSettings)
const open = atom({ plugin: 'q-panel', key: 'open' } as const, false)
const duration = atom({ plugin: 'q-panel', key: 'duration' } as const, 0)
const codeOpen = atom({ plugin: 'q-panel', key: 'codeOpen' } as const, null as boolean | null)

const SETTINGS_KEY = 'settings'

/** Tools that get a bordered panel. */
const PANEL_TOOLS = new Set(['Bash', ...FILE_TOOLS])

const saveSettings = async ($: EngineInterface, next: PanelSettings) => {
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

type Surface = Parameters<EngineInterface['ui']['copy']>[0]['surface']

/** Copies `text` to the clipboard of the surface that was pressed and says how it went. */
const copyText = async ($: EngineInterface, text: string, surface: Surface, what: string) => {
  try {
    const r = await $.ui.copy({ text, surface })
    $.ui.toast(r.isCopied ? `${what} copied` : `Could not copy: ${r.reason ?? 'no clipboard'}`)
  } catch (err) {
    $.ui.toast(`Could not copy: ${err instanceof Error ? err.message : String(err)}`)
  }
}

/** Colour of a diff row in a file panel. */
const DIFF_COLOR: Record<DiffLine['kind'], string | undefined> = { '+': 'green', '-': 'red', ' ': undefined, '@': 'cyan' }

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
      description: 'Settings for the Bash and file panels and the code blocks in replies',
      argumentHint: 'config [<key> <value> | reset] | help',
    })
    return next(e)
  })

  on('command.run', { command: 'q-panel' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub) {
      case 'config': {
        const cfg = await read($, settings)
        if (rest.length === 0) return { text: `q-panel settings:\n${showSettings(cfg)}` }
        if (rest[0] === 'reset') {
          await saveSettings($, DEFAULT_SETTINGS)
          return { text: 'q-panel settings restored to the defaults.' }
        }
        const [key = '', value = ''] = rest
        const patch = parseConfig(key, value)
        if (typeof patch === 'string') return { text: patch, exitCode: 2 }
        await saveSettings($, { ...cfg, ...patch })
        return { text: `${key} set to ${value}.` }
      }
      case '':
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  })

  // ---- timing: the Bash panel shows how long each call took -----------------------------------

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const at = await $.clock.now()
    try {
      return await next(e)
    } finally {
      // The row's requestId is the tool_use_id, so the panel reads this member with memberOf(duration, e).
      if (e.tool_use_id) {
        const ms = (await $.clock.now()) - at
        await update($, memberOf(duration, { requestId: e.tool_use_id }), () => ms).catch(() => undefined)
      }
    }
  }).catch(($, e, next) => next(e)) // `next` replays a settled call, so a failure here never runs the tool twice

  // ---- transcript: unfold panel-only groups, drop the result blocks the panels replace -------

  // A group made only of panel tools is unfolded so each call gets its panel. A mixed group
  // (with Read, Grep, …) stays folded: unfolding it would put every read on screen too.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) => {
    const cfg = await read($, settings)
    const drawn = (tool: string) => tool === 'Bash' || (cfg.filePanels && FILE_TOOLS.has(tool))
    return cfg.unfoldGroups && e.props.calls.length > 0 && e.props.calls.every(c => drawn(c.tool))
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e)
  })

  // The panels draw the output themselves. Bash image output is the exception: the engine draws the picture, the panel cannot.
  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const t = e.props.tool
    const isPanel = t === 'Bash' ? !readOutput(e.props.output).isImage : FILE_TOOLS.has(t) && (await read($, settings)).filePanels
    if (!isPanel) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  // ---- Bash panel ------------------------------------------------------------------------

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

  // ---- file panel: Write, Edit, NotebookEdit -----------------------------------------------

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (!FILE_TOOLS.has(p.tool)) return next(e)
    const cfg = await read($, settings)
    if (!cfg.filePanels) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const change = fileChange(p.tool, p.input, p.output)
    const root = await $.session.root().catch(() => undefined)
    const path = relativeTo(change.path, root)

    const isOpen = await read($, memberOf(open, e))
    const toggle = () => update($, memberOf(open, e), v => !v)
    const width = Math.max(20, (e.viewport?.columns ?? 100) - 6)

    // A failed or refused call carries the text the model read instead of a result record.
    const error = p.isErrored && typeof p.output === 'string' ? p.output : undefined
    const [state, color] = p.isRunning
      ? ['writing…', 'yellow']
      : p.isInterrupted
        ? ['interrupted', 'yellow']
        : p.isErrored
          ? ['failed', 'red']
          : change.staged
            ? ['held for review', 'blue']
            : [change.created ? 'created' : 'done', 'green']

    const stats = change.added + change.removed > 0 ? `+${change.added} −${change.removed}` : ''
    const right = ` ${state}${stats ? ` · ${stats}` : ''}`
    const head = clip(path, width - 6 - change.verb.length - right.length)

    const rows = isOpen ? change.diff.slice(0, MAX_EXPANDED_LINES) : previewChanges(change.diff, cfg.previewLines)
    const changed = change.added + change.removed
    const more = isOpen ? change.diff.length - rows.length : changed - rows.length

    const drawRow = (l: DiffLine, i: number) => {
      const sign = l.kind === '@' ? '' : `${l.kind} `
      return (
        <Text key={`d${i}`} color={DIFF_COLOR[l.kind]} dimColor={l.kind === ' ' || l.kind === '@'}>
          {isOpen ? `${sign}${l.t}` : clip(`${sign}${l.t}`, width)}
        </Text>
      )
    }

    return (
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key={`q-panel-${e.requestId}`} plain onPress={toggle}>
            <Text color={color}>{isOpen ? '▾' : '▸'} </Text>
            <Text bold>{change.verb} </Text>
            <Text>{head}</Text>
          </Button>
          <Text color={color}>{right}</Text>
        </Box>
        {error && <Text color="red">{isOpen ? error : clip(error.split('\n')[0] ?? '', width)}</Text>}
        {!error && rows.length > 0 && (
          <Box flexDirection="column">
            {rows.map(drawRow)}
            {more > 0 && <Text dimColor>{isOpen ? `… ${more} more lines` : `… ${more} more changed lines`}</Text>}
          </Box>
        )}
      </Box>
    )
  })

  // ---- replies: fenced code blocks drawn framed and highlighted, collapsed on press ---------

  // Prose stays the engine's own markdown; only the fences are drawn by q-panel. A reply with no
  // fence, a summary row, or codeBlocks off is left to the engine untouched.
  on('ui.render', { component: 'AssistantMessage' }, async ($, e, next) => {
    const p = e.props
    if (p.isSummary || !hasFence(p.text) || !(await read($, settings)).codeBlocks) return next(e)

    const { Box, Text, Button, Markdown, Code } = $.ui.resolve(e)
    const cfg = await read($, settings)
    const parts = splitFences(p.text)

    const drawn = await Promise.all(
      parts.map(async (seg, i) => {
        if (seg.kind === 'md') return <Markdown key={`md${i}`} text={seg.text} />

        const lineCount = seg.code ? seg.code.split('\n').length : 0
        // A long finished block starts collapsed; a press flips it, and the press is remembered.
        const startsOpen = !seg.closed || lineCount <= cfg.codeFoldLines
        const member = memberOf(codeOpen, { requestId: `${e.requestId}#${i}` })
        const isOpen = (await read($, member)) ?? startsOpen
        const toggle = () => update($, member, v => !(v ?? startsOpen))

        return (
          <Box key={`code${i}`} flexDirection="column" width="100%" borderStyle="round" borderColor="gray" paddingX={1}>
            <Box flexDirection="row" justifyContent="space-between">
              <Button key={`q-panel-code-${e.requestId}-${i}`} plain onPress={toggle}>
                <Text color="cyan">
                  {isOpen ? '▾' : '▸'} {seg.lang || 'text'}
                </Text>
              </Button>
              <Box flexDirection="row" columnGap={1}>
                <Text dimColor>
                  {lineCount} {lineCount === 1 ? 'line' : 'lines'}
                  {seg.closed ? '' : ' …'}
                </Text>
                {seg.closed && seg.code !== '' && (
                  <Button key={`q-panel-code-copy-${e.requestId}-${i}`} plain onPress={press => copyText($, seg.code, press.surface, 'Code')}>
                    <Text dimColor>[ copy ]</Text>
                  </Button>
                )}
                <Button key={`q-panel-code-fold-${e.requestId}-${i}`} plain onPress={toggle}>
                  <Text dimColor>[ {isOpen ? 'collapse' : 'expand'} ]</Text>
                </Button>
              </Box>
            </Box>
            {isOpen && seg.code !== '' && <Code source={seg.code} language={seg.lang || undefined} />}
          </Box>
        )
      }),
    )

    // The engine's own row opens a reply with a bullet and indents the text under it; a tree of
    // our own replaces that row, so the terminal gets both back here.
    if (e.surface !== 'terminal') return <Box flexDirection="column">{drawn}</Box>
    return (
      <Box flexDirection="row">
        <Box width={2} flexShrink={0}>
          <Text>{p.isFirstOfReply ? '⏺' : ' '}</Text>
        </Box>
        <Box flexDirection="column" flexGrow={1}>
          {drawn}
        </Box>
      </Box>
    )
  })
}
