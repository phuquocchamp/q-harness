# q-pilot design contract (0.1)

This file is the shared contract between the mod (`hooks/`), the runner (`runner/`) and the export module. Code must match it. When something here must change, change this file first.

## What q-pilot is

A Claude Code plugin that checks, at the end of a turn that changed UI files, that the user flows of a web app still work. A **flow** is a goal in plain words, fixtures and a `verify` block. Jev (TypeSafe) records the path once; later runs **replay** it with no model; when one step no longer matches, Jev re-picks **that step only** (heal). Pass or fail always comes from the `verify` block evaluated by code, never from Jev's DONE.

Design report: https://claude.ai/artifact/4xGkHn6HugVUsyJcEQtyYS (it showed YAML flows and a Haiku fallback; 0.1 departs: flows are JSON, and there is no Haiku fallback, see Limits).

## Layout

```
plugins/q-pilot/
  .claude-plugin/plugin.json   mod agent
  hooks/hooks.json             mod agent
  hooks/register.tsx           mod agent (every hook and every helper that takes $)
  hooks/lib/*.ts               mod agent (pure helpers)
  types/index.d.ts, tsconfig.json   mod agent
  tests/*.test.ts              mod agent (claude plugin test; fake host)
  runner/pilot.mjs             runner agent: CLI entry
  runner/*.mjs                 runner agent (snapshot, executor, replay, record, jev, verify, redact, flow, trace)
  runner/export.mjs            export agent: exportSpec()
  runner/*.test.mjs            node --test (runner and export agents, own files only)
  examples/demo-app/           runner agent (static demo shop + flows + q-pilot.config.json)
  skills/flows/SKILL.md        docs agent (not skills/q-pilot: that name collides with the /q-pilot command)
  README.md, TODOS.md, LICENSE docs agent
```

The runner is plain Node ESM (Node 18+), no dependencies except Playwright, which it resolves from the **project** (`createRequire(<root>/package.json)`, packages `playwright` then `@playwright/test`). It never imports from `hooks/`.

## Project files (in the user's repo)

`q-pilot.config.json` at the project root:

```json
{
  "baseURL": "http://localhost:4321",
  "flowsDir": "flows",
  "server": { "command": ["node", "server.mjs"], "url": "http://localhost:4321", "timeoutMs": 20000 },
  "loginPath": "/login",
  "ignore": ["**/*.md"]
}
```

- `baseURL` required. `flowsDir` default `flows`. `server` optional: when given and `url` is not answering, the runner starts it (cwd = root), waits up to `timeoutMs`, and stops it after the run. `loginPath` optional: landing on it during a run means outcome `env`.
- `ignore`: globs of changed files the impact map never treats as UI.

`<flowsDir>/<id>.flow.json`, written by a person (agents never edit `verify`):

```json
{
  "id": "checkout-coffee",
  "start": "/",
  "goal": "Buy one bag of coffee beans and place the order using the email from the fixtures.",
  "fixtures": { "email": "buyer@example.test", "password": "$env:E2E_PASSWORD" },
  "verify": [
    { "url": "/checkout\\.html\\?item=coffee$" },
    { "testid": "total", "text": "€12.00" },
    { "role": "status", "text": "Order confirmed" }
  ],
  "covers": ["src/checkout.html", "src/index.html"],
  "tags": ["smoke"],
  "budget": { "steps": 20, "seconds": 20 }
}
```

- `id` must equal the file name stem, `[a-z0-9-]+`.
- Fixture values: a string, or `"$env:NAME"` resolved from the runner's environment at run time (missing → outcome `env`, error names the variable). `NAME` must start with `E2E_` or `Q_PILOT_`; any other name (and `TYPESAFE_API_KEY` always) makes the flow invalid (`error`). A cloned repo must not be able to read arbitrary secrets from your environment.
- `baseURL` and `server.url` must be loopback (`localhost`, `127.0.0.1`, `[::1]`) unless the runner's environment has `Q_PILOT_ALLOW_REMOTE=1`. The opt-in comes from the user's environment, never from a repo file.
- `budget` defaults: `steps` 20, `seconds` 20.

### verify: a closed set of checks

Every check is an object with exactly one **target** key and at most one **expectation** key. Unknown keys make the flow invalid (outcome `error`).

