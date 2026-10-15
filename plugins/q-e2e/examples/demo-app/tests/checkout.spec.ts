import { test, expect } from '@playwright/test'

test.describe('checkout', () => {
  test('buy coffee beans', async ({ page }) => {
    // Open the product list and start checkout
    await page.goto('/')
    await page.getByRole('link', { name: 'Buy coffee beans' }).click()
    await expect(page).toHaveURL(/\/checkout\.html\?item=coffee$/)

    // Review the order summary
    await expect(page.getByRole('region', { name: 'Order summary' })).toMatchAriaSnapshot(`
      - region "Order summary":
        - heading "Order summary" [level=2]
        - paragraph: Coffee beans × 1
        - paragraph: "Total: €12.00"
    `)

    // Pay with a fake email (the demo never sends anything)
    await page.getByLabel('Email').fill('buyer@example.test')
    await page.getByRole('button', { name: 'Place order' }).click()
    await expect(page.getByRole('status')).toHaveText('Order confirmed')
  })
})
