// Logs in once and saves the session for every other project (storageState).
// Secrets come from the environment only, e.g. `op run --env-file=.env.e2e -- npx playwright test`.
// Tracing is off for the setup project in playwright.config.ts, so credentials never land in a trace.
import { test as setup, expect } from '@playwright/test'
import * as OTPAuth from 'otpauth'

const authFile = 'playwright/.auth/user.json'

function requireEnv(name: string): string {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is not set. Run through \`op run --env-file=.env.e2e -- ...\`.`)
  return value
}

setup('authenticate', async ({ page }) => {
  // Adjust the route, labels and the post-login check to your app.
  await page.goto('/login')
  await page.getByLabel('Email').fill(requireEnv('E2E_USER_EMAIL'))
  await page.getByLabel('Password').fill(requireEnv('E2E_USER_PASSWORD'))
  await page.getByRole('button', { name: /sign in|log in/i }).click()

  // Optional MFA. Prefer a test-only MFA bypass; holding the TOTP secret is holding the second factor.
  const totpSecret = process.env.E2E_TOTP_SECRET
  if (totpSecret) {
    const totp = new OTPAuth.TOTP({ secret: OTPAuth.Secret.fromBase32(totpSecret) })
    await page.getByLabel(/code|one-time/i).fill(totp.generate())
    await page.getByRole('button', { name: /verify|continue/i }).click()
  }

  // Wait until the session cookies are really set (login flows often redirect several times).
  await expect(page).not.toHaveURL(/\/login/)
  await page.context().storageState({ path: authFile })
})
