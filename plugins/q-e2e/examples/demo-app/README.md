# q-e2e demo app

This is a two-page static shop with no login and no external services. Use it to watch the q-e2e gate, triage and healer work end to end.

```
src/index.html        product list ("Buy coffee beans" link)
src/checkout.html     order summary + fake "Place order" form
server.mjs            zero-dependency static server on :4321 (Playwright's webServer starts it)
tests/seed.spec.ts    @smoke, the explorer's starting point
tests/checkout.spec.ts  one passing flow with role locators, toHaveURL, toMatchAriaSnapshot, toHaveText
q-e2e.config.json     impact map: src/checkout.html → tests/checkout.spec.ts, src/index.html → both
```

## Setup

```bash
cd plugins/q-e2e/examples/demo-app
npm install
npx playwright install chromium
npx playwright test --reporter=json,line     # 2 passed
```

Then start Claude Code **in this folder** with the plugin installed from the marketplace. With `--plugin-dir`, copy the folder outside the plugin first (`cp -R . /tmp/demo && cd /tmp/demo && git init -q && git add -A && git commit -qm base`), because in testing, Claude Code refused edits under a plugin folder it had loaded from disk.

Triage starts in shadow mode, so in steps 1 and 3 below the drift is labelled but still handled as an app bug. Set the plugin option `triage` to `on` to see the healer run.

## Try the gate

1. **Test drift → healer.** Ask Claude: *"Rename the Place order button to Pay now"*. When it tries to stop, the gate runs `tests/checkout.spec.ts`. The spec fails on the old name (after the 30 s test timeout), and triage labels it `test-drift`. With `triage: on` the stop is allowed and `q-e2e:healer` updates the locator in the background, and the next prompt reports the re-run. In shadow mode Claude is sent back to fix it, and the band shows `(shadow) jev: test-drift …`.
2. **App bug → blocked stop.** Ask: *"Make the confirmation say Order pending"* without mentioning the test. The `toHaveText('Order confirmed')` assertion fails, triage says `app-bug`, and the stop is blocked with the failing line.
3. **Unmapped change → smoke.** Add a new `src/about.html`. Nothing in the map matches, so the gate runs only `@smoke` (the seed test).
4. **Evidence.** Ask *"do the E2E tests pass?"*. Claude should answer from `mcp__q-e2e__e2e_status` (spec counts, commit, age), not from memory.
5. **Explorer.** `/q-e2e explore "open the product list and check the price of coffee beans"` writes a new `tests/<slug>.spec.ts` and runs it until green.

Reset with `git checkout -- src tests`.
