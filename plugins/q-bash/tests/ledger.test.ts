import { expect, test } from 'claude-code/testing'

import { addToTurn, coverage, fileNotes, mergeRanges, newTurn, readSummary, recordCall, todoChanges, turnParts } from '../hooks/ledger'

const ROOT = '/repo'
const read = (path: string, startLine: number, numLines: number, totalLines: number) => ({
  type: 'text',
  file: { filePath: path, content: '', startLine, numLines, totalLines },
})

test('read ranges merge and give coverage', () => {
  expect(mergeRanges([[50, 80], [1, 20], [21, 30], [75, 90]])).toEqual([[1, 30], [50, 90]])

  let ledger = recordCall([], ROOT, { tool: 'Read', input: {}, result: read('/repo/src/a.ts', 1, 100, 400), isError: false, at: 1 }).ledger
  ledger = recordCall(ledger, ROOT, { tool: 'Read', input: {}, result: read('/repo/src/a.ts', 101, 100, 400), isError: false, at: 2 }).ledger
  expect(ledger).toHaveLength(1)
  expect(ledger[0]).toMatchObject({ path: 'src/a.ts', reads: 2, ranges: [[1, 200]], totalLines: 400 })
  expect(coverage(ledger[0]!)).toBe(0.5)
})

test('a re-read of an unchanged file is counted as such', () => {
  const first = recordCall([], ROOT, { tool: 'Read', input: {}, result: read('/repo/x.md', 1, 10, 10), isError: false, at: 1 })
  const again = recordCall(first.ledger, ROOT, { tool: 'Read', input: {}, result: { type: 'file_unchanged', file: { filePath: '/repo/x.md' } }, isError: false, at: 2 })
  expect(again.ledger[0]).toMatchObject({ reads: 2, rereads: 1 })
  expect(again.delta).toMatchObject({ reads: 1, rereads: 1 })
  expect(readSummary({ type: 'file_unchanged', file: { filePath: '/repo/x.md' } }, again.ledger[0])).toMatch(/unchanged/)
})

test('edits, writes and bash diffs count lines and mark new and overwritten files', () => {
  const patch = [{ oldStart: 1, oldLines: 2, newStart: 1, newLines: 3, lines: [' a', '-b', '+c', '+d'] }]
  let r = recordCall([], ROOT, { tool: 'Edit', input: {}, result: { filePath: '/repo/a.ts', structuredPatch: patch }, isError: false, at: 1 })
  expect(r.delta).toMatchObject({ edits: 1, added: 2, removed: 1 })
  r = recordCall(r.ledger, ROOT, { tool: 'Write', input: {}, result: { type: 'create', filePath: '/repo/new.ts', structuredPatch: [] }, isError: false, at: 2 })
  r = recordCall(r.ledger, ROOT, { tool: 'Write', input: {}, result: { type: 'update', filePath: '/repo/a.ts', structuredPatch: patch }, isError: false, at: 3 })
  r = recordCall(r.ledger, ROOT, {
    tool: 'Bash',
    input: { command: "sed -i '' s/x/y/ README.md" },
    result: { stdout: '', stderr: '', interrupted: false, bashEditDiff: { files: [{ filePath: '/repo/README.md', hunks: [{ lines: ['-x', '+y'] }] }], moreFiles: 0 } },
    isError: false,
    agentId: 'agent-1',
    at: 4,
  })
  const by = Object.fromEntries(r.ledger.map(f => [f.path, f]))
  expect(by['a.ts']).toMatchObject({ edits: 1, writes: 1, added: 4, removed: 2, overwrites: 1 })
  expect(by['new.ts']).toMatchObject({ writes: 1, created: true })
  expect(by['README.md']).toMatchObject({ edits: 1, viaBash: 1, agents: ['agent-1'] })
  expect(fileNotes(by['a.ts']!).map(n => n.text)).toContain('overwritten')
  expect(fileNotes(by['README.md']!).map(n => n.text)).toContain('via bash')
})

test('failed calls change no file, and the turn band lists only what happened', () => {
  const r = recordCall([], ROOT, { tool: 'Edit', input: { file_path: '/repo/a.ts' }, result: undefined, isError: true, at: 1 })
  expect(r.ledger).toEqual([])

  let t = newTurn('t1', 0)
  t = addToTurn(t, { reads: 3, partial: 1, files: ['a', 'b', 'c'] })
  t = addToTurn(t, { edits: 1, added: 5, removed: 2, files: ['a'] })
  t = addToTurn(t, { bash: 2, bashFailed: 1 })
  expect(t.files).toEqual(['a', 'b', 'c'])
  const text = turnParts(t, 3, 1).map(p => p.text)
  expect(text).toEqual(['read 3 files (1 partial)', 'changed 1 file', '+5', '−2', 'bash 2 (1 failed)'])
})

test('read summaries say which lines were read', () => {
  expect(readSummary(read('/repo/a', 1, 10, 10), undefined)).toBe('all 10 lines')
  expect(readSummary(read('/repo/a', 41, 20, 200), undefined)).toBe('lines 41–60 of 200 (10%)')
  expect(readSummary({ type: 'image', file: {} }, undefined)).toBeUndefined()
})

test('todo changes are found by item text', () => {
  const before = [
    { content: 'A', status: 'completed', activeForm: 'Doing A' },
    { content: 'B', status: 'in_progress', activeForm: 'Doing B' },
  ] as const
  const after = [
    { content: 'A', status: 'completed', activeForm: 'Doing A' },
    { content: 'B', status: 'completed', activeForm: 'Doing B' },
    { content: 'C', status: 'pending', activeForm: 'Doing C' },
  ] as const
  expect(todoChanges([...before], [...after]).map(t => t.change)).toEqual([undefined, 'done', 'added'])
})
