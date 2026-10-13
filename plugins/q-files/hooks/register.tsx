import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { FileEntry, FilesSettings, TurnStats } from '../types'
import { addToTurn, changeLabel, groupFiles, hasActivity, newTurn, readNote, recordCall, turnParts } from './ledger'

const ledger = atom({ plugin: 'q-files', key: 'ledger' } as const, [] as FileEntry[])
const turn = atom({ plugin: 'q-files', key: 'turn' } as const, null as TurnStats | null)
const lastTurn = atom({ plugin: 'q-files', key: 'lastTurn' } as const, null as TurnStats | null)
const settings = atom({ plugin: 'q-files', key: 'settings' } as const, { band: true } as FilesSettings)

const PANE = 'q-files'
const SETTINGS_KEY = 'settings'
const TRACKED = new Set(['Read', 'Write', 'Edit', 'NotebookEdit', 'Bash'])

const USAGE = [
  'Usage: /q-files [subcommand]',
  '  (none)          open the list of files this session read and changed',
  '  band on | off   show or hide the turn line above the prompt',
  '  clear           forget the files recorded so far',
].join('\n')

// Only the band switch is kept between sessions; the files list lives in session state.
const saveSettings = async ($: EngineInterface, patch: Partial<FilesSettings>) => {
  const next = { ...(await read($, settings)), ...patch }
  await update($, settings, () => next)
  await $.store.set(SETTINGS_KEY, next)
}

const copyPath = async ($: EngineInterface, path: string, surface: Parameters<EngineInterface['ui']['copy']>[0]['surface']) => {
  const r = await $.ui.copy({ text: path, surface })
  $.ui.toast(r.isCopied ? 'Path copied' : `Could not copy: ${r.reason ?? 'no clipboard'}`)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const saved = ((await $.store.get(SETTINGS_KEY)) ?? {}) as Partial<FilesSettings>
    await update($, settings, s => ({ ...s, ...saved }))
    await $.command.register({ name: 'q-files', description: 'Files this session read and changed', argumentHint: 'band on|off | clear | help' })
    return next(e)
  })

  on('command.run', { command: 'q-files' }, async ($, e) => {
    const [sub = '', arg = ''] = e.args.trim().split(/\s+/).filter(Boolean)
    switch (sub) {
      case '':
        await $.ui.open({ id: PANE, title: 'Files' })
        return { text: 'Files pane opened.' }
      case 'band':
        if (arg !== 'on' && arg !== 'off') return { text: 'Usage: /q-files band on | off', exitCode: 2 }
        await saveSettings($, { band: arg === 'on' })
        return { text: `Turn line is ${arg}.` }
      case 'clear':
        await update($, ledger, () => [])
        return { text: 'Files list cleared.' }
      case 'help':
        return { text: USAGE }
      default:
        return { text: `Unknown subcommand "${sub}".\n${USAGE}`, exitCode: 2 }
    }
  })

  // ---- recorder ------------------------------------------------------------------------------

  on('turn.start', async ($, e, next) => {
    const at = await $.clock.now()
    // Keep the previous turn on show until this one does something: a follow-up turn
    // with no tool calls (the reply after a background agent) would blank the line.
    const prev = await read($, turn)
    if (prev && hasActivity(prev)) await update($, lastTurn, () => prev)
    await update($, turn, () => newTurn(e.turnId, at))
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
      const before = await read($, ledger)
      const { ledger: after, delta } = recordCall(before, await $.session.root(), {
        tool: String(e.tool),
        input: e as unknown as Record<string, unknown>,
        result: ran.result,
        isError: ran.isError === true || ran.deny !== undefined,
        agentId: e.agentId,
        at: await $.clock.now(),
      })
      if (after !== before) await update($, ledger, () => after)
      if (Object.keys(delta).length > 0) await update($, turn, t => (t ? addToTurn(t, delta) : t))
    } catch {
      // The list is a view; a failure here must never change the call.
    }
    return ran
  }).catch(($, e, next) => next(e))

  // ---- turn line above the prompt: drawn under whatever other plugins drew there --------------

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const below = await next(e)
    if (e.props.hasSurvey || !(await read($, settings)).band) return below
    const current = await read($, turn)
    const t = current && hasActivity(current) ? current : await read($, lastTurn)
    if (!t) return below

    const inTurn = new Set(t.files)
    const touched = (await read($, ledger)).filter(f => inTurn.has(f.path))
    const parts = turnParts(
      t,
      touched.filter(f => f.reads > 0).length,
      touched.filter(f => f.edits + f.writes > 0).length,
    )
    if (parts.length === 0) return below

    const { Box, Text, Button } = $.ui.resolve(e)
    return (
      <Box flexDirection="column">
        {below}
        <Box flexDirection="row" flexWrap="wrap" columnGap={1}>
          {parts.map((p, i) => (
            <Text key={`p${i}`} color={p.tone} dimColor={p.tone === undefined}>
              {i > 0 && !p.text.startsWith('+') && !p.text.startsWith('−') ? '· ' : ''}
              {p.text}
            </Text>
          ))}
          <Button key="q-files-open" hotkey="f" label="files" onPress={() => $.ui.open({ id: PANE, title: 'Files' })} />
        </Box>
      </Box>
    )
  })

  // ---- files pane --------------------------------------------------------------------------------

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const all = await read($, ledger)
    const { changed, readOnly } = groupFiles(all)
    const width = Math.max(20, e.props.bodyColumns - 24)
    const clip = (s: string) => (s.length > width ? `…${s.slice(s.length - width + 1)}` : s)

    const row = (f: FileEntry, label: string, tone: string | undefined, notes: string[]) => (
      <Button key={`f-${f.path}`} plain onPress={press => copyPath($, f.path, press.surface)}>
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
        <Text dimColor>Press a row to copy its path · /q-files clear empties the list</Text>
      </Box>
    )
  })
}
