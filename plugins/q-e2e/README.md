# q-e2e

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Did Claude really check that the UI still works, or did it only say so?** q-e2e turns "tests pass" into evidence. It records the files the main loop edits. When a turn that changed UI-relevant files ends, q-e2e runs the Playwright specs that change affects. If a spec is red, Claude is sent back to work with the failing spec, its line and its error. Each red spec is triaged (Jev, then Haiku), and the plugin can hand a drifted locator to a guarded Haiku healer. Every real run is stored, so Claude can quote it.

**Version** 0.1.0 · **Author** phuquocchamp

## What it ships

| Component | What it is |
|-----------|------------|
| **Mod** (`hooks/register.tsx`) | The gate (classic `Stop`, with a `turn.complete` fallback), triage, the healer hand-off, `/q-e2e`, the evidence tool, a band above the prompt while a run is red or a heal is running, and the status line |
| **Evidence tool** `mcp__q-e2e__e2e_status` | The last real run: pass/fail per spec, triage labels, commit and age. The skill tells Claude to call it before saying UI tests pass. |
| **Agents** `q-e2e:healer`, `q-e2e:explorer` | Haiku subagents that drive a browser through the plugin's `playwright-test` MCP server (tools `mcp__plugin_q-e2e_playwright-test__*`). Neither has Bash. |
| **Skill** `e2e` | Project rules for specs: locators, assertions, the impact map, auth and secrets, what the triage labels mean |
| **MCP server** `playwright-test` | `bin/mcp-server.mjs`: runs `npx playwright run-test-mcp-server --headless` from the nearest folder at or above the session's working directory that has a `playwright.config.*` (passing it as `-c`), used by both agents |
| **Templates** | What `/q-e2e init` scaffolds: `playwright.config.ts`, `tests/auth.setup.ts`, `tests/seed.spec.ts`, `.env.e2e` (op:// references only), `q-e2e.config.json`, plus snippets for `.gitignore` and `.claude/settings.json` that you merge by hand. See [templates/README.md](templates/README.md). |

## Install

```text
/plugin install q-e2e --marketplace phuquocchamp/q-harness
```

The project needs `@playwright/test` installed (1.56 or newer for the agents' MCP server) and a `playwright.config.ts`. Run `/q-e2e init` to scaffold what is missing. Without a `playwright.config.{ts,js,mts,mjs,cts,cjs}` at the project root the stop gate stays off and `/q-e2e run` refuses to run: Playwright with no config would load every `*.test.ts` / `*.spec.ts` in the repo, unit tests included.

## Settings

Set them in `/plugin` (or under `pluginConfigs["q-e2e"].options` in your user settings).

| Option | Default | What it does |
|--------|---------|--------------|
| `jevApiKey` | empty | TypeSafe Jev API key for triage. It is stored as sensitive and is sent only in the `Authorization` header to `api.typesafe.ai`. When it is empty, `TYPESAFE_API_KEY` from the environment is used, and when that is unset too, Haiku triages. |
| `mode` | `affected` | `off`: never run at turn end. `affected`: run the specs this turn's edits affect. `all`: run the whole suite. `/q-e2e mode` overrides it per project. |
| `triage` | `shadow` | `shadow`: the triage label is logged and shown, but every red spec gates as an app bug and no healer starts. `on`: the label decides what happens (see [Triage](#triage)). |
| `followUp` | `auto` | What the [fallback gate](#the-gate) does on red. `auto`: submits the failures as a follow-up prompt, at most 2 per prompt you send. `suggest`: proposes "Fix the failing e2e spec(s): …" in the prompt box. `off`: only adds a note that Claude reads with your next prompt. |
| `maxStopSeconds` | `60` | Time budget for the gate: 75% for the Playwright run, the rest for triage and one flaky retry |
| `runner` | `npx` | Command that runs Playwright, split on spaces (`pnpm exec`, `bunx`, `yarn`) |
| `envWrapper` | empty | A prefix that injects test-account secrets, for example `op run --env-file=.env.e2e --` |

## The gate

When a turn of the main loop ends and it edited a UI-relevant file (anything but docs, configs and the paths in `ignore`), q-e2e:

1. Picks the specs with the impact map in `q-e2e.config.json`: mapped globs first, then route inference (`app/<route>/` → specs that `goto('/<route>')`), then a changed spec selects itself. If UI code changed and nothing matched, it runs the `@smoke` tag. When only some of the changed files matched, the specs that carry the smoke tag are added to the matched ones.
2. Runs `[envWrapper] runner playwright test <specs> -c <config> --retries=0 --reporter=json,line` in the project root. Each spec is passed as an anchored, escaped regex (`(?:^|/)tests/a\.spec\.ts$`), so `a.spec.ts` does not also pick up `a.spec.tsx`. Every run needs a `playwright.config.*` at the root; without one it reports an error instead of running. The JSON report goes to `.q-e2e/last-report.json`. The gate turns the config's retries off, because a drifted locator waits out the whole test timeout and a retry would double that past the budget.
3. If a spec is red, re-runs the red spec files once with whatever budget is left, whatever the triage label. A spec that passes on the re-run counts as flaky, not red, as Playwright's own retry would have marked it. If the re-run does not finish, the first run's result stands.
4. Records the run (status line, band, `mcp__q-e2e__e2e_status`, history in the plugin store).
5. If specs are still red, triages up to 3 of them and either sends Claude back to work or lets the turn end.

There are two ways the gate runs:

| Path | When | On red |
|------|------|--------|
| **classic `Stop`** (primary) | The engine lets the mod's `classic.Stop` hook run | Blocks the stop with the failing specs. Claude keeps working in the same turn. At most 2 blocks, then the turn ends with a toast. |
| **`turn.complete` fallback** | The `Stop` hook did not run for that turn | Runs the same pipeline detached, so the turn ends at once. On red it follows up as `followUp` says. At most 2 follow-ups, then it gives up on those edits, as the Stop path does. In `-p` and SDK runs it is awaited instead, because the process exits after the turn. |

**Managed settings note.** On machines with an org-managed security plugin, the debug log can show `q-e2e: classic.Stop bypassed by cc-plugin-sec-default (tier user); beneath runs`. Managed settings may skip `classic.Stop` hooks in plugins that users install, so the primary path never fires. q-e2e detects this per turn: the `Stop` hook marks the turn it saw (by `turn.start`'s id, or by time), and `turn.complete` runs the fallback only for a main-loop turn that was not marked, that ended with an answer, and that was not interrupted.

In the fallback, a follow-up prompt is sent with `$.prompt.submit` once the session is idle. The model reads it as "The q-e2e plugin sent a message". It is not sent as your own words. If the answer claimed success, the follow-up says so: *"You said the tests pass, but q-e2e ran 1 spec(s) (tests/checkout.spec.ts) after your changes: ✗ 1 failed · …"*. Only your own prompts (typed, `-p`/SDK, Remote Control) reset the 2-follow-up cap, never q-e2e's own prompts. If a hook drops the submit, q-e2e falls back to a suggestion, then to filling the prompt box, then to a toast. In every case it adds a note that Claude reads with the next prompt.

## Triage

Each red spec is classified as `app-bug`, `test-drift`, `flaky` or `env-auth`. q-e2e asks Jev first (800 ms timeout). If that fails it asks Haiku (`$.model.classify`), and if both fail the label is `app-bug`. Every decision goes to the `decisions` log in the plugin store, with its source, probability, latency, mode and what it gated as.

| Label | `triage: on` | `triage: shadow` (default) |
|-------|--------------|----------------------------|
| `app-bug` | Blocks or follows up | Blocks or follows up |
| `test-drift` | Lets the turn end and starts `q-e2e:healer` on the spec in the background | Blocks or follows up, as an app bug |
| `flaky` | Retries once; if it is still red, treats it as an app bug | Blocks or follows up, as an app bug |
| `env-auth` | Lets the turn end and sends a notification | Blocks or follows up, as an app bug |

In shadow mode the band shows the label without acting on it, for example `e2e ✗ 1 failed · checkout.spec.ts:4 · (shadow) jev: test-drift 0.84`. `/q-e2e decisions` shows how often the label agreed with the gate. Switch to `on` once the log looks right.

When the healer finishes, q-e2e checks its diff. q-e2e snapshots the text files under the test directory before the healer starts and compares them with the files after it finishes, so untracked and git-ignored files count and the diff has no size cap. It rejects a patch that adds `test.fixme`, `test.skip` or `.only`, removes or loosens an `expect` (including `toHaveText` → `toBeVisible`, a `/.*/` regex, `.catch(() => {})`), edits any file outside the test directory (every edit the healer makes is recorded, absolute paths outside the project included), or rewrites snapshot baselines. If a snapshot cannot be read, the patch is rejected. It then re-runs the spec and tells Claude the result on the next prompt.

## Commands

| Command | What it does |
|---------|--------------|
| `/q-e2e run` | Run the specs affected by the pending edits |
| `/q-e2e run all` | Run the whole suite |
| `/q-e2e status` | Last run, triage verdicts, the healer, the triage and follow-up settings, and a summary of the triage log |
| `/q-e2e decisions` | The triage log summary plus the last 10 decisions (`spec · source: label p → gated …`) |
| `/q-e2e explore "<flow>"` | Start `q-e2e:explorer` to write a spec for a user flow |
| `/q-e2e heal <spec>` | Start `q-e2e:healer` on a spec (by hand, in either triage mode) |
| `/q-e2e init` | Preview the templates and write the missing ones (never overwrites) |
| `/q-e2e mode off\|affected\|all` | Override `mode` for this project (saved) |

## Credentials and the trust boundary

- Test accounts come from the environment only (`E2E_USER_*`), injected by `envWrapper` (for example 1Password `op run`). `.env.e2e` holds `op://` references, never literal values. `auth.setup.ts` logs in once and saves `playwright/.auth/user.json`.
- The triage request to Jev carries the error, the error-context aria snapshot and this turn's diff. q-e2e redacts cookies, `Authorization`/Bearer values, `password=` pairs and the Jev key from all three, and caps their size. Haiku sees the same redacted text.
- Error text, page snapshots and test output are treated as data. The agents' prompts tell them to ignore instructions they find there. The healer can only edit files and run tests through MCP. The diff guard and the re-run decide whether its patch stands.
- The claude-settings snippet denies Claude's file tools access to `.env*`, `playwright/.auth/**`, `*.har` and traces. That does not stop a subprocess from reading them; use the sandbox if you need a hard wall.

## Demo app

[examples/demo-app](examples/demo-app/README.md) is a two-page static shop with two specs and an impact map. It has no login and needs no services. Use it to watch drift, app bugs, the smoke fallback and the evidence tool. Start Claude Code from a copy outside the plugin folder, or install the plugin from the marketplace. In testing with `--plugin-dir`, Claude's edits under the loaded plugin's own folder were refused as sensitive.

## Limits

- The test kit gives a plugin's own `$.agent.spawn` no `agentId`. Because of that, the healer's verify step (its diff guard, its re-run and the note it leaves for Claude) is not covered by `claude plugin test`. Only the hand-off is.
- The diff guard reads text files under the test directory (up to 1000, dot entries and binary files left out). A healer edit to a binary baseline is caught by its path, not its content.
- The agents need `@playwright/test` 1.56 or newer (`run-test-mcp-server`). If you already have an MCP server named `playwright-test`, Claude Code suppresses the plugin's copy, and the agents' `mcp__plugin_q-e2e_playwright-test__*` tools are missing.
- The MCP server resolves its config from its working directory, and Claude Code starts it in the session's. `bin/mcp-server.mjs` walks up from there to the nearest `playwright.config.*`. A config in a subfolder below the session directory (a monorepo opened at its root) is not found, and the server then finds no tests: open Claude Code in the folder that holds the config. It needs `node` on the PATH.
- A red spec whose locator no longer matches waits out the test timeout (30 s by default). With `maxStopSeconds: 60` the first run gets 45 s and the re-run gets what is left, so a drifted spec usually gets no complete re-run, and the turn end takes about a minute. A project with longer test timeouts needs a bigger budget.
- A follow-up turn re-runs the gate even if Claude changed nothing, because the edits stay pending while the run is red. When your instruction conflicts with the gate (for example "edit only this file"), Claude may decline, and the follow-ups are wasted turns. Use `followUp: suggest` if that happens often.
- The impact map knows only globs, three route conventions and changed specs. Anything else falls back to `@smoke`.

## Develop

```bash
claude --plugin-dir ./plugins/q-e2e        # load from disk; saving a file reloads it
claude --debug --plugin-dir ./plugins/q-e2e   # see "classic.Stop bypassed" and every $ call
claude plugin validate ./plugins/q-e2e
claude plugin test ./plugins/q-e2e
npx -p typescript tsc -p plugins/q-e2e
```

`hooks/register.tsx` holds every hook, the state atoms and every helper that takes `$`. `hooks/lib/` holds pure helpers:

| File | Holds |
|------|-------|
| `contract.ts` | Shared types: `SpecResult`, `RunEvidence`, `TriageVerdict`, `ImpactConfig`, `ImpactSelection` |
| `impact.ts` | `isUiRelevant`, `selectSpecs` (map, routes, changed specs, smoke), `globToRegExp` |
| `report.ts` | Parse the Playwright JSON report, `summarize`, `blockReason`, the Playwright argv and env |
| `jev.ts` | The Jev request and response, `redact`, the triage labels and the Haiku label text |
| `diffguard.ts` | `checkHealDiff`: the healer patch rules; `diffSnapshots`, `checkHealFiles`: the before/after snapshot diff and the file-path rules |
| `claims.ts` | `claimsSuccess`: does an answer claim the work is done or the tests pass |

Session state (`types/index.d.ts`): `edits`, `blocksThisTurn`, `lastRun`, `verdicts`, `healing`, `mode`, and for the fallback `currentTurn`, `stopSeen`, `followUps`, `interactive`. The plugin store keeps `runs` (last 20), `lastRun`, `decisions` (last 200) and `mode`.

Tests live in `tests/`: `lib-*` for the pure helpers, `mod-gate` (the classic Stop path), `mod-fallback` (the `turn.complete` fallback, follow-up modes, the cap and shadow mode), `mod-heal` and `mod-status`. `host.ts` is the shared fake host.
