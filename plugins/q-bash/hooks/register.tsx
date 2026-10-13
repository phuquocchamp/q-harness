import { atom, memberOf, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { BashSettings } from '../types'
import {
  BUILTIN_RULES,
  DEFAULT_SETTINGS,
  MAX_EXPANDED_LINES,
  SLOW_MS,
  USAGE,
  clip,
  compileRules,
  diffStats,
  formatBytes,
  formatMs,
  gitBadges,
  headTail,
  lines,
  matchRule,
  parseConfig,
  parseTestSummary,
  pickSettings,
  previewTail,
  readOutput,
  showSettings,
  statusOf,
  type BashInput,
  type Line,
} from './lib'

const open = atom({ plugin: 'q-bash', key: 'open' } as const, false)
const duration = atom({ plugin: 'q-bash', key: 'duration' } as const, 0)
const settings = atom({ plugin: 'q-bash', key: 'settings' } as const, DEFAULT_SETTINGS as BashSettings)

const SETTINGS_KEY = 'settings'
// Written by q-bash 0.2 and 0.3: raw commands from every project. 0.4 keeps no history and deletes it.
const LEGACY_HISTORY_KEY = 'history'

const RULES = compileRules(BUILTIN_RULES)

const saveSettings = async ($: EngineInterface, next: BashSettings) => {
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

export const register: Register = on => {
  // ---- settings and the /q-bash command --------------------------------------------------

  on('session.start', async ($, e, next) => {
    try {
      const saved = await $.store.get(SETTINGS_KEY)
      await update($, settings, () => pickSettings(saved))
      await $.store.delete(LEGACY_HISTORY_KEY)
    } catch {
      // Defaults stand when the store cannot be read.
    }
    await $.command.register({
      name: 'q-bash',
      description: 'Bash panels and the destructive-command guard: config, help',
      argumentHint: 'config [<key> <value> | reset] | help',
    })
    return next(e)
  })

  on('command.run', { command: 'q-bash' }, async ($, e) => {
    const [sub = '', ...rest] = e.args.trim().split(/\s+/).filter(Boolean)
    if (sub === 'help') return { text: USAGE }
    if (sub !== 'config') return { text: `${sub ? `Unknown subcommand "${sub}".\n` : ''}${USAGE}`, exitCode: 2 }

    const cfg = await read($, settings)
    if (rest.length === 0) return { text: `q-bash settings:\n${showSettings(cfg)}` }
    if (rest[0] === 'reset') {
      await saveSettings($, DEFAULT_SETTINGS)
      return { text: 'q-bash settings restored to the defaults.' }
    }
    const [key = '', value = ''] = rest
    const patch = parseConfig(key, value)
    if (typeof patch === 'string') return { text: patch, exitCode: 2 }
    await saveSettings($, { ...cfg, ...patch })
    return { text: `${key} set to ${value}.` }
  })

  // ---- guard: ask before destructive commands, even where rules or the mode would allow them

  on('tool.check', { tool: 'Bash' }, async ($, e, next) => {
    const verdict = await next(e)
    if (!(await read($, settings)).guard || verdict.decision === 'deny') return verdict
    const command = (e.input as { command?: string } | undefined)?.command ?? ''
    const hit = matchRule(command, RULES)
    return hit ? { ...verdict, decision: 'ask' as const, reason: `q-bash guard: ${hit.why}` } : verdict
  }).catch(() => ({ decision: 'ask' as const, reason: 'The q-bash guard failed; confirm this command yourself.' }))

  // ---- duration of each Bash call (session state only, nothing stored) -------------------

  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const at = await $.clock.now()
    try {
      return await next(e)
    } finally {
      // The row's requestId is the tool_use_id, so the panel reads this member with memberOf(duration, e).
      if (e.tool_use_id) {
        const ms = (await $.clock.now()) - at
        await update($, memberOf(duration, { requestId: e.tool_use_id }), () => ms)
      }
    }
  }).catch(($, e, next) => next(e)) // a timing failure must never block the command

  // ---- panel -----------------------------------------------------------------------------

  // A group made only of Bash calls is unfolded so each call gets its panel. A mixed group
  // (Bash with Read, Grep, …) stays folded: unfolding it would put every read on screen too.
  on('ui.render', { component: 'ToolGroup' }, async ($, e, next) =>
    (await read($, settings)).unfoldGroups && e.props.calls.length > 0 && e.props.calls.every(c => c.tool === 'Bash')
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e),
  )

  // The panel draws the output itself, so the engine's result block under a Bash row is
  // dropped. Image output is the exception: the engine draws the picture, the panel cannot.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== 'Bash' || readOutput(e.props.output).isImage) return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

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

    const [status, color] = statusOf(p, out)
    const took = ms > 0 && !p.isRunning ? ` · ${formatMs(ms)}` : ''

    const cmdLines = command.split('\n')
    const head = clip(cmdLines[0] ?? '', width - 8 - status.length - took.length) + (cmdLines.length > 1 ? ' …' : '')

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
          <Button key={`q-bash-${e.requestId}`} plain onPress={toggle}>
            <Text color={color}>{isOpen ? '▾' : '▸'} </Text>
            <Text bold>
              $ {head}
            </Text>
          </Button>
          <Text color={color}>
            {' '}
            {status}
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
          <Button key={`q-bash-copy-${e.requestId}`} plain onPress={press => copyCommand($, command, press.surface)}>
            <Text dimColor>[ copy command ]</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}

const copyCommand = async ($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? 'Command copied' : `Could not copy: ${r.reason ?? 'no clipboard'}`)
}
