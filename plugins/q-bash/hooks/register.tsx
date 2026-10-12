import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HistoryEntry, HistoryFilter, HistoryStatus, PanelView, BashSettings } from '../types'
import {
  BUILTIN_RULES,
  DEFAULT_SETTINGS,
  USAGE,
  clip,
  compileRules,
  diffStats,
  formatBytes,
  formatMs,
  gitBadges,
  headTail,
  lines,
  maskSecrets,
  matchRule,
  parseConfig,
  parseRuleArgs,
  parseTestSummary,
  previewTail,
  readOutput,
  showSettings,
  statusOf,
  summarizeHistory,
  toUnifiedDiff,
  type BashInput,
  type Line,
} from './lib'

const panel = atom({ plugin: 'q-bash', key: 'panel' } as const, null as PanelView | null)
const mode = atom({ plugin: 'q-bash', key: 'mode' } as const, { open: false, epoch: 0 })
const duration = atom({ plugin: 'q-bash', key: 'duration' } as const, 0)
const diffOpen = atom({ plugin: 'q-bash', key: 'diffOpen' } as const, false)
const revealed = atom({ plugin: 'q-bash', key: 'revealed' } as const, false)
const settings = atom({ plugin: 'q-bash', key: 'settings' } as const, DEFAULT_SETTINGS as BashSettings)
const history = atom({ plugin: 'q-bash', key: 'history' } as const, [] as HistoryEntry[])
const historyFilter = atom({ plugin: 'q-bash', key: 'historyFilter' } as const, 'all' as HistoryFilter)

const SETTINGS_KEY = 'settings'
const HISTORY_KEY = 'history'
const HISTORY_LIMIT = 200
// $.store holds 4 MiB for all keys: keep long heredoc commands from crowding out the settings.
const HISTORY_COMMAND_CHARS = 500

const HISTORY_PANE = 'q-bash-history'
const MAX_DIFF_LINES = 200

// ---- persistence: $.state for drawing, $.store to survive the session ------------------

const loadPersisted = async ($: EngineInterface) => {
  const saved = ((await $.store.get(SETTINGS_KEY)) ?? {}) as Partial<BashSettings>
  await update($, settings, () => ({ ...DEFAULT_SETTINGS, ...saved }))
  const past = ((await $.store.get(HISTORY_KEY)) ?? []) as HistoryEntry[]
  // Calls still marked running belong to a session that ended before they finished.
  await update($, history, () =>
    past.map(h => (h.status === 'running' ? { ...h, status: 'interrupted' as const } : h)).slice(-HISTORY_LIMIT),
  )
}

