import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BashSettings, FileEntry, FilesFilter, HistoryEntry, HistoryFilter, HistoryStatus, PanelView, TodoItem, TurnStats } from '../types'
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
import {
  addToTurn,
  hasActivity,
  fileNotes,
  filterFiles,
  formatTokens,
  newTurn,
  progressBar,
  readSummary,
  recordCall,
  seenLabel,
  todoChanges,
  turnParts,
} from './ledger'

const panel = atom({ plugin: 'q-bash', key: 'panel' } as const, null as PanelView | null)
const mode = atom({ plugin: 'q-bash', key: 'mode' } as const, { open: false, epoch: 0 })
const duration = atom({ plugin: 'q-bash', key: 'duration' } as const, 0)
const diffOpen = atom({ plugin: 'q-bash', key: 'diffOpen' } as const, false)
const revealed = atom({ plugin: 'q-bash', key: 'revealed' } as const, false)
const settings = atom({ plugin: 'q-bash', key: 'settings' } as const, DEFAULT_SETTINGS as BashSettings)
const history = atom({ plugin: 'q-bash', key: 'history' } as const, [] as HistoryEntry[])
const historyFilter = atom({ plugin: 'q-bash', key: 'historyFilter' } as const, 'all' as HistoryFilter)

const ledger = atom({ plugin: 'q-bash', key: 'ledger' } as const, [] as FileEntry[])
const turn = atom({ plugin: 'q-bash', key: 'turn' } as const, null as TurnStats | null)
const lastTurn = atom({ plugin: 'q-bash', key: 'lastTurn' } as const, null as TurnStats | null)
const bandHidden = atom({ plugin: 'q-bash', key: 'bandHidden' } as const, false)
const filesFilter = atom({ plugin: 'q-bash', key: 'filesFilter' } as const, 'all' as FilesFilter)
const agentNames = atom({ plugin: 'q-bash', key: 'agentNames' } as const, {} as Record<string, string>)
const reportOpen = atom({ plugin: 'q-bash', key: 'reportOpen' } as const, false)

const SETTINGS_KEY = 'settings'

