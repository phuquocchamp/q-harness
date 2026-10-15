# q-pilot

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Does the app still work for a user, and who decides?** q-pilot checks user flows instead of Playwright specs. A flow is a goal in plain words, some fixtures and a `verify` block. Jev (TypeSafe) records the path once and heals a step when the UI drifts. Every other run is a replay of the recorded trace with no model call. The verdict never comes from Jev: code evaluates the `verify` block. When a turn that changed UI files ends, q-pilot runs the flows that change affects and sends Claude back to work if one is red.

**Version** 0.1.0 · **Author** phuquocchamp · [Design report (artifact)](https://claude.ai/artifact/4xGkHn6HugVUsyJcEQtyYS)

Numbers from the design PoC (measured there, not re-measured for this README):

| Case | Time | Jev calls |
|------|------|-----------|
| Green replay | 0.32 s | 0 |
| Drifted step, healed | 0.77 s | 1 |
| Today's Playwright spec on the same drift | 31.7 s (waits out the test timeout) | n/a |

## What it ships

| Component | What it is |
|-----------|------------|
| **Mod** (`hooks/register.tsx`) | The gate (classic `Stop`, with a `turn.complete` fallback), the impact map, `/q-pilot`, the evidence tool, a band above the prompt while a run is red or drifted, and the status line |
| **Runner** (`runner/pilot.mjs`) | Plain Node ESM CLI (Node 18+): `run`, `record`, `accept`, `export`, `list`. It drives Chromium through the project's own Playwright, takes a DOM snapshot, replays traces, calls Jev, and evaluates `verify`. |
| **Evidence tool** `mcp__q-pilot__pilot_status` | The last run per flow: outcome, time and `jevCalls`. The skill tells Claude to call it before saying UI tests pass. |
| **Skill** `flows` | Project rules: evidence before claims, never edit `verify` or traces, how to write a goal and checks, what each outcome means |
| **Export** (`runner/export.mjs`) | Turns a flow and its trace into a Playwright test file |

## Install

```text
/plugin install q-pilot --marketplace phuquocchamp/q-harness
```

The project needs `playwright` or `@playwright/test` installed, and a `q-pilot.config.json` at its root (`/q-pilot init` writes it, together with `flows/example.flow.json`, and never overwrites an existing file). Add `.q-pilot/runs/` to `.gitignore`. The runner resolves Playwright from the project, so q-pilot ships no browser of its own.

Jev needs a TypeSafe API key: set the `jevApiKey` option, or `TYPESAFE_API_KEY` in the environment. Without it, replay of existing traces still works.

## Quick start

[examples/demo-app](examples/demo-app) is a two-page static shop with one flow, `checkout-coffee`. Its only fixture is a literal email: the demo has no login and no password fixture. Copy it out of the plugin folder, install Playwright there, and start Claude Code in the copy.

```bash
cp -r plugins/q-pilot/examples/demo-app /tmp/demo && cd /tmp/demo
npm install && npx playwright install chromium
export TYPESAFE_API_KEY=...        # only needed to record and heal
claude --plugin-dir /path/to/q-harness/plugins/q-pilot
```

Then:

1. `/q-pilot record checkout-coffee`. Jev walks the goal from `start`, the runner evaluates `verify`, and on a pass the trace is written to `.q-pilot/traces/checkout-coffee.json`. Commit it.
2. `/q-pilot run all`. The flow replays: no Jev call, under a second on a small app.
3. Rename the "Place order" button in `src/checkout.html` and run again. The step misses, Jev re-picks it, and the outcome is `drift`. `/q-pilot accept` saves the new trace.

## The flow file

`<flowsDir>/<id>.flow.json`, written by a person. `id` equals the file name stem (`[a-z0-9-]+`).

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

| Field | Meaning |
|-------|---------|
| `start` | Path where the flow begins |
| `goal` | What a user wants to do, in plain words. Jev reads it. |
| `fixtures` | Values the flow may type. A string, or `"$env:NAME"`, read from the runner's environment at run time. `NAME` must start with `E2E_` or `Q_PILOT_` (`TYPESAFE_API_KEY` never), or the flow is invalid (`error`): a cloned repo must not read arbitrary secrets from your environment. A missing variable gives outcome `env`. |
| `verify` | The checks that decide pass or fail (below) |
| `covers` | Globs of source files whose change selects this flow |
| `tags` | `smoke` flows run when UI code changed and nothing matched |
| `budget` | `steps` (default 20) and `seconds` (default 20) |

### verify checks

Every check has exactly one target and at most one expectation. An unknown key makes the flow invalid (outcome `error`). Each check polls for up to 2 s. A failed check reports what it found (`null` when the element is missing).

| Target | Meaning |
|--------|---------|
| `url` | Regex source, tested against `pathname + search` |
| `title` | Exact document title |
| `role` (+ `name`) | `getByRole(role, { name, exact: true })`, first match |
| `testid` | `getByTestId` |
| `label` | `getByLabel(label, { exact: true })` (checks the input's value) |
| `text` alone | `getByText(text, { exact: true })` is visible |

| Expectation | Meaning |
|-------------|---------|
| `text` | Trimmed text content equals this |
| `contains` | Text content contains this |
| `value` | Input value equals this (for `label`) |
| `visible` | `true` (the default) or `false` |

## Traces and runs

| Path | What | Commit it? |
|------|------|------------|
| `.q-pilot/traces/<id>.json` | The recorded steps: `op`, `role`, accessible `name`, `scope`, `url`. A `fill` stores the fixture's key, never its value. No timings or probabilities. | Yes. Only `/q-pilot record` and `/q-pilot accept` write it. |
| `.q-pilot/runs/<runId>/` | `result.json`, screenshots, and a proposed trace `<id>.trace.json` for a drift or a first recording | No (git-ignored) |

During replay a step matches an observed element with the same `op`, `role` and exact accessible `name`. If several look alike, the `scope` (the name of the nearest form, dialog, landmark or list) must pick exactly one. Otherwise it is a miss. q-pilot never guesses between look-alikes.

## Outcomes

| Outcome | When |
|---------|------|
| `pass` | Every step replayed (or a fresh recording) and verify passed. `recorded: true` means the run made a proposal, not a trace. |
| `drift` | A step missed, Jev re-picked it, verify passed. The result lists old and new. A proposal is written to the run folder. |
| `app-bug` | Verify failed, and failed again on a re-run in a fresh browser context |
| `flaky` | Verify failed, then passed on the re-run |
| `blocked` | A step missed and Jev was unavailable or chose BLOCKED/DONE early, more than 2 steps missed, or the step or time budget ran out |
| `env` | `start` unreachable, landed on `loginPath`, the server did not start, or a `$env:` fixture is missing |
| `untraced` | No trace and Jev unavailable. Nothing ran. |
| `needs-verify` | `record` with an empty `verify`. The result carries suggested checks. |
| `skipped` | The command budget ran out before the flow started |
| `error` | Invalid flow or config file, or a runner crash for this flow |

## The gate

When a turn of the main loop ends and it edited a UI-relevant file (not docs, configs, unit tests, `.q-pilot/**`, `flows/**` or the `ignore` globs), q-pilot picks the flows with the impact map: a changed file selects a flow whose `covers` glob matches it. UI code that selects nothing selects the `smoke` flows. When only some changed files match, the `smoke` flows are added. `mode: all` runs every flow.

The runner then runs those flows. What the gate does with each outcome depends on `trust`:

| Outcome | `trust: shadow` (default) | `trust: on` |
|---------|---------------------------|-------------|
| `pass` | Allow | Allow |
| `flaky` | Block | Allow |
| `app-bug`, `blocked`, `error` | Block with the flow, step, failed checks and actual values | Same |
| `drift` | Reported once to you; Claude is not sent back for it. You run `/q-pilot accept` | Auto-accept when the turn's diff mentions the old or the new element name, otherwise block |
| `env` | Block | Allow and notify |
| `untraced`, `needs-verify` | Allow with a note asking you to run `/q-pilot record <id>` | Same |

In shadow mode the gate never writes `.q-pilot/traces/`. At most 2 blocks or follow-ups happen per prompt you send.

The band above the prompt shows `pilot ✗ 1 of 3 flows: checkout app-bug` while a run is red, and `pilot ≈ 1 of 3 flows: checkout drift · /q-pilot accept` (amber) when the only problem is drift. The status line shows `pilot ✓ 3/3 flows` when all pass. (Text as reported by the mod agent; not run by me.)

As in q-e2e, `classic.Stop` is the primary path and `turn.complete` is the fallback for machines where managed settings skip `classic.Stop` hooks in user-installed plugins.

## Commands

| Command | What it does |
|---------|--------------|
| `/q-pilot run [all\|<id>]` | Run the affected flows, one flow, or all |
| `/q-pilot record <id>` | Record the flow with Jev and write its trace on a pass |
| `/q-pilot accept [<id>]` | Save the proposed trace from the latest run that has one |
| `/q-pilot status` | Last outcome per flow |
| `/q-pilot export <id>` | Write a Playwright spec (default `tests/q-pilot/<id>.spec.ts`) |
| `/q-pilot init` | Write a starter `q-pilot.config.json` and `flows/example.flow.json`, never overwriting |
| `/q-pilot mode off\|affected\|all` | Override `mode` for this project |

The runner takes the same commands directly: `node runner/pilot.mjs <run|record|accept|export|list> --root <projectDir>`. It prints one line of result JSON last on stdout, and progress on stderr.

## Settings

Set them in `/plugin`.

| Option | Default | What it does |
|--------|---------|--------------|
| `jevApiKey` | empty | TypeSafe Jev API key (sensitive). When empty, `TYPESAFE_API_KEY` is used. When both are missing, Jev is unavailable. |
| `mode` | `affected` | `off`, `affected` (flows the turn's edits affect), or `all` |
| `trust` | `shadow` | `shadow` or `on`, see [The gate](#the-gate) |
| `followUp` | `auto` | What the fallback gate does on red: `auto`, `suggest` or `off` |
| `maxStopSeconds` | `60` | Time budget for the gate |
| `node` | `node` | Command that runs the runner |

`q-pilot.config.json` (project root): `baseURL` (required), `flowsDir` (default `flows`), `server` (`command`, `url`, `timeoutMs`; started when `url` does not answer and stopped after the run), `loginPath` (landing on it means `env`) and `ignore`.

Trust boundaries:

- `server.command` runs code from the repo, with the same trust as Playwright's `webServer`. Read it before you run a repo you did not write.
- `baseURL` and `server.url` must be loopback (`localhost`, `127.0.0.1`, `[::1]`). A remote URL needs `Q_PILOT_ALLOW_REMOTE=1` in your own environment. A repo file cannot set it.

## Jev: what is sent, what never is

Jev is called only to record and to heal a step. Replay makes no call. Each request has a 3 s timeout (model `jev-latest`).

| Sent | Never sent |
|------|------------|
| Page URL and title | Fixture values (only their key names) |
| Visible page text (up to 6000 characters) | Cookies, `Authorization`/Bearer values, `password=` pairs, JWTs |
| Interactive elements: index, role, label, value, allowed operations | The exact resolved fixture values, even when they appear on the page |
| Fixture key names, the last 10 actions, and for a heal the missed step | The `verify` block |

Page text and element values are redacted before sending. Traces and proposals store fixture keys, never values.

## How it differs

- **q-e2e** runs Playwright specs you write and maintain. When a locator drifts, the spec fails and waits out its timeout. q-pilot keeps no spec: the flow is the source, the trace is generated, and a drifted step is re-picked in under a second. q-pilot can [export](#commands) a flow as a spec when you want one.
- **jev-ultrafast** is a loop where the model picks every action. q-pilot uses Jev only to record and to heal. The pass/fail verdict comes from `verify`, not from Jev reporting DONE.

## Limits

- Flows are JSON, not the YAML the design report showed.
- There is no Haiku fallback in 0.1. Without Jev, a missed step ends as `blocked` and an untraced flow as `untraced`. Replay of existing traces needs no model.
- The DOM snapshot does not see shadow roots, iframes, canvas, file uploads or popup tabs.
- Look-alike elements (same role and name, not told apart by scope) become misses, never guesses.
- A flow heals at most 2 steps. More misses end as `blocked`.
- Exported specs do not narrow a locator by `scope`, so an export of a flow with look-alike elements may need a hand edit.
- The PoC numbers above are from the design report. They are not a benchmark of this release.

See [TODOS.md](TODOS.md) for what is next.

## Develop

| Path | What |
|------|------|
| `.claude-plugin/plugin.json` | Mod manifest and options |
| `hooks/register.tsx`, `hooks/lib/` | The mod: gate, commands, tool, band; pure helpers such as the impact map |
| `runner/pilot.mjs` and `runner/*.mjs` | The CLI: snapshot, executor, replay, record, jev, verify, redact, flow, trace |
| `runner/export.mjs` | `exportSpec(flow, trace, { baseURL })`, a pure function |
| `skills/flows/SKILL.md` | Rules Claude follows |
| `examples/demo-app/` | Demo app with a flow and a config |
| `DESIGN.md` | The contract between the mod, the runner and the export |

```bash
claude --plugin-dir ./plugins/q-pilot       # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-pilot
claude plugin test ./plugins/q-pilot        # mod tests (tests/*.test.ts)
node --test plugins/q-pilot/runner/*.test.mjs   # runner and export tests
```

The export test also runs an exported spec with `playwright test` against a copy of `q-e2e/examples/demo-app`. It is skipped when Playwright is not installed there.
