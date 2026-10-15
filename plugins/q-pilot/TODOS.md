# q-pilot TODOS

Done in 0.2: prompt mode (`/q-pilot test`, `pilot_test`, `/q-pilot save`, soft checks, the `press` step, occlusion filtering).

Done in 0.4: Playwright from the project, `playwrightPath` or a global install; attach to a running Chrome (`cdpUrl`); `storageState`; Playwright trace and page errors for red runs; strict checks; heal threshold (p ≥ 0.5); the repo server never gets the Jev key; a signalled run never reports `ok`; model evals in `evals/`.

Done in 0.6 (from the autopsy of 22 real-site runs, 1 real pass): help requests to Claude (`pilot_help`: loop, stuck, BLOCKED, low confidence, bot wall, DONE confirmation, budget); cycle detection; the per-field fill cap fixed; DONE/BLOCKED re-decided on a changed page; key-by-key typing with a wait for suggestion lists made of plain divs; a wait after clicks for pickers; "Open" clicks for every editable field and jev-ultrafast's CLICK wording restored; typed text in `recent_actions`; the fixture asked for the chosen field; PRESS_ENTER only without suggestions; ESCAPE; consent banners closed before the first step; bot-wall detection (DataDome, Cloudflare, AWS WAF, hCaptcha, reCAPTCHA, Arkose); Jev retries with backoff and a 15 s timeout.

Done in 0.6.1: the inspector stays open after the run for review (click a step, ← →), offers the Playwright trace and decisions, and has "Ask Claude" with a model picker (Haiku 5.5 default); its title and icon follow the run.

Done in 0.9.0: layered settings (cli > env > local > project > user > default) with `/q-pilot config set|unset|explain --scope`; `node`, `cdpUrl` and `trust` only from user, env and cli; vision settings reach `pilot_test` as well as `pilot_run`; the last run, last run per flow and last test or task are kept per project; a `q-pilot.config.json` that does not parse is reported.

Done in 0.8.0: settings moved to `/q-pilot config` (one plugin option left, the Jev key); a helper model (Haiku by default) answers help requests before the session; the inspector opens in the default browser.
Done in 0.7.0: Jev vision (preview): gated or every-step screenshots, the vision model, and Box rescue (Jev 1.14), all switchable in the inspector during a run; off for runs with secrets.

What is still left out.

- **Settings sources in the inspector.** The inspector shows the vision settings but not which scope they came from, and nothing in the mod fills the `cli` scope yet (the resolver supports it). Env covers only `Q_PILOT_CDP_URL`. The stop gate's replay and `record` pass no vision flags (replay uses no model; a healed step runs with the runner's own default, vision off).
- **Haiku fallback.** Without Jev, prompt mode ends as `blocked`, a missed step in a saved flow ends as `blocked`, and an untraced flow as `untraced`. A guarded Haiku pick for those cases was in the first design report and is not built.
- **YAML flows.** Flows are JSON. A YAML reader (and a converter) could come later.
- **Scope disambiguation beyond landmarks.** Look-alike elements are told apart only by the name of the nearest form, dialog, landmark or list. Anything finer (row text, position) is a miss today.
- **Iframes and shadow DOM.** The snapshot does not see shadow roots, iframes, canvas or file uploads. Consent buttons in frames are closed before the first step, and CAPTCHA frames and shadow-root CAPTCHAs are detected as bot walls, but Jev cannot act inside a frame.
- **Date pickers without Claude.** Jev still often searches with the default date (Traveloka, live 2026-10-15). A help request catches it only when the task has checks or Claude confirms DONE; a check on the URL's date is the reliable guard.
- **Bot walls.** Traveloka (AWS WAF) and Vietnam Airlines' booking engine (Cloudflare) challenge an automated Chromium. q-pilot stops for a person; a persistent real profile (beyond `cdpUrl`) is not built.
- **Keys in saved flows.** Jev may press Enter and Escape, Claude also Tab and arrows; a recorded `press` step replays any of them, but the heal path offers Enter only.
- **Prompt-mode runs in the stop gate.** The gate replays saved flows only. Running a prompt-mode spec at turn end would cost one Jev call per step each time.
- **Exporting `scope`.** Exported specs do not narrow a locator by scope.
- **CI export by default.** `/q-pilot export` writes a Playwright spec on request. Exporting every flow on save, and a CI recipe for running them, is not set up.
- **A viewer for old runs.** The inspector reviews the run it served; a run that has ended and closed is JSON, screenshots and a trace in `.q-pilot/runs/`, with no page to reopen it.
- **Vision thresholds.** The gate (p < 0.6, top-two gap < 0.25) and Box limits (0.5 / 0.6) are first guesses from a handful of live decisions; tune them on more runs.
- **Advisor answering help requests.** The inspector's model (e.g. Haiku) answers questions; it does not yet answer Jev's help requests in place of the session.
- **Jev latency in a loop.** Live runs show about 0.28 s a call; a p95 over many calls (for the 15 s request timeout) has not been measured.
- **Live numbers.** The README quotes PoC numbers for prompt mode. Replace them with numbers from the runner's live runs.
- **Electron target.** `openSession()` covers launch and CDP attach. An Electron target (`_electron.launch`, one Page per window, stubbed native dialogs and menus) is not built.
- **aria snapshot as a second observer.** Playwright's `ariaSnapshot()` + `getByRef()` could cover shadow DOM and iframes next to `snapshot.js`. Not prototyped.
- **tmux end-to-end tests.** The band and the stop gate (with `cc-plugin-sec-default` on and off) are only covered by mod tests with a fake host.
- **Clearer CDP refusal.** An endpoint that refuses new tabs (an Electron app on the port) ends as `error: ... Target.createTarget: Not supported`; it could say what it is.