const saveSettings = async ($: EngineInterface, patch: Partial<BashSettings>) => {
  const next = { ...(await read($, settings)), ...patch }
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

const FILES_PANE = 'q-bash-files'
const FEATURES_PANE = 'q-bash-features'

const TRACKED = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash', 'Agent'])

type AgentDone = {
  status: 'completed'
  agentId: string
  agentType?: string
  resolvedModel?: string
  content: { type: 'text'; text: string }[]
  totalToolUseCount: number
  totalDurationMs: number
  totalTokens: number
  toolStats?: { readCount: number; searchCount: number; bashCount: number; editFileCount: number; linesAdded: number; linesRemoved: number; otherToolCount: number }
  prompt: string
  worktreeBranch?: string
}

const agentDone = (output: unknown): AgentDone | undefined =>
  output && typeof output === 'object' && (output as { status?: string }).status === 'completed' ? (output as AgentDone) : undefined

const todosOf = (output: unknown): { oldTodos: TodoItem[]; newTodos: TodoItem[] } | undefined => {
  const o = output as { oldTodos?: TodoItem[]; newTodos?: TodoItem[] } | undefined
  return o && Array.isArray(o.newTodos) ? { oldTodos: o.oldTodos ?? [], newTodos: o.newTodos } : undefined
}

const FEATURES: { key: keyof BashSettings; hotkey: string; name: string; what: string }[] = [
  { key: 'band', hotkey: 't', name: 'Turn band', what: 'one line above the prompt: files read and changed, bash, agents' },
  { key: 'readSummary', hotkey: 'r', name: 'Read summary', what: 'under each Read: which lines, how much of the file' },
  { key: 'agentPanel', hotkey: 'a', name: 'Agent card', what: 'a finished subagent as one card with its stats' },
  { key: 'todoPanel', hotkey: 'o', name: 'Todo progress', what: 'TodoWrite as a progress bar and what changed' },
  { key: 'unfoldGroups', hotkey: 'u', name: 'Unfold Bash groups', what: 'each Bash call in its own panel' },
  { key: 'maskSecrets', hotkey: 's', name: 'Mask secrets', what: 'hide token-like strings in Bash output' },
  { key: 'guard', hotkey: 'g', name: 'Guard', what: 'ask before destructive Bash commands' },
]


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
      description: 'Bash panels, files ledger and turn band: expand-all, collapse-all, history, files, features, stats, config, guard',
      argumentHint: 'expand-all | collapse-all | history | files | features | stats | config | guard | help',
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
      case 'files':
        await $.ui.open({ id: FILES_PANE, title: 'Files' })
        return { text: 'Files pane opened.' }
      case 'features':
        await $.ui.open({ id: FEATURES_PANE, title: 'q-bash features' })
        return { text: 'Features pane opened.' }
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
      <Box flexDirection="column" width="100%" borderStyle="round" borderColor={color} paddingX={1}>
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

  // ---- recorder: every tracked tool call feeds the ledger and the turn ------------------

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    // Keep the previous turn on show until this one does something: a follow-up turn
    // with no tool calls (the reply after a background agent) would blank the band.
    const prev = await read($, turn)
    if (prev && hasActivity(prev)) await update($, lastTurn, () => prev)
    await update($, turn, () => newTurn(e.turnId, at))
    await update($, bandHidden, () => false)
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined) await update($, turn, t => (t && t.turnId === e.turnId ? { ...t, isRunning: false, ms: e.durationMs } : t))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const ran = await next(e)
    if (!TRACKED.has(String(e.tool))) return ran
    try {
      const input = e as unknown as Record<string, unknown>
      const at = await $.clock.now()
      const root = await $.session.root()
      const before = await read($, ledger)
      const { ledger: after, delta } = recordCall(before, root, {
        tool: String(e.tool),
        input,
        result: ran.result,
        isError: ran.isError === true || ran.deny !== undefined,
        agentId: e.agentId,
        at,
      })
      if (after !== before) await update($, ledger, () => after)
      if (Object.keys(delta).length > 0) await update($, turn, t => (t ? addToTurn(t, delta) : t))
      // Name the subagent for the files pane, from a finished or a backgrounded launch.
      const launched = String(e.tool) === 'Agent' ? (ran.result as { agentId?: string; agentType?: string } | undefined) : undefined
      if (launched?.agentId) {
        const id = launched.agentId
        await update($, agentNames, m => ({ ...m, [id]: launched.agentType ?? String(input.subagent_type ?? 'agent') }))
      }
    } catch {
      // The ledger is a view; a failure here must never change the call.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---- turn band above the prompt ---------------------------------------------------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const cfg = await read($, settings)
    const current = await read($, turn)
    const t = current && hasActivity(current) ? current : await read($, lastTurn)
    if (e.props.hasSurvey || !cfg.band || !t || (await read($, bandHidden))) return next(e)
    const files = await read($, ledger)
    const inTurn = new Set(t.files)
    const touched = files.filter(f => inTurn.has(f.path))
    const readFiles = touched.filter(f => f.reads > 0).length
    const changed = touched.filter(f => f.edits + f.writes > 0).length
    const parts = turnParts(t, readFiles, changed)
    if (parts.length === 0) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const head = t.isRunning ? 'this turn' : `last turn · ${formatMs(t.ms ?? 0)}`
    return (
      <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
        <Text dimColor>{head}</Text>
        {parts.map((p, i) => (
          <Text key={`p${i}`} color={p.tone}>
            {p.text}
          </Text>
        ))}
        <Button key="band-files" hotkey="f" label="Files" onPress={() => $.ui.open({ id: FILES_PANE, title: 'Files' })} />
        <Button key="band-hide" hotkey="x" label="Hide" onPress={() => update($, bandHidden, () => true)} />
      </Box>
    )
  })

  // ---- files pane --------------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: FILES_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const filter = await read($, filesFilter)
    const names = await read($, agentNames)
    const all = await read($, ledger)
    const list = filterFiles(all, filter).sort((a, b) => b.last - a.last)
    const width = Math.max(20, e.props.bodyColumns - 26)
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 7)
    const tab = (f: FilesFilter, label: string, hotkey: string) => (
      <Button key={`ff-${f}`} hotkey={hotkey} label={filter === f ? `${label} ●` : label} onPress={() => update($, filesFilter, () => f)} />
    )
    const n = (v: number) => (v === 0 ? '·' : String(v)).padStart(2)
    const totals = all.reduce((s, f) => ({ added: s.added + f.added, removed: s.removed + f.removed }), { added: 0, removed: 0 })

    return (
      <Box flexDirection="column">
        <Box flexDirection="row" columnGap={2}>
          {tab('all', 'All', 'a')}
          {tab('edited', 'Changed', 'e')}
          {tab('read', 'Read only', 'r')}
          {tab('agent', 'By agents', 'g')}
          <Button key="ff-clear" hotkey="c" label="Clear" onPress={() => update($, ledger, () => [])} />
        </Box>
        <Text dimColor>
          {all.length} files · {all.filter(f => f.edits + f.writes > 0).length} changed · +{totals.added} −{totals.removed}
        </Text>
        <Text dimColor> R  E  W   +/−         seen  file</Text>
        {list.length === 0 && <Text dimColor>{all.length === 0 ? 'No files read or changed yet.' : 'No files match this filter.'}</Text>}
        {list.slice(0, room).map(f => {
          const notes = fileNotes(f)
          const by = f.agents.map(id => names[id] ?? 'agent')
          const diff = f.added + f.removed > 0 ? `+${f.added} −${f.removed}` : ''
          return (
            <Button key={`f-${f.path}`} plain onPress={press => copyText($, f.path, press.surface, 'Path')}>
              <Text>
                {n(f.reads)} {n(f.edits)} {n(f.writes)}{'   '}
              </Text>
              <Text color={diff ? 'green' : undefined}>{diff.padEnd(11)}</Text>
              <Text color={seenLabel(f) === '100%' || seenLabel(f) === 'new' ? 'green' : 'yellow'}>{seenLabel(f).padStart(5)}</Text>
              <Text>{'  '}{clip(f.path, width)}</Text>
              {notes.map((x, i) => (
                <Text key={`n${i}`} color={x.tone === 'dim' ? undefined : x.tone} dimColor={x.tone === 'dim'}>
                  {'  '}
                  {x.text}
                </Text>
              ))}
              {by.length > 0 && <Text color="blue">{`  via ${[...new Set(by)].join(', ')}`}</Text>}
            </Button>
          )
        })}
        {list.length > room && <Text dimColor>… {list.length - room} more</Text>}
        <Text dimColor>R reads · E edits · W writes · seen = share of lines read · press a row to copy its path</Text>
      </Box>
    )
  })

  // ---- features pane: turn each view on or off --------------------------------------------

  on('ui.render', { component: 'Pane', requestId: FEATURES_PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const cfg = await read($, settings)
    return (
      <Box flexDirection="column">
        <Text dimColor>Press a letter (or click) to turn a feature on or off. Saved for every session.</Text>
        {FEATURES.map(f => {
          const isOn = cfg[f.key] === true
          return (
            <Box key={`feat-${f.key}`} flexDirection="row" columnGap={1}>
              <Button key={`feat-btn-${f.key}`} hotkey={f.hotkey} label={`${isOn ? '●' : '○'} ${f.name}`} onPress={() => saveSettings($, { [f.key]: !isOn })} />
              <Text wrap="truncate-end">
                <Text color={isOn ? 'green' : undefined} dimColor={!isOn}>
                  {isOn ? 'on ' : 'off'}
                </Text>
                <Text dimColor>{`  ${f.what}`}</Text>
              </Text>
            </Box>
          )
        })}
      </Box>
    )
  })

  // ---- Read: a line saying how much of the file was read ------------------------------------

  on('ui.render', { component: 'ToolResult' }, async ($, e, next) => {
    const p = e.props
    if (p.isErrored) return next(e)
    const cfg = await read($, settings)

    if (p.tool === 'Read' && cfg.readSummary) {
      const path = (p.output as { file?: { filePath?: string } } | undefined)?.file?.filePath
      const entry = path ? (await read($, ledger)).find(f => path.endsWith(f.path)) : undefined
      const line = readSummary(p.output, entry)
      if (!line) return next(e)
      const { Text } = $.ui.resolve(e)
      const partial = !line.startsWith('all ') && line !== 'empty file'
      return <Text color={partial ? 'yellow' : undefined} dimColor={!partial}>{line}</Text>
    }
    // The cards below draw the whole result, so the engine's block under them is dropped.
    if (p.tool === 'Agent' && cfg.agentPanel && agentDone(p.output)) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    if (p.tool === 'TodoWrite' && cfg.todoPanel && todosOf(p.output)) {
      const { Box } = $.ui.resolve(e)
      return <Box />
    }
    return next(e)
  })

  // ---- Agent card and Todo progress --------------------------------------------------------

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if ((p.tool !== 'Agent' && p.tool !== 'TodoWrite') || p.isRunning) return next(e)
    const cfg = await read($, settings)
    const width = Math.max(20, (e.viewport?.columns ?? 100) - 6)

    if (p.tool === 'Agent' && cfg.agentPanel) {
      const a = agentDone(p.output)
      if (!a) return next(e)
      const { Box, Text, Button, Markdown } = $.ui.resolve(e)
      const input = (p.input ?? {}) as { description?: string; subagent_type?: string }
      const isOpen = await read($, memberOf(reportOpen, e))
      const report = a.content.map(c => c.text).join('\n').trim()
      const s = a.toolStats
      const badges = s
        ? [
            s.readCount > 0 && `read ${s.readCount}`,
            s.searchCount > 0 && `search ${s.searchCount}`,
            s.bashCount > 0 && `bash ${s.bashCount}`,
            s.editFileCount > 0 && `${s.editFileCount} file${s.editFileCount === 1 ? '' : 's'} +${s.linesAdded} −${s.linesRemoved}`,
            s.otherToolCount > 0 && `other ${s.otherToolCount}`,
          ].filter((b): b is string => typeof b === 'string')
        : []
      const title = `Agent · ${a.agentType ?? input.subagent_type ?? 'general-purpose'}`
      return (
        <Box flexDirection="column" width="100%" borderStyle="round" borderColor="magenta" paddingX={1}>
          <Box flexDirection="row" justifyContent="space-between">
            <Button key={`q-agent-${e.requestId}`} plain onPress={() => update($, memberOf(reportOpen, e), v => !v)}>
              <Text color="magenta">{isOpen ? '▾' : '▸'} </Text>
              <Text bold>{title}</Text>
              <Text> {clip(input.description ?? '', Math.max(10, width - title.length - 24))}</Text>
            </Button>
            <Text color="green"> done · {formatMs(a.totalDurationMs)}</Text>
          </Box>
          <Text dimColor>
            {[a.resolvedModel, `${formatTokens(a.totalTokens)} tokens`, `${a.totalToolUseCount} tool calls`].filter(Boolean).join(' · ')}
          </Text>
          {badges.length > 0 && (
            <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
              {badges.map((b, i) => (
                <Text key={`ab${i}`} color="blue">
                  [{b}]
                </Text>
              ))}
            </Box>
          )}
          {a.worktreeBranch && <Text dimColor>worktree branch: {a.worktreeBranch}</Text>}
          {isOpen && report !== '' && (
            <Box flexDirection="column" marginTop={1}>
              <Markdown text={report} />
            </Box>
          )}
          <Box flexDirection="row" flexWrap="wrap" columnGap={2}>
            <Button key={`q-agent-toggle-${e.requestId}`} plain onPress={() => update($, memberOf(reportOpen, e), v => !v)}>
              <Text dimColor>{isOpen ? '[ hide report ]' : '[ show report ]'}</Text>
            </Button>
            <Button key={`q-agent-copy-${e.requestId}`} plain onPress={press => copyText($, report, press.surface, 'Report')}>
              <Text dimColor>[ copy report ]</Text>
            </Button>
            <Button key={`q-agent-prompt-${e.requestId}`} plain onPress={press => copyText($, a.prompt, press.surface, 'Prompt')}>
              <Text dimColor>[ copy prompt ]</Text>
            </Button>
          </Box>
        </Box>
      )
    }

    if (p.tool === 'TodoWrite' && cfg.todoPanel) {
      const todos = todosOf(p.output)
      if (!todos) return next(e)
      const { Box, Text } = $.ui.resolve(e)
      const items = todoChanges(todos.oldTodos, todos.newTodos)
      const done = items.filter(t => t.status === 'completed').length
      const pct = items.length === 0 ? 0 : Math.round((done / items.length) * 100)
      const bar = progressBar(done, items.length, Math.min(30, Math.max(10, width - 30)))
      const glyph = { completed: '✓', in_progress: '▸', pending: '○' } as const
      const tone = { completed: 'green', in_progress: 'yellow', pending: undefined } as const
      return (
        <Box flexDirection="column" width="100%" borderStyle="round" borderColor="blue" paddingX={1}>
          <Box flexDirection="row" columnGap={1}>
            <Text bold>Todos</Text>
            <Text>
              {done}/{items.length}
            </Text>
            <Text color="blue">{bar}</Text>
            <Text>{pct}%</Text>
          </Box>
          {items.map((t, i) => (
            <Box key={`t${i}`} flexDirection="row">
              <Text color={tone[t.status]} dimColor={t.status === 'pending'}>
                {glyph[t.status]} {clip(t.status === 'in_progress' ? t.activeForm : t.content, width - 18)}
              </Text>
              {t.change && <Text color="yellow">{`  ← ${t.change}`}</Text>}
            </Box>
          ))}
        </Box>
      )
    }
    return next(e)
  })
}
