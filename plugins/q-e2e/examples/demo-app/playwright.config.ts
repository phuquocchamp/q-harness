import { defineConfig, devices } from '@playwright/test'

const PORT = 4321

// The demo has no login, so there is no setup project; see ../../templates for the auth variant.
export default defineConfig({
  testDir: './tests',
  retries: 1,
  reporter: [['json'], ['line']],
  use: { baseURL: `http://localhost:${PORT}`, trace: 'retain-on-failure' },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'node server.mjs',
    url: `http://localhost:${PORT}`,
    reuseExistingServer: !process.env.CI,
  },
})
