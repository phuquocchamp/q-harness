import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { GitEvent, GitStatus } from '../types'
import { GLYPH, STATUS_ARGV, STATUS_ARGV_OLD, parseStatus, statusLine, toEvents, touchesGit, type GitOperation } from './lib'

const status = atom({ plugin: 'q-git', key: 'status' } as const, null as GitStatus | null)
const timeline = atom({ plugin: 'q-git', key: 'timeline' } as const, [] as GitEvent[])
const band = atom({ plugin: 'q-git', key: 'band' } as const, true)

const TIMELINE_PANE = 'q-git-timeline'
const BAND_KEY = 'band'
const TIMELINE_LIMIT = 200

const USAGE = [
  'Usage: /q-git <subcommand>',
  '  status        print the repository status',
  '  timeline      open the pane of this session’s commits, pushes and PRs',
  '  band on|off   show or hide the status band above the prompt',
  '  refresh       read the status again',
].join('\n')

/** Reads `git status` into $.state; null outside a repository. */
const refresh = async ($: EngineInterface) => {
  let r = await $.process.run(STATUS_ARGV, { timeoutMs: 5_000 })
  if (r.exitCode !== 0 && /show-stash|unknown option/.test(r.stderr)) r = await $.process.run(STATUS_ARGV_OLD, { timeoutMs: 5_000 })
  const next = r.exitCode === 0 ? parseStatus(r.stdout) : null
  await update($, status, () => next)
  return next
}

const copyText = async ($: EngineInterface, text: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface'], what: string) => {
  const r = await $.ui.copy({ text, surface })
  $.ui.toast(r.isCopied ? `${what} copied` : `Could not copy: ${r.reason ?? 'no clipboard'}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const shown = await $.store.get(BAND_KEY)
    await update($, band, () => shown !== false)
    await $.command.register({
      name: 'q-git',
      description: 'Repository status band and session git timeline',
      argumentHint: 'status | timeline | band on|off | refresh',
    })
    await refresh($).catch(() => null)
    return next(e)
  })

  on('command.run', { command: 'q-git' }, async ($, e) => {
    const [sub = '', arg] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub) {
      case 'status':
      case 'refresh': {
        const s = await refresh($)
        return { text: s ? statusLine(s) : 'Not inside a git repository.' }
      }
      case 'timeline':
        await $.ui.open({ id: TIMELINE_PANE, title: 'Git timeline' })
        return { text: 'Git timeline pane opened.' }
      case 'band': {
        if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /q-git band on|off', exitCode: 2 }
        await update($, band, () => arg === 'on')
        await $.store.set(BAND_KEY, arg === 'on')
        return { text: `Status band is ${arg}.` }
      }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `${sub ? `Unknown subcommand "${sub}".\n` : ''}${USAGE}`, exitCode: 2 }
    }
  })

  // Record git activity the engine detected, and re-read the status after commands that may change it.
  on('tool.call', { tool: 'Bash' }, async ($, e, next) => {
    const ran = await next(e)
    const op = (ran.result as { gitOperation?: GitOperation } | undefined)?.gitOperation
    if (op) {
      const events = toEvents(op, e.command, await $.clock.now())
      await update($, timeline, list => [...list, ...events].slice(-TIMELINE_LIMIT))
    }
    if (op || touchesGit(e.command)) await refresh($)
    return ran
  }).catch(($, e, next) => next(e)) // never block a command because the status read failed

  // Files may change outside git commands (edits, generators): refresh once per turn.
  on('turn.complete', async ($, e, next) => {
    await refresh($).catch(() => null)
    return next(e)
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const s = await read($, status)
    if (e.props.hasSurvey || s === null || !(await read($, band))) return next(e)

    const { Box, Text, Button } = $.ui.resolve(e)
    const count = (await read($, timeline)).length
    return (
      <Box flexDirection="row" columnGap={2}>
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
        <Button key="q-git-timeline" plain onPress={() => $.ui.open({ id: TIMELINE_PANE, title: 'Git timeline' })}>
          <Text dimColor>[ timeline{count > 0 ? ` ${count}` : ''} ]</Text>
        </Button>
        <Button key="q-git-hide" plain onPress={() => update($, band, () => false)}>
          <Text dimColor>[ hide ]</Text>
        </Button>
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
