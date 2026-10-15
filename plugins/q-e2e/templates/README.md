# q-e2e templates

What `/q-e2e init` offers to scaffold into your project. The folder mirrors where each file lands (`env.e2e` → `.env.e2e`). Init shows a preview first and never overwrites an existing file. The two `*.snippet*` files and this README are for you to merge by hand.

| Template | Goes to | What it is |
| --- | --- | --- |
| `playwright.config.ts` | `playwright.config.ts` | `setup` project (login, tracing off) + `chromium` project that depends on it and reuses `playwright/.auth/user.json` as `storageState`. `webServer` starts your dev server, `retries: 1`, `trace: 'retain-on-failure'`, reporters `json` + `line`. Edit `webServer.command` and the port. |
| `tests/auth.setup.ts` | `tests/auth.setup.ts` | Logs in with `E2E_USER_EMAIL` / `E2E_USER_PASSWORD`, optional TOTP from `E2E_TOTP_SECRET` via `otpauth` (`npm i -D otpauth`), saves the session. Adjust the labels to your login form. |
| `tests/seed.spec.ts` | `tests/seed.spec.ts` | Logged-in starting page for `q-e2e:explorer` and Playwright's agents. Tagged `@smoke`. |
| `env.e2e` | `.env.e2e` | Only `op://` references. Run with `op run --env-file=.env.e2e -- npx playwright test`, so no secret ever sits in the repo or reaches a model. |
| `q-e2e.config.json` | `q-e2e.config.json` | Impact map: app-source globs → spec globs, `testDir`, `smokeTag` fallback, `ignore` globs. |
| `gitignore.snippet` | append to `.gitignore` | `playwright/.auth/`, `.q-e2e/`, `test-results/`, `playwright-report/`, optionally `.env.e2e`. |
| `claude-settings.snippet.json` | merge into `.claude/settings.json` yourself | `permissions.deny` Read rules for `.env*`, `playwright/.auth/**`, `*.har`, traces. Deny rules cover Claude's file tools, not subprocesses; use the sandbox if you need a hard wall. |