| Target | Meaning |
|---|---|
| `url` | regex source, tested against `pathname + search` of the current page |
| `title` | exact document title |
| `role` (+ optional `name`) | `page.getByRole(role, { name, exact: true })`, first match |
| `testid` | `page.getByTestId(testid)` |
| `label` | `page.getByLabel(label, { exact: true })` (checks the input's value) |
| `text` alone (no other target) | `page.getByText(text, { exact: true })` is visible |

| Expectation | Meaning |
|---|---|
| `text` | the element's trimmed text content equals this |
| `contains` | the element's text content contains this |
| `value` | input value equals this (for `label`) |
| `visible` | `true` (default when no expectation) or `false` |

Each check polls for up to 2000 ms (like `expect`). A failed check reports `{ check, actual }` where `actual` is what was found (`null` when the element is missing).

### Traces and runs

- **Trace** (committed): `.q-pilot/traces/<id>.json`. Only `record` and `accept` write it.
- **Runs** (git-ignored): `.q-pilot/runs/<runId>/` holds `result.json`, screenshots, and for a drift or a first recording a proposed trace `<id>.trace.json`.
- The root `.gitignore` snippet: `.q-pilot/runs/`.

```json
{
  "flow": "checkout-coffee",
  "version": 1,
  "recordedAt": "2026-10-15T10:00:00.000Z",
  "steps": [
    { "op": "click", "role": "link", "name": "Buy coffee beans", "scope": "Products", "url": "/" },
    { "op": "fill", "role": "textbox", "name": "Email", "scope": "pay", "fixture": "email", "url": "/checkout.html?item=coffee" },
    { "op": "click", "role": "button", "name": "Place order", "scope": "pay", "url": "/checkout.html?item=coffee" }
  ]
}
```

- `op`: `click` | `fill` | `select` | `scroll` | `wait`. `select` adds `option` (the option's label). `fill` adds `fixture` (a key, **never a value**). `scroll` adds `delta`.
- `scope`: the accessible name of the nearest `form`, `dialog`, `[role=dialog]`, landmark or list ancestor with a name (aria-label, aria-labelledby, or form `id`/`name`), else `""`.
- `url`: `pathname + search` when the step ran.
- Traces carry no probabilities, timings or fixture values.

### Matching a step during replay

Candidates: observed actions with the same `op` kind, `role` and accessible `name` (exact, after whitespace collapse). Then:
- exactly one candidate → act on it;
- several → keep those with the same `scope`; exactly one left → act; otherwise **miss**;
- none → **miss**.

Never guess between look-alikes. A miss starts a heal (if Jev is available) or ends the flow as `blocked`.

## Runner CLI

```
node runner/pilot.mjs <command> --root <projectDir> [options]
```

| Command | Options | Does |
|---|---|---|
| `run` | `--flows a,b` or `--all`, `--budget-ms N`, `--no-jev` | For each flow: replay (or record if it has no trace and Jev is available), verify, outcome. Writes `.q-pilot/runs/<runId>/`. Never writes `.q-pilot/traces/`. |
| `record` | `--flow id`, `--budget-ms N` | Pilot from `start` with Jev until DONE/BLOCKED/budget; verify; on pass writes the trace. With an empty `verify` it does not write the trace and returns outcome `needs-verify` plus `suggestedVerify` (url, headings, `role=status`/`alert` texts of the final page). |
| `accept` | `--flow id`, `--run runId` (default: latest run that has a proposal for the flow) | Copies the proposed trace from the run into `.q-pilot/traces/<id>.json`. |
| `export` | `--flow id`, `--out path` (default `tests/q-pilot/<id>.spec.ts`) | Writes a Playwright spec from flow + trace via `exportSpec`. |
| `list` | | Flows with `id`, `covers`, `tags`, `hasTrace`, trace step `url`s. |

- **stdout**: exactly one line, the result JSON, printed last. **stderr**: progress, free text. Exit code 0 when a result was printed; non-zero only on a crash before any result (the mod treats that as `error`).
- Jev key: env `TYPESAFE_API_KEY`. Absent, or `--no-jev` → Jev unavailable.
- Jev request timeout: 3000 ms each (`--jev-timeout-ms`). Model `jev-latest` (`--jev-model`).
- `--budget-ms` caps the whole command; flows that do not start before it is spent get outcome `skipped`.

### Result JSON (the last stdout line)

```json
{
  "ok": true,
  "command": "run",
  "runId": "20261015-100000-ab12",
  "runDir": "/abs/project/.q-pilot/runs/20261015-100000-ab12",
  "durationMs": 812,
  "flows": [
    {
      "id": "checkout-coffee",
      "outcome": "drift",
      "durationMs": 772,
      "recorded": false,
      "jevCalls": 1,
      "jevMs": [437],
      "steps": [{ "op": "click", "role": "link", "name": "Buy coffee beans", "by": "replay" }],
      "diverged": [{ "step": 3, "was": { "op": "click", "role": "button", "name": "Place order" }, "now": { "op": "click", "role": "button", "name": "Pay now" }, "p": 0.82 }],
      "verifyFails": [],
      "proposal": "/abs/.../.q-pilot/runs/<runId>/checkout-coffee.trace.json",
      "screenshot": "/abs/.../.q-pilot/runs/<runId>/checkout-coffee.png",
      "error": null
    }
  ]
}
```

On a crash after start: `{ "ok": false, "command": "...", "error": "..." }`.

## Outcomes

| outcome | When |
|---|---|
| `pass` | every step replayed (or a fresh recording) and verify passed. `recorded: true` when this run recorded it (a proposal, not a trace). |
| `drift` | at least one step missed, Jev re-picked it, verify passed. `diverged` lists old → new. A proposal trace is written to the run dir. |
| `app-bug` | verify failed, and failed again on one **completed** re-run of the flow in a fresh browser context. |
| `flaky` | verify failed, then passed on the re-run. |
| `blocked` | the command or flow budget ran out (also during the flaky re-run: an unfinished re-run is never `app-bug`), a step missed and Jev was unavailable, chose BLOCKED/DONE before the trace end, more than 2 steps missed, or the step/time budget ran out. `error` says which. |
| `env` | `start` not reachable, landed on `loginPath`, server did not start, or a `$env:` fixture is missing. |
| `untraced` | no trace and Jev unavailable (nothing was run). |
| `needs-verify` | `record` with an empty `verify`. |
| `skipped` | command budget spent before the flow started. |
| `error` | invalid flow/config file, runner crash for this flow. |

## Jev usage (record and heal only)

One request per decision, like jev-ultrafast: `operation` head (CLICK, TYPE_TEXT, SELECT, SCROLL_UP/DOWN, WAIT, DONE, BLOCKED; only the ones with candidates), one target head per operation with candidates (criteria keyed by element index), and a `fixture` head (criteria = fixture **key names**) when TYPE_TEXT is offered. Every used head is checked with `validateChoice` (port of jev-ultrafast `validate_choice`); an invalid answer → no action, outcome `blocked` with the reason. State sent: `page.url`, `page.title`, `page.text` (visible text, max 6000 chars), `elements` (index, role, label, value, operations), `fixtures_available` (key names), `recent_actions` (last 10), and for a heal `step_to_replace` (the missed step's op/role/name).

**Never sent, never stored:** fixture values. Before sending, the runner redacts page text and element values: cookie / Authorization / Bearer / password= / JWT patterns (ported from the q-e2e plugin's redact, which q-pilot replaced) plus the exact resolved fixture values. A runner test asserts a fixture value does not appear in a saved trace, a proposal, or a captured Jev request.

Limits: 2 healed steps per flow, `budget.steps` actions, `budget.seconds`.

## Mod behaviour

- Options (`plugin.json` userConfig): `jevApiKey` (sensitive; empty → env `TYPESAFE_API_KEY`), `mode` off|affected|all (default affected), `trust` shadow|on (default shadow), `followUp` auto|suggest|off (default auto), `maxStopSeconds` (default 60), `node` (default `node`, the command that runs the runner).
- Gate: same structure as the removed q-e2e plugin: `classic.Stop` primary, `turn.complete` fallback (port q-e2e's detection as is; on this machine `classic.Stop` is bypassed by managed policy), at most 2 blocks / follow-ups per user prompt.
- Impact map (pure, `hooks/lib/impact.ts`): a changed file selects a flow when it matches a `covers` glob. A UI-relevant changed file that selects nothing selects the flows tagged `smoke`. When some changed files select flows and others select none, add the `smoke` flows. `mode: all` runs every flow. Not UI-relevant: `ignore` globs, docs, configs, unit tests, `.q-pilot/**`, `flows/**`.
- The mod runs the runner with `$.process.run([node, `${$.plugin.root}/runner/pilot.mjs`, 'run', '--root', root, '--flows', ids, '--budget-ms', n], { cwd: root, env: { TYPESAFE_API_KEY }, timeoutMs })` and parses the last stdout line.
- Decisions: `pass`/`flaky`(trust on) → allow. `app-bug`, `blocked`, `error` → block with flow, step, failed checks and actual values. `drift` → shadow: reported once (one block on the Stop path, one note/toast on the fallback path, no follow-up prompt), then the flow's pending edits are cleared so an unchanged follow-up turn does not re-run it; the user runs `/q-pilot accept`; on: auto-accept when the turn's diff mentions the old or the new element name (deterministic `touched`), else block. `env` → shadow: block; on: allow + notify. `untraced` / `needs-verify` → allow + note asking the user to run `/q-pilot record <id>`.
- In shadow mode the gate never writes `.q-pilot/traces/`. Only `/q-pilot record` and `/q-pilot accept` (user commands) and trust-on auto-accept do.
- Evidence tool `pilot_status` (`mcp__q-pilot__pilot_status`): returns a **string** (JSON text) with the last run per flow. A test asserts `typeof result === 'string'`.
- Commands: `/q-pilot run [all|<id>]`, `/q-pilot record <id>`, `/q-pilot accept [<id>]`, `/q-pilot status`, `/q-pilot export <id>`, `/q-pilot init`, `/q-pilot mode off|affected|all`.
- Band above the prompt while a run is red or drifted; status line summary.

## Export

`runner/export.mjs`: `export function exportSpec(flow, trace, { baseURL })` returns the text of a Playwright test file:
- `test('<flow.id>', async ({ page }) => { … })`, `page.goto(flow.start)`.
- Each step: `click` → `page.getByRole(role, { name, exact: true }).click()` (scoped with `.filter`/`locator` only if needed is out of scope for 0.1); `fill` → `.fill(process.env.<KEY> ?? '<literal>')` where a `$env:` fixture becomes `process.env.NAME` and a literal fixture is written as a literal; `select` → `.selectOption({ label })`; `scroll` → `page.mouse.wheel(0, delta)`; `wait` → `page.waitForTimeout(100)`.
- Each verify check → the matching `expect` (`toHaveURL(new RegExp(...))`, `toHaveTitle`, `toHaveText`, `toContainText`, `toHaveValue`, `toBeVisible` / `toBeHidden`).
- Pure function, no I/O; the CLI (`pilot.mjs export`) does the reading and writing.

## Limits (0.1)

- Flows are JSON, not YAML.
- No Haiku fallback: without Jev, a missed step ends as `blocked` (`jev unavailable`) and an untraced flow as `untraced`. Replay of existing traces needs no model.
- The DOM snapshot (from jev-ultrafast) does not see shadow roots, iframes, canvas, file uploads or popup tabs.

## Hardening (from review)

- Flow ids match `^[a-z0-9-]+$` and run ids `^[0-9]{8}-[0-9]{6}-[0-9a-f]{4}$` in every command; `export --out` must resolve inside `--root`.
- `accept` without `--run` takes the proposal from the latest run that contains the flow; if that run has no proposal for it, there is nothing to accept.
- `run` rejects a flow with an empty `verify` (`needs-verify`, nothing replayed counts as pass).
- Everything that leaves the runner (result JSON incl. `verifyFails[].check`, Jev requests incl. recent actions, screenshot captions) passes through the fixture redaction. Traces store real element names (never redacted names) but never fixture values.
- The runner stops its server (process group) and browser on SIGTERM/SIGINT and enforces a hard deadline of `--budget-ms` + 5 s for the whole command; the mod's `timeoutMs` is larger than that.

## Rules for every agent

- Never run git commands that write: no `add`, `commit`, `stash`, `checkout`, `reset`, `clean`, `restore`. Most of the repo is untracked; one of these can destroy the user's work.
- Edit only files you own (see Layout). Do not touch other plugins.
- `node`/`npx` on PATH are broken in this shell: use `/opt/homebrew/bin/node` and `/opt/homebrew/bin/npx`.
- Live Jev calls only behind `Q_PILOT_LIVE=1`, and only a few: it is the user's paid key.
