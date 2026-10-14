import { expect, test } from 'claude-code/testing'

import { fileChange, previewChanges, relativeTo } from '../hooks/lib/files'

const PATCH = [{ oldStart: 3, oldLines: 2, newStart: 3, newLines: 3, lines: [' keep', '-old', '+new', '+more'] }]

test('an Edit result becomes hunk header, context, removed and added rows', () => {
  const c = fileChange('Edit', { file_path: '/repo/a.ts', old_string: 'old', new_string: 'new\nmore' }, { filePath: '/repo/a.ts', structuredPatch: PATCH })
  expect(c).toMatchObject({ path: '/repo/a.ts', verb: 'Edit', added: 2, removed: 1, created: false })
  expect(c.diff.map(l => l.kind)).toEqual(['@', ' ', '-', '+', '+'])
  expect(c.diff[0]?.t).toBe('@@ -3,2 +3,3 @@')
  expect(previewChanges(c.diff, 2).map(l => l.t)).toEqual(['old', 'new'])
})

test('a running or failed Edit shows the intent from its input', () => {
  const c = fileChange('Edit', { file_path: '/a', old_string: 'x', new_string: 'y', replace_all: true }, 'String not found')
  expect(c).toMatchObject({ verb: 'Edit ×all', added: 1, removed: 1 })
})

test('a new file is all added lines; an overwrite uses its patch', () => {
  expect(fileChange('Write', { file_path: '/n', content: 'a\nb\n' }, { type: 'create', content: 'a\nb\n', structuredPatch: [] })).toMatchObject({ verb: 'Create', added: 2, removed: 0, created: true })
  expect(fileChange('Write', { file_path: '/n', content: 'z' }, { type: 'update', structuredPatch: PATCH, staged: true })).toMatchObject({ verb: 'Write', added: 2, removed: 1, staged: true })
})

test('notebook edits diff the cell source', () => {
  const c = fileChange('NotebookEdit', { notebook_path: '/nb.ipynb', new_source: 'x = 2' }, { old_source: 'x = 1', new_source: 'x = 2', edit_mode: 'replace' })
  expect(c).toMatchObject({ path: '/nb.ipynb', verb: 'Edit cell', added: 1, removed: 1 })
  expect(fileChange('NotebookEdit', { notebook_path: '/nb.ipynb', edit_mode: 'delete', new_source: '' }, { old_source: 'y', edit_mode: 'delete' })).toMatchObject({ verb: 'Delete cell', added: 0, removed: 1 })
})

test('paths inside the session root are shown relative', () => {
  expect(relativeTo('/repo/src/a.ts', '/repo')).toBe('src/a.ts')
  expect(relativeTo('/other/a.ts', '/repo')).toBe('/other/a.ts')
  expect(relativeTo('/repo2/a.ts', '/repo')).toBe('/repo2/a.ts')
})
