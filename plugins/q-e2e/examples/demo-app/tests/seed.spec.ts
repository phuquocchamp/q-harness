import { test, expect } from '@playwright/test'

test.describe('seed', () => {
  test('seed', { tag: '@smoke' }, async ({ page }) => {
    await page.goto('/')
    await expect(page.getByRole('heading', { name: 'Products' })).toBeVisible()
  })
})
