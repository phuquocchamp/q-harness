// Seed test: the starting point for q-e2e:explorer and Playwright's agents.
// It runs in the chromium project, so the page is already logged in through storageState.
import { test, expect } from '@playwright/test'

test.describe('seed', () => {
  test('seed', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/')
    // Keep this a cheap sanity check of the logged-in landing page; tighten it for your app,
    // e.g. expect(page.getByRole('navigation')).toBeVisible().
    await expect(page.locator('body')).toBeVisible()
  })
})
