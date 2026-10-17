import { expect, test } from 'claude-code/testing'

import { bandLink, parseDashMark } from '../hooks/lib/dash'

const mark = (file: string) => `[q-pilot] dash ${JSON.stringify({ url: 'http://127.0.0.1:8767/', file })}`

test('the ready mark accepts POSIX and Windows absolute paths, and only a loopback URL', () => {
  for (const file of ['/repo/.q-pilot/dashboard/server.json', 'C:\\repo\\.q-pilot\\dashboard\\server.json', 'C:/repo/server.json', '\\\\host\\share\\server.json']) expect(parseDashMark(mark(file))?.file).toBe(file)
  expect(parseDashMark(mark('server.json'))).toBeUndefined()
  expect(parseDashMark(`[q-pilot] dash ${JSON.stringify({ url: 'http://evil.test/', file: '/x' })}`)).toBeUndefined()
})

test('the band link needs a Dashboard and a red flow', () => {
  expect(bandLink('http://127.0.0.1:8767/', 'r1', 'checkout')).toBe('http://127.0.0.1:8767/#s=r1:checkout')
  expect(bandLink(undefined, 'r1', 'checkout')).toBeUndefined()
  expect(bandLink('http://127.0.0.1:8767/', 'r1', undefined)).toBeUndefined()
})
