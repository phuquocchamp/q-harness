import { expect, test } from 'claude-code/testing'

import { hasFence, splitFences } from '../hooks/lib/markdown'

test('splitFences cuts prose and fenced code apart', () => {
  const text = ['Intro **bold**', '', '```TS title', 'const a = 1', '```', 'After', '~~~', 'plain', '~~~'].join('\n')
  expect(splitFences(text)).toEqual([
    { kind: 'md', text: 'Intro **bold**\n' },
    { kind: 'code', lang: 'ts', code: 'const a = 1', closed: true },
    { kind: 'md', text: 'After' },
    { kind: 'code', lang: '', code: 'plain', closed: true },
  ])
})

test('a longer fence holds a shorter one, and an unclosed fence is open', () => {
  const nested = ['````md', '```js', 'x()', '```', '````'].join('\n')
  expect(splitFences(nested)).toEqual([{ kind: 'code', lang: 'md', code: '```js\nx()\n```', closed: true }])
  expect(splitFences('```py\nprint(1)')).toEqual([{ kind: 'code', lang: 'py', code: 'print(1)', closed: false }])
})

test('inline backticks are not fences', () => {
  expect(hasFence('use `a` and ``b``')).toBe(false)
  expect(hasFence('text\n```\ncode\n```')).toBe(true)
})
