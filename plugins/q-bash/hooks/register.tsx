import { atom, memberOf, read, update } from 'claude-code'
import type { Register } from 'claude-code'

const expanded = atom({ plugin: 'q-bash', key: 'expanded' } as const, false)
const expandAll = atom({ plugin: 'q-bash', key: 'expandAll' } as const, false)

const PREVIEW_LINES = 4
const MAX_EXPANDED_LINES = 400

type BashInput = { command?: string; description?: string; run_in_background?: boolean }
type BashOutput = { stdout?: string; stderr?: string; interrupted?: boolean }

const lines = (text: string | undefined) =>
  (text ?? '').replace(/\s+$/, '').split('\n').filter((l, i, all) => l !== '' || i < all.length - 1)

const clip = (line: string, width: number) =>
  line.length > width ? line.slice(0, Math.max(1, width - 1)) + '…' : line

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: 'q-bash',
      description: 'Bash panels: expand-all | collapse-all',
      argumentHint: 'expand-all | collapse-all',
    })
    return next(e)
  })

  on('command.run', { command: 'q-bash' }, async ($, e) => {
    const open = e.args.trim() === 'expand-all'
    await update($, expandAll, () => open)
    return { text: open ? 'Every Bash panel is expanded.' : 'Bash panels are collapsed (click a header to open one).' }
  })

  // Bash calls folded into a "ran N shell commands" line: unfold the group so each call gets its panel.
  on('ui.render', { component: 'ToolGroup' }, ($, e, next) =>
    e.props.calls.some(c => c.tool === 'Bash')
      ? next({ ...e, props: { ...e.props, isExpanded: true } })
      : next(e),
  )

  // The panel draws the output itself, so the engine's own result block under a Bash row is dropped.
  on('ui.render', { component: 'ToolResult' }, ($, e, next) => {
    if (e.props.tool !== 'Bash') return next(e)
    const { Box } = $.ui.resolve(e)
    return <Box />
  })

  on('ui.render', { component: 'ToolUse' }, async ($, e, next) => {
    const p = e.props
    if (p.tool !== 'Bash') return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const input = (p.input ?? {}) as BashInput
    const command = input.command ?? ''
    const isOpen = (await read($, expandAll)) || (await read($, memberOf(expanded, e)))
    const width = Math.max(20, (e.viewport?.columns ?? 100) - 6)

    // Output: the Bash record once resolved; the error text the model read when it failed.
    const out: BashOutput =
      typeof p.output === 'string' ? { stderr: p.output } : ((p.output ?? {}) as BashOutput)
    const stdout = lines(out.stdout)
    const stderr = lines(out.stderr)
    const all = [...stdout.map(t => ({ t, err: false })), ...stderr.map(t => ({ t, err: true }))]

    const [status, color] = p.isRunning
      ? ['running…', 'yellow']
      : p.isInterrupted || out.interrupted
        ? ['interrupted', 'yellow']
        : p.isErrored
          ? ['failed', 'red']
          : ['done', 'green']

    const cmdLines = command.split('\n')
    const head = clip(cmdLines[0] ?? '', width - 16) + (cmdLines.length > 1 ? ' …' : '')

    const shown = isOpen ? all.slice(0, MAX_EXPANDED_LINES) : all.slice(-PREVIEW_LINES)
    const hidden = all.length - shown.length

    return (
      <Box flexDirection="column" borderStyle="round" borderColor={color} paddingX={1}>
        <Box flexDirection="row" justifyContent="space-between">
          <Button
            key={`q-bash-${e.requestId}`}
            plain
            onPress={() => update($, memberOf(expanded, e), v => !v)}
          >
            <Text color={color}>{isOpen ? '▾' : '▸'} </Text>
            <Text bold>$ {head}</Text>
          </Button>
          <Text color={color}> {status}</Text>
        </Box>

        {input.description && <Text dimColor>{input.description}</Text>}

        {isOpen && cmdLines.length > 1 && (
          <Box flexDirection="column" marginTop={1}>
            {cmdLines.map(l => (
              <Text bold>{l}</Text>
            ))}
          </Box>
        )}

        {shown.length > 0 && (
          <Box flexDirection="column" marginTop={isOpen ? 1 : 0}>
            <Text dimColor>{'─'.repeat(Math.min(width, 60))}</Text>
            {!isOpen && hidden > 0 && <Text dimColor>… {hidden} earlier lines</Text>}
            {shown.map(({ t, err }) => (
              <Text color={err ? 'red' : undefined} dimColor={!err && !isOpen}>
                {isOpen ? t : clip(t, width)}
              </Text>
            ))}
            {isOpen && hidden > 0 && <Text dimColor>… {hidden} more lines not drawn</Text>}
          </Box>
        )}

        {!p.isRunning && all.length === 0 && <Text dimColor>(no output)</Text>}

        <Box flexDirection="row" gap={2}>
          <Button
            key={`q-bash-toggle-${e.requestId}`}
            plain
            onPress={() => update($, memberOf(expanded, e), v => !v)}
          >
            <Text dimColor>{isOpen ? '[ collapse ]' : '[ show details ]'}</Text>
          </Button>
          <Button
            key={`q-bash-copy-${e.requestId}`}
            plain
            onPress={press => {
              void $.ui.copy({ text: command, surface: press.surface })
              $.ui.toast('Command copied')
            }}
          >
            <Text dimColor>[ copy command ]</Text>
          </Button>
        </Box>
      </Box>
    )
  })
}
