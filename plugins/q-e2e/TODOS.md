# q-e2e TODOS

## Follow-ups (0.1.x)

- [ ] **Heal-verify test.** The test kit answers a plugin's own `$.agent.spawn` with no `agentId`, so `verifyHeal` (snapshot diff guard, re-run, the note to Claude) never runs under `claude plugin test`. Either inject a fake id through an `agent.spawn` hook in `tests/host.ts`, or move `verifyHeal` behind a function that is easier to test, and cover the passed, rejected and still-red outcomes.
- [ ] **Impact map improvements.** Add Next.js `app/(group)/` route groups and dynamic segments, Remix and SvelteKit route files, imports (a changed component selects the specs whose pages import it), and a `/q-e2e why` that prints the selection reasons.
- [ ] **Shadow agreement against outcomes.** The `decisions` log compares the label with what the gate did. Record what actually happened (whether Claude fixed the test or the app before the spec went green), so `/q-e2e decisions` can show real accuracy before you switch `triage` to `on`.
- [ ] **Fallback re-runs.** A follow-up turn that changed nothing still re-runs the gate. Skip the run when no new edit was recorded since the last red run, and reuse that run's block text.
- [ ] **MCP server cwd.** `bin/mcp-server.mjs` walks up to the nearest `playwright.config.*`. Check where `run-test-mcp-server` starts on each host (terminal, desktop, SDK), and handle a config below the session folder (monorepo). Document the clash with a user-level `playwright-test` server, which suppresses the plugin's copy.

## P2

- [ ] **Jev driver (experiment).** Port jev-ultrafast to TS for smoke checks with no spec ("can a guest still reach the payment step?"): `snapshot.js` in `page.evaluate`, the operation and target heads, Haiku through `$.model.complete` as the text helper, and outcomes checked in code.
- [ ] **Run pane and failure cards.** `/q-e2e` pane that streams the run and shows one card per red spec (error, aria-snapshot diff, Jev label and probability, a "fix it" button that fills the prompt).
- [ ] **Destructive-click guard** for the explorer (regex first, then a Jev choice), and triage thresholds learned from the shadow log.