const saveSettings = async ($: EngineInterface, patch: Partial<BashSettings>) => {
  const next = { ...(await read($, settings)), ...patch }
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

const saveHistory = async ($: EngineInterface, fn: (list: HistoryEntry[]) => HistoryEntry[]) => {
  await update($, history, list => fn(list).slice(-HISTORY_LIMIT))
  await $.store.set(HISTORY_KEY, await read($, history))
}

const copyText = async ($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'], what: string) => {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `${what} copied` : `Could not copy: ${r.reason ?? 'no clipboard'}`)
}

const runGuard = async ($: EngineInterface, rest: string[]) => {
  const cfg = await read($, settings)
  const [sub, ...args] = rest
  if (sub === 'on' || sub === 'off') {
    await saveSettings($, { guard: sub === 'on' })
    return `Destructive-command guard is ${sub}.`
  }
  if (sub === 'add') {
    const { pattern, why } = parseRuleArgs(args.join(' '))
    if (!pattern) return 'Usage: /q-bash guard add <regex> [reason]'
    try {
      new RegExp(pattern)
    } catch {
      return `"${pattern}" is not a valid regular expression.`
    }
    await saveSettings($, { guardRules: [...cfg.guardRules, { pattern, why: why || `matches ${pattern}` }] })
    return `Guard rule added: ${pattern}`
  }
  if (sub === 'remove') {
    const n = Number(args[0])
    if (!Number.isInteger(n) || n < 1 || n > cfg.guardRules.length) return `No rule ${args[0] ?? ''}. See /q-bash guard list.`
    await saveSettings($, { guardRules: cfg.guardRules.filter((_, i) => i !== n - 1) })
    return `Guard rule ${n} removed.`
  }
  if (sub === undefined || sub === 'list') {
    return [
      `Guard is ${cfg.guard ? 'on' : 'off'}.`,
      'Built-in rules:',
      ...BUILTIN_RULES.map(r => `  - ${r.why}`),
      'Your rules:',
      ...(cfg.guardRules.length === 0 ? ['  (none)'] : cfg.guardRules.map((r, i) => `  ${i + 1}. ${r.pattern}  (${r.why})`)),
    ].join('\n')
  }
  return 'Usage: /q-bash guard on | off | list | add <regex> [reason] | remove <n>'
}

export const register: Register = on => {
  // ---- /q-bash command ------------------------------------------------------------------

  on('session.start', async ($, e, next) => {
    await loadPersisted($)
    await $.command.register({
      name: 'q-bash',
      description: 'Bash panels: expand-all, collapse-all, history, stats, config, guard',
      argumentHint: 'expand-all | collapse-all | history | stats | config | guard | help',
    })
    return next(e)
  })

  on('command.run', { command: 'q-bash' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)

    switch (sub) {
      case 'expand-all':
      case 'collapse-all': {
        const open = sub === 'expand-all'
        // A new epoch makes every panel's own earlier choice stale.
        await update($, mode, m => ({ open, epoch: m.epoch + 1 }))
        return { text: open ? 'Every Bash panel is expanded.' : 'Every Bash panel is collapsed.' }
      }
      case 'history':
        await $.ui.open({ id: HISTORY_PANE, title: 'Bash history' })
        return { text: 'Bash history pane opened.' }
      case 'stats': {
        const s = summarizeHistory(await read($, history))
        if (s.count === 0) return { text: 'No Bash commands recorded yet.' }
        return {
          text: [
            `${s.count} commands · ${s.failed} failed (${Math.round((s.failed / s.count) * 100)}%) · ${formatMs(s.total)} in the shell`,
            'Slowest:',
            ...s.slowest.map(h => `  ${formatMs(h.ms ?? 0).padStart(7)}  ${clip(h.command.split('\n')[0] ?? '', 70)}`),
            'Most run:',
            ...s.top.map(([cmd, n]) => `  ${String(n).padStart(4)}×  ${cmd}`),
          ].join('\n'),
        }
      }
      case 'config': {
        if (rest.length === 0) return { text: `q-bash settings:\n${showSettings(await read($, settings))}` }
        if (rest[0] === 'reset') {
          await saveSettings($, { ...DEFAULT_SETTINGS, guardRules: (await read($, settings)).guardRules })
          return { text: 'BashSettings restored to the defaults (guard rules kept).' }
        }
        const [key = '', value = ''] = rest
        const patch = parseConfig(key, value)
        if (typeof patch === 'string') return { text: patch, exitCode: 2 }
        await saveSettings($, patch)
        return { text: `${key} set to ${value}.` }
      }
      case 'guard':
        return { text: await runGuard($, rest) }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `${sub ? `Unknown subcommand "${sub}".\n` : ''}${USAGE}`, exitCode: 2 }
    }
  })

  // ---- guard: ask before destructive commands, even where rules or the mode would allow them

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    const cfg = await read($, settings)
    if (!cfg.guard || verdict.decision === 'deny') return verdict

    const command = (e.input as { command?: string } | undefined)?.command ?? ''
    const hit = matchRule(command, compileRules([...BUILTIN_RULES, ...cfg.guardRules]))
    return hit ? { ...verdict, decision: 'ask' as const, reason: `q-bash guard: ${hit.why}` } : verdict
  }).catch(() => ({ decision: 'ask' as const, reason: 'The q-bash guard failed; confirm this command yourself.' }))

  // ---- recorder: duration and history of every Bash call ---------------------------------

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const at = await $.clock.now()
    const id = e.tool_use_id ?? `local-${at}`
    const command = e.command.length > HISTORY_COMMAND_CHARS ? `${e.command.slice(0, HISTORY_COMMAND_CHARS)}…` : e.command
    // State only for now; the store is written once, when the call finishes.
    await update($, history, list => [...list, { id, command, status: 'running' as const, at }].slice(-HISTORY_LIMIT))

    let status: HistoryStatus = 'failed'
    try {
      const ran = await next(e)
      const result = ran.result as { interrupted?: boolean; backgroundTaskId?: string } | undefined
      status =
        ran.deny !== undefined
          ? 'denied'
          : result?.backgroundTaskId
            ? 'background'
            : result?.interrupted
              ? 'interrupted'
              : ran.isError
                ? 'failed'
                : 'done'
      return ran
    } finally {
      const ms = (await $.clock.now()) - at
      // The row's requestId is the tool_use_id, so the panel reads this member with memberOf(duration, e).
      await update($, memberOf(duration, { requestId: id }), () => ms)
      await saveHistory($, list => list.map(h => (h.id === id ? { ...h, status, ms } : h)))
    }
  }).catch(($, e, next) => next(e)) // a recorder failure must never block the command

  // ---- panel -----------------------------------------------------------------------------

  // Bash calls folded into a "ran N shell commands" line: unfold the group so each call gets its panel.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    (await read($, settings)).unfoldGroups && e.props.calls.some(c => c.tool === 'Bash')
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e),
  )

  // The panel draws the output and the diff itself, so the engine's result block under a Bash row is
  // dropped. Image output is the exception: the engine draws the picture, the panel cannot.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== 'Bash' || readOutput(e.props.output).isImage) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (p.tool !== 'Bash') return next(e)

    const { Box, Text, Button, Code } = $.ui.resolve(e)
    const cfg = await read($, settings)
    const input = (p.input ?? {}) as BashInput
    const command = input.command ?? ''
    const out = readOutput(p.output)

    // A panel's own choice wins until the next expand-all / collapse-all bumps the epoch.
    const m = await read($, mode)
    const own = await read($, memberOf(panel, e))
    const isOpen = own && own.epoch === m.epoch ? own.open : m.open
    const toggle = () => update($, memberOf(panel, e), () => ({ open: !isOpen, epoch: m.epoch }))

    const width = Math.max(20, (e.viewport?.columns ?? 100) - 6)
    const ms = await read($, memberOf(duration, e))
    const isRevealed = await read($, memberOf(revealed, e))
    const showDiff = await read($, memberOf(diffOpen, e))

    // Output, with token-like strings masked for display unless the person revealed them.
    let masked = 0
    const forDisplay = (s: string | undefined) => {
      if (!s || !cfg.maskSecrets || isRevealed) return s
      const r = maskSecrets(s)
      masked += r.count
      return r.text
    }
    const shownStdout = out.isImage ? undefined : forDisplay(out.stdout)
    const shownStderr = forDisplay(out.stderr)
    const stdout = lines(shownStdout)
    const stderr = lines(shownStderr)
    const all: Line[] = [...stdout.map(t => ({ t, err: false })), ...stderr.map(t => ({ t, err: true }))]

    const [status, color] = statusOf(p, out)
    const took = ms > 0 && !p.isRunning ? ` · ${formatMs(ms)}` : ''
    const isSlow = ms >= cfg.slowMs

    const cmdLines = command.split('\n')
    const head = clip(cmdLines[0] ?? '', width - 8 - status.length - took.length) + (cmdLines.length > 1 ? ' …' : '')

    const tests = p.isRunning ? undefined : parseTestSummary(`${out.stdout ?? ''}\n${out.stderr ?? ''}`)
    const files = out.bashEditDiff?.files ?? []
    const moreFiles = out.bashEditDiff?.moreFiles ?? 0
    const stats = diffStats(files)
    const badges: { text: string; color: string }[] = [
      ...gitBadges(out).map(text => ({ text, color: 'green' })),
      ...(files.length > 0 ? [{ text: `${files.length + moreFiles} files · +${stats.added} −${stats.removed}`, color: 'blue' }] : []),
      ...(tests ? [{ text: `✓ ${tests.passed}  ✗ ${tests.failed}  ○ ${tests.skipped}`, color: tests.failed > 0 ? 'red' : 'green' }] : []),
      ...(input.dangerouslyDisableSandbox ? [{ text: '⚠ unsandboxed', color: 'red' }] : []),
    ]

    const preview = previewTail(stdout, stderr, cfg.previewLines)
    const hiddenBefore = all.length - preview.length
    const expanded = headTail(all, cfg.maxExpandedLines)
    const prUrl = out.gitOperation?.pr?.url
    const savedPath = out.persistedOutputPath

    // Copies carry what the panel shows: masked secrets stay masked until revealed.
    const outputText = [shownStdout, shownStderr].filter(Boolean).join('\n').trimEnd()
    const markdown = `\`\`\`console\n$ ${command}\n${outputText}\n\`\`\``

    const drawLine = ({ t, err }: Line, i: number) => (
      <Text key={`l${i}`} color={err ? 'red' : undefined} dimColor={!err && !isOpen}>
        {isOpen ? t : clip(t, width)}
      </Text>
    )

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button key={`q-bash-${e.requestId}`} plain onPress={toggle}>
            <Text color={color}>{isOpen ? '▾' : '▸'} </Text>
            <Text bold backgroundColor={cfg.commandBg}>
              $ {head}
            </Text>
          </Button>
          <Text color={color}>
            {' '}
            {status}
            {took && <Text color={isSlow ? 'yellow' : color}>{took}</Text>}
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
          <Box flexDirection="column" marginTop={1} backgroundColor={cfg.commandBg}>
            {cmdLines.map((l, i) => (
              <Text key={`c${i}`} bold>
                {l}
              </Text>
            ))}
          </Box>
        )}

        {all.length > 0 && (
          <Box flexDirection="column" marginTop={isOpen ? 1 : 0} backgroundColor={cfg.outputBg}>
            {!isOpen && hiddenBefore > 0 && <Text dimColor>… {hiddenBefore} earlier lines</Text>}
            {!isOpen && preview.map(drawLine)}
            {isOpen && expanded.head.map(drawLine)}
            {isOpen && expanded.gap > 0 && <Text dimColor>… {expanded.gap} lines hidden …</Text>}
            {isOpen && expanded.tail.map((l, i) => drawLine(l, expanded.head.length + i))}
          </Box>
        )}

        {out.isImage && <Text dimColor>(image output, drawn below)</Text>}
        {!p.isRunning && !out.isImage && !out.backgroundTaskId && all.length === 0 && <Text dimColor>(no output)</Text>}
        {savedPath && (
          <Text dimColor>
            full output{out.persistedOutputSize ? ` (${formatBytes(out.persistedOutputSize)})` : ''} saved at {savedPath}
          </Text>
        )}

        {showDiff && files.length > 0 && (
          <Box flexDirection="column" marginTop={1}>
            {files.map((f, i) => (
              <Code
                key={`d${i}`}
                source={toUnifiedDiff(f).split('\n').slice(0, MAX_DIFF_LINES).join('\n')}
                format="diff"
                path={f.filePath}
              />
            ))}
            {moreFiles > 0 && <Text dimColor>… {moreFiles} more files</Text>}
          </Box>
        )}

        <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
          <Button key={`q-bash-toggle-${e.requestId}`} plain onPress={toggle}>
            <Text dimColor>{isOpen ? '[ collapse ]' : '[ show details ]'}</Text>
          </Button>
          <Button key={`q-bash-copy-${e.requestId}`} plain onPress={press => copyText($, command, press.surface, 'Command')}>
            <Text dimColor>[ copy command ]</Text>
          </Button>
          {outputText !== '' && (
            <Button key={`q-bash-copy-out-${e.requestId}`} plain onPress={press => copyText($, outputText, press.surface, 'Output')}>
              <Text dimColor>[ copy output ]</Text>
            </Button>
          )}
          {!p.isRunning && (
            <Button key={`q-bash-copy-md-${e.requestId}`} plain onPress={press => copyText($, markdown, press.surface, 'Markdown')}>
              <Text dimColor>[ copy as markdown ]</Text>
            </Button>
          )}
          {files.length > 0 && (
            <Button key={`q-bash-diff-${e.requestId}`} plain onPress={() => update($, memberOf(diffOpen, e), v => !v)}>
              <Text dimColor>{showDiff ? '[ hide diff ]' : '[ show diff ]'}</Text>
            </Button>
          )}
          {prUrl && (
            <Button key={`q-bash-pr-${e.requestId}`} plain onPress={press => copyText($, prUrl, press.surface, 'PR link')}>
              <Text dimColor>[ copy PR link ]</Text>
            </Button>
          )}
          {savedPath && (
            <Button key={`q-bash-path-${e.requestId}`} plain onPress={press => copyText($, savedPath, press.surface, 'Path')}>
              <Text dimColor>[ copy path ]</Text>
            </Button>
          )}
          {(masked > 0 || isRevealed) && (
            <Button key={`q-bash-reveal-${e.requestId}`} plain onPress={() => update($, memberOf(revealed, e), v => !v)}>
              <Text color="yellow">{isRevealed ? '[ hide secrets ]' : `[ reveal ${masked} secret${masked > 1 ? 's' : ''} ]`}</Text>
            </Button>
          )}
        </Box>
      </Box>
    )
  })

  // ---- history pane ----------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: HISTORY_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const filter = await read($, historyFilter)
    const list = (await read($, history)).filter(h => filter === 'all' || h.status === 'failed' || h.status === 'denied')
    const width = Math.max(20, e.props.bodyColumns - 12)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 6)
    const glyph = { running: '…', done: '✓', failed: '✗', interrupted: '■', background: '⧗', denied: '⊘' } as const
    const tone = { running: 'yellow', done: 'green', failed: 'red', interrupted: 'yellow', background: 'blue', denied: 'red' } as const

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          <Button key="filter-all" hotkey="a" label={filter === 'all' ? 'All ●' : 'All'} onPress={() => update($, historyFilter, () => 'all')} />
          <Button
            key="filter-failed"
            hotkey="f"
            label={filter === 'failed' ? 'Failed ●' : 'Failed'}
            onPress={() => update($, historyFilter, () => 'failed')}
          />
          <Button key="clear" hotkey="c" label="Clear" onPress={() => saveHistory($, () => [])} />
        </Box>
        {list.length === 0 && <Text dimColor>{filter === 'all' ? 'No Bash commands yet.' : 'No failed commands.'}</Text>}
        {list
          .slice(-room)
          .reverse()
          .map(h => (
            <Button key={`h-${h.id}`} plain onPress={press => copyText($, h.command, press.surface, 'Command')}>
              <Text color={tone[h.status]}>{glyph[h.status]} </Text>
              <Text dimColor>{(h.ms === undefined ? '' : formatMs(h.ms)).padStart(7)} </Text>
              {clip(h.command.split('\n')[0] ?? '', width)}
            </Button>
          ))}
        <Text dimColor>Press a row to copy its command.</Text>
      </Box>
    )
  })
}
