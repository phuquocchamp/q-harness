import { expect, test } from 'claude-code/testing'

import { parseStatus, statusLine, toEvents, touchesGit } from '../hooks/lib/git'

const PORCELAIN = [
  '# branch.oid 9f3e21a4b5c6d7e8',
  '# branch.head feat/git-badges',
  '# branch.upstream origin/feat/git-badges',
  '# branch.ab +2 -1',
  '# stash 1',
  '1 M. N... 100644 100644 100644 aaa bbb src/a.ts',
  '1 .M N... 100644 100644 100644 aaa bbb src/b.ts',
  '1 MM N... 100644 100644 100644 aaa bbb src/c.ts',
  'u UU N... 100644 100644 100644 100644 aaa bbb ccc src/d.ts',
  '? notes.md',
  '? tmp.txt',
].join('\n')

test('parseStatus reads branch, tracking, changes and stash', () => {
  expect(parseStatus(PORCELAIN)).toEqual({
    branch: 'feat/git-badges',
    detached: false,
    upstream: 'origin/feat/git-badges',
    ahead: 2,
    behind: 1,
    staged: 2,
    modified: 2,
    untracked: 2,
    conflicts: 1,
    stash: 1,
  })
  const detached = parseStatus('# branch.oid 1234567890\n# branch.head (detached)\n')
  expect(detached).toMatchObject({ detached: true, branch: '1234567' })
  expect(statusLine(detached)).toMatch(/✓ clean/)
})

test('git operations become timeline events', () => {
  const events = toEvents(
    { commit: { sha: 'abcdef123456', kind: 'committed', branch: 'main' }, push: { branch: 'main' }, pr: { number: 7, url: 'https://x/pr/7', action: 'created' } },
    'git commit && git push && gh pr create',
    1,
  )
  expect(events.map(e => e.label)).toEqual(['committed abcdef1 on main', 'pushed main', 'PR #7 created'])
  expect(events[2]).toMatchObject({ kind: 'pr', url: 'https://x/pr/7' })
  expect(touchesGit('cd x && git status')).toBe(true)
  expect(touchesGit('ls digit')).toBe(false)
})
