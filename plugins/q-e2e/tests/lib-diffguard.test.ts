import { expect, test } from 'claude-code/testing'

import { checkHealDiff, checkHealFiles, diffSnapshots, parseUnifiedDiff } from '../hooks/lib/diffguard'

const diff = (path: string, body: string) =>
  `diff --git a/${path} b/${path}\nindex 1..2 100644\n--- a/${path}\n+++ b/${path}\n@@ -1,3 +1,3 @@\n${body}\n`

test('a locator fix is accepted', () => {
  const d = diff('tests/signup.spec.ts', [
    " test('signs up', async ({ page }) => {",
    "-  await page.getByRole('button', { name: 'Sign up' }).click()",
    "+  await page.getByRole('button', { name: 'Create account' }).click()",
    "-  await expect(page.getByRole('heading', { name: 'Sign up' })).toBeVisible()",
    "+  await expect(page.getByRole('heading', { name: 'Create account' })).toBeVisible()",
  ].join('\n'))
  expect(checkHealDiff(d, 'tests')).toEqual({ ok: true, reasons: [] })
  expect(checkHealDiff('', 'tests').ok).toBe(true)
})

test('skips, fixmes, fails and .only are rejected', () => {
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  test.fixme()"), 'tests').reasons).toEqual(['adds test.fixme'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "-test('x', async () => {\n+test.skip('x', async () => {"), 'tests').reasons).toEqual(['adds test.skip'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "+test.describe.skip('group', () => {"), 'tests').reasons).toEqual(['adds test.skip'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  test.fail()"), 'tests').reasons).toEqual(['adds test.fail'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "+test.only('x', async () => {"), 'tests').reasons).toEqual(['adds .only'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "-  // test.skip()\n+  test.skip()"), 'tests').reasons).toEqual(['adds test.skip'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  test.slow()"), 'tests').reasons).toEqual(['adds test.slow'])
  // An existing skip that stays (moved line) is not new.
  expect(checkHealDiff(diff('tests/a.spec.ts', "-  test.skip(isMobile)\n+  test.skip(isMobile, 'no hover')"), 'tests').ok).toBe(true)
})

test('removed or commented-out expect is rejected', () => {
  expect(checkHealDiff(diff('tests/a.spec.ts', "-  await expect(status).toHaveText('Paid')"), 'tests').reasons).toEqual(['removes expect()'])
  const commented = checkHealDiff(diff('tests/a.spec.ts', "-  await expect(status).toHaveText('Paid')\n+  // await expect(status).toHaveText('Paid')"), 'tests')
  expect(commented.reasons).toEqual(['comments out expect()', 'removes expect()'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "-  await expect(a).toBeVisible()\n+  await expect.soft(a).toBeVisible()"), 'tests').reasons).toEqual(['softens expect() to expect.soft()'])
})

test('loosened assertions and long timeouts are rejected', () => {
  const loose = checkHealDiff(diff('tests/a.spec.ts', "-  await expect(status).toHaveText('Paid')\n+  expect(await status.textContent()).toBeTruthy()"), 'tests')
  expect(loose.reasons).toEqual(['loosens assertions (e.g. toHaveText → toBeTruthy)'])
  const slow = checkHealDiff(diff('tests/a.spec.ts', "-  await expect(a).toBeVisible()\n+  await expect(a).toBeVisible({ timeout: 60_000 })"), 'tests')
  expect(slow.reasons).toEqual(['raises a timeout to 60000 ms (max 30000)'])
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  test.setTimeout(120000)"), 'tests').ok).toBe(false)
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  await page.click('a', { actionTimeout: 60000 })"), 'tests').ok).toBe(false)
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  use: { navigationTimeout: 45000 }"), 'tests').ok).toBe(false)
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  page.setDefaultTimeout(60000)"), 'tests').ok).toBe(false)
  expect(checkHealDiff(diff('tests/a.spec.ts', "+  page.setDefaultNavigationTimeout(90000)"), 'tests').ok).toBe(false)
  expect(checkHealDiff(diff('tests/a.spec.ts', "-  await expect(a).toBeVisible()\n+  await expect(a).toBeVisible({ timeout: 10000 })"), 'tests').ok).toBe(true)
})

test('edits outside testDir, renames out of it and deleted specs are rejected', () => {
  expect(checkHealDiff(diff('src/checkout/pay.ts', "+  markPaid(order)"), 'tests').reasons).toEqual(['edits outside tests/: src/checkout/pay.ts'])
  const rename = 'diff --git a/tests/a.spec.ts b/old/a.spec.ts\nsimilarity index 100%\nrename from tests/a.spec.ts\nrename to old/a.spec.ts\n'
  expect(checkHealDiff(rename, 'tests').reasons).toEqual(['edits outside tests/: old/a.spec.ts'])
  const del = "diff --git a/tests/a.spec.ts b/tests/a.spec.ts\ndeleted file mode 100644\n--- a/tests/a.spec.ts\n+++ /dev/null\n@@ -1 +0,0 @@\n-test('a', async () => {})\n"
  expect(checkHealDiff(del, 'tests').reasons).toEqual(['deletes spec tests/a.spec.ts'])
})

test('plain unified diffs with several files parse', () => {
  const d = "--- tests/a.spec.ts\n+++ tests/a.spec.ts\n@@ -1 +1 @@\n-old\n+new\n--- src/b.ts\t2026-10-14\n+++ src/b.ts\n@@ -1 +1 @@\n-x\n+y\n"
  const files = parseUnifiedDiff(d)
  expect(files.map(f => f.newPath)).toEqual(['tests/a.spec.ts', 'src/b.ts'])
  expect(files[0]).toMatchObject({ added: ['new'], removed: ['old'] })
  expect(checkHealDiff(d, './tests/').reasons).toEqual(['edits outside tests/: src/b.ts'])
})

test('toHaveText downgraded to toBeVisible, match-anything regexes and swallowed errors are rejected', () => {
  const swap = diff('tests/a.spec.ts', "-  await expect(page.getByRole('status')).toHaveText('Paid')\n+  await expect(page.getByRole('status')).toBeVisible()")
  expect(checkHealDiff(swap, 'tests').reasons).toEqual(['loosens assertions (e.g. toHaveText → toBeTruthy)'])
  const any = diff('tests/a.spec.ts', "-  await expect(page).toHaveURL('/done')\n+  await expect(page).toHaveURL(/.*/)")
  expect(checkHealDiff(any, 'tests').reasons).toEqual(['matches anything (/.*/) instead of a value'])
  const swallow = diff('tests/a.spec.ts', "-  await page.getByRole('button').click()\n+  await page.getByRole('button').click().catch(() => {})")
  expect(checkHealDiff(swallow, 'tests').reasons).toEqual(['swallows errors with .catch(() => {})'])
  // A real regex, and a toBeVisible next to a kept toHaveText, are fine.
  expect(checkHealDiff(diff('tests/a.spec.ts', "-  await expect(page).toHaveURL('/a')\n+  await expect(page).toHaveURL(/\\/a\\/\\d+/)"), 'tests').ok).toBe(true)
})

test('diffSnapshots feeds checkHealDiff: untracked files, deletions and moves, with no size cap', () => {
  const before = { 'tests/a.spec.ts': "x\nexpect(a).toBe(1)\ny", 'tests/b.spec.ts': 'keep', 'tests/c.spec.ts': 'gone' }
  expect(checkHealDiff(diffSnapshots(before, before), 'tests')).toEqual({ ok: true, reasons: [] })
  // A reorder is not a change.
  expect(checkHealDiff(diffSnapshots(before, { ...before, 'tests/a.spec.ts': "y\nexpect(a).toBe(1)\nx" }), 'tests').ok).toBe(true)
  const weakened = { ...before, 'tests/a.spec.ts': 'x\ny' }
  expect(checkHealDiff(diffSnapshots(before, weakened), 'tests').reasons).toEqual(['removes expect()'])
  const deleted = { 'tests/a.spec.ts': before['tests/a.spec.ts']!, 'tests/b.spec.ts': 'keep' }
  expect(checkHealDiff(diffSnapshots(before, deleted), 'tests').reasons).toEqual(['deletes spec tests/c.spec.ts'])
  // A change far past the old 20 kB diff cap is still seen.
  const big = { 'tests/big.spec.ts': `${'// pad\n'.repeat(5000)}expect(a).toBe(1)` }
  expect(checkHealDiff(diffSnapshots(big, { 'tests/big.spec.ts': `${'// pad\n'.repeat(5000)}// gone` }), 'tests').reasons).toEqual(['removes expect()'])
})

test('checkHealFiles rejects files outside the test dir (absolute, ../) and snapshot baselines', () => {
  expect(checkHealFiles(['tests/a.spec.ts', 'tests/sub/b.spec.ts'], 'tests')).toEqual({ ok: true, reasons: [] })
  expect(checkHealFiles(['/tmp/evil.ts'], 'tests').reasons).toEqual(['edits outside tests/: /tmp/evil.ts'])
  expect(checkHealFiles(['tests/../app/page.tsx', 'src/app.ts'], 'tests').reasons).toEqual(['edits outside tests/: tests/../app/page.tsx, src/app.ts'])
  expect(checkHealFiles(['tests/a.spec.ts-snapshots/x.aria.yml'], 'tests').ok).toBe(false)
})
