---
name: e2e
description: How this project's Playwright end-to-end tests work with the q-e2e plugin. Use when writing, fixing, running or reporting on E2E / Playwright specs, touching playwright.config.ts, auth.setup.ts, tests/seed.spec.ts or q-e2e.config.json, or before saying that tests pass, a UI change works, or a feature is done.
---

# E2E with q-e2e

q-e2e makes "tests pass" a fact rather than a claim. When you try to finish a turn that changed UI-relevant files, its gate runs the affected Playwright specs. A red spec sends you back to work: either the stop is blocked, or a follow-up message from the q-e2e plugin arrives with the failing specs. That message is real test output, so fix what it lists. By default triage runs in **shadow** mode, where every red spec counts as an app bug. With triage `on`, a **test-drift** failure goes to the `q-e2e:healer` subagent in the background instead. Every real run is stored as evidence.

## Rule 1: evidence before claims

Never say tests pass, the UI works, or a fix is verified unless a q-e2e run shows it. Call the `mcp__q-e2e__e2e_status` tool and quote the result: pass/fail per spec, commit, age. If the last run is older than your last edit, or does not cover the specs you touched, say so and run them. A green unit test run is not E2E evidence.

## Project layout

```
playwright.config.ts      setup project + chromium project (storageState), webServer, retries 1,
                          trace 'retain-on-failure' (off for setup), reporter json + line
tests/auth.setup.ts       logs in from process.env.E2E_USER_* (+ optional TOTP), saves playwright/.auth/user.json
tests/seed.spec.ts        logged-in starting page; the explorer and Playwright's agents start here
tests/<flow>.spec.ts      one user flow per file
q-e2e.config.json         impact map: app source globs → spec globs
.env.e2e                  op:// references only, never literal secrets
```

`/q-e2e init` scaffolds the missing pieces from the plugin's `templates/` (preview first, never overwrites).

## Auth and secrets

- Login happens once in the `setup` project. Every other project sets `storageState: 'playwright/.auth/user.json'` and `dependencies: ['setup']`, so specs start logged in. Do not log in inside specs.
- Credentials come only from `process.env.E2E_USER_EMAIL`, `E2E_USER_PASSWORD` and optional `E2E_TOTP_SECRET`, injected by `op run --env-file=.env.e2e -- ...`. Never write a credential, token or real personal data into a spec, fixture, config or commit.
- Never read `.env*`, `playwright/.auth/**`, `*.har` or trace zips. They hold live cookies and secrets. Don't turn on tracing for the setup project.

## Writing specs

Locators, in this order of preference:

1. `page.getByRole('button', { name: 'Pay now' })`, the default for anything interactive or structural
2. `getByLabel('Email')` for form fields, `getByPlaceholder` only if there is no label
3. `getByText('Order confirmed')` for non-interactive text
4. `getByTestId('cart-total')` when the text is dynamic and there is no accessible name

Avoid CSS/XPath chains, `nth()` (unless order is what you're testing), `waitForTimeout` and `networkidle`.

Assertions are web-first and check outcomes, not just that the clicks happened:

```ts
await expect(page).toHaveURL(/\/checkout\/done$/)
await expect(page.getByRole('heading', { name: 'Order confirmed' })).toBeVisible()
await expect(page.getByTestId('cart-total')).toHaveText('€42.00')
await expect(page.getByRole('region', { name: 'Summary' })).toMatchAriaSnapshot(`
  - heading "Summary" [level=2]
  - text: /Total €\\d+\\.\\d{2}/
`)
```

More rules:

- Use `page.goto('/relative')`, never a hard-coded host. `baseURL` comes from the config.
- Write one `test.describe` per flow and one behaviour per `test`, with a `// step` comment before each step.
- Tag cheap, critical-path tests `@smoke`: `test('checkout', { tag: '@smoke' }, async ({ page }) => { ... })`. The gate runs `@smoke` when app code changed but nothing in the impact map matched.
- Never commit `test.only`. Never "fix" a red test with `test.skip`, `test.fixme`, deleted `expect`s or long timeouts. The healer diff guard rejects these, and so should you.

## Impact map (`q-e2e.config.json`)

```json
{
  "testDir": "tests",
  "smokeTag": "@smoke",
  "map": {
    "src/checkout/**": ["tests/checkout*.spec.ts"],
    "src/components/**": ["tests/**/*.spec.ts"]
  },
  "ignore": ["**/*.md", "docs/**"]
}
```

- `map`: changed-file glob → spec globs (pass 1). Then route inference: a change under `app/<route>/`, `pages/<route>` or `src/routes/<route>` selects specs whose source has `goto('/<route>')` (pass 2). Then a changed spec selects itself (pass 3).
- Nothing matched but UI code changed → run `smokeTag`. Files matching `ignore` never trigger the gate.
- When you add a feature folder, add its mapping in the same change.

## Running

```bash
npx playwright test --reporter=json,line                       # whole suite
npx playwright test tests/checkout.spec.ts --reporter=json,line
npx playwright test --grep @smoke --reporter=json,line
op run --env-file=.env.e2e -- npx playwright test               # when the app needs login
```

`PLAYWRIGHT_JSON_OUTPUT_NAME=<file>` writes the JSON report to a file instead of stdout. Use `--project=chromium` to skip other browsers locally. Your own Bash runs are useful while iterating, but they are not recorded as evidence. Rely on the gate's runs or `/q-e2e` and check `mcp__q-e2e__e2e_status`.

## Failures

The gate triages each red spec into one of four labels. The "What happens" column applies with triage `on`. In shadow mode (the default) the label is only logged, and every red spec is handled like an `app-bug`.

| Label | Meaning | What happens |
| --- | --- | --- |
| `app-bug` | the app does the wrong thing | stop is blocked: fix the **app**, not the test |
| `test-drift` | intended UI change, stale locator/text | `q-e2e:healer` patches locators in the background; result arrives on the next prompt |
| `flaky` | passes on retry | recorded, not blocking; fix the race if it repeats |
| `env-auth` | server down, login expired, `ERR_CONNECTION_REFUSED` | check `webServer`, `.env.e2e`, delete stale `playwright/.auth/` |

Read `test-results/**/error-context.md` first. It holds the aria snapshot at the moment of failure. If you changed a label on purpose, update the spec in the same turn rather than waiting for the healer.

## Subagents

- `q-e2e:healer` (Haiku): fixes one drifted spec. It edits only locators and intentionally changed text in `tests/`, and answers `app-bug` instead of editing when the app is broken.
- `q-e2e:explorer` (Haiku): turns a described flow into `tests/<flow-slug>.spec.ts`, starting from `tests/seed.spec.ts`, then runs it until green. It stays on the app origin and never handles credentials or destructive actions.

Both drive the browser through the plugin's `playwright-test` MCP server (`npx playwright run-test-mcp-server`). It needs `@playwright/test` ≥ 1.56 installed in the project, and neither subagent has Bash.
