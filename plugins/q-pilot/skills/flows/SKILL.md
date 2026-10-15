---
name: flows
description: How this project's UI flows are checked with the q-pilot plugin. Use when touching flows/*.flow.json, .q-pilot/, or q-pilot.config.json, when a q-pilot run is red or drifted, or before saying that a UI change works, a flow passes, or a feature is done.
---

# UI flows with q-pilot

q-pilot checks user flows, not specs. A flow is a goal in plain words, fixtures and a `verify` block. Jev records the path once into a trace. Later runs replay the trace with no model. When one step no longer matches, Jev re-picks that step only. Pass or fail comes from the `verify` block, which code evaluates. Jev's DONE never decides it.

When you try to finish a turn that changed UI-relevant files, the gate runs the flows that change affects. A red flow blocks the stop (or arrives as a follow-up message from the q-pilot plugin). A drift in shadow mode is reported to the user once and does not send you back. That message is real run output: fix what it lists.

## Rule 1: evidence before claims

Never say a UI flow passes, a UI change works or a fix is verified unless a q-pilot run shows it. Call `mcp__q-pilot__pilot_status` and quote the result: outcome per flow, age. If the last run is older than your last edit, or does not cover the flows you touched, say so and run them (`/q-pilot run`). Unit tests passing is not UI evidence.

## Rule 2: never edit the evidence

- Do not edit a flow's `verify` block. It is the definition of correct, and a person writes it. If you think it is wrong, say so and let the user change it.
- Do not edit or create anything under `.q-pilot/traces/`. Only `/q-pilot record` and `/q-pilot accept` write traces. Tell the user to run one of them. Do not copy a proposal from `.q-pilot/runs/` by hand.
- Do not change a flow or its `verify` to make a red run green. Fix the app.
- Never write a credential into a flow. Use `"$env:NAME"` for secrets. `NAME` must start with `E2E_` or `Q_PILOT_`, or the flow is invalid. Fixture values never go into traces, so keep it that way.

## Project layout

```
q-pilot.config.json          baseURL, flowsDir (default flows), optional server, loginPath, ignore
flows/<id>.flow.json         one flow per file; id equals the file name stem, [a-z0-9-]+
.q-pilot/traces/<id>.json    the recorded path (committed)
.q-pilot/runs/<runId>/       result.json, screenshots, proposed traces (git-ignored)
```

## Writing a good flow

A flow is a short, concrete goal plus checks that only a finished flow can satisfy.

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
  "tags": ["smoke"]
}
```

**Goal:** one outcome, in plain words, naming the things on the page the way a user sees them ("Buy one bag of coffee beans", not "click #buy"). Refer to fixtures by what they are ("the email from the fixtures"). Do not describe the clicks: Jev picks them and the trace keeps them.

**Verify:** check the result, not that the clicks happened. Prefer the end state a user would confirm: the final URL, a confirmation message, a total. Each check has one target and at most one expectation:

| Target | Notes |
|--------|-------|
| `url` | regex source, tested against path + query |
| `title` | exact document title |
| `role` (+ `name`) | accessible role and exact name |
| `testid` | `data-testid` |
| `label` | form field by label (use with `value`) |
| `text` alone | exact text is visible |

Expectations: `text` (equals), `contains`, `value`, `visible` (`true` or `false`). Do not invent other keys: an unknown key makes the flow invalid (outcome `error`). Aim for two or three checks, and at least one that fails if the flow ended on the wrong page.

**Covers and tags:** list the source files whose change should run the flow in `covers` (globs). Tag the cheap critical flows `smoke`: the gate runs them when UI code changed but no flow matched.

You may write a flow and suggest its `verify`, but a person confirms it. When a flow has no trace, ask the user to run `/q-pilot record <id>`.

## Outcomes and what to do

| Outcome | Meaning | What you do |
|---------|---------|-------------|
| `pass` | Every step replayed and verify passed. `recorded: true` means this run recorded it, and the trace is only a proposal. | Report it as passing, with the run's age. |
| `drift` | A step no longer matched, Jev re-picked it, verify passed. The result lists old and new element names. | If your change renamed or moved that element on purpose, tell the user and ask them to run `/q-pilot accept <id>`. If not, you may have broken the UI: look at the diverged step first. |
| `app-bug` | Verify failed, and failed again on a re-run. | Fix the app. Read the failed checks and `actual` values (`null` means the element is missing). |
| `flaky` | Verify failed once, then passed. | Say it is flaky. Look for a race (late render, async data) in what you changed. Do not retry until green and call it done. |
| `blocked` | A step missed and could not be healed (Jev unavailable, too many misses, or the budget ran out). The `error` says which. | Check whether your change removed or renamed the element. If Jev is unavailable, tell the user: replay still works, healing needs the key. |
| `env` | The app was unreachable, landed on the login page, the server did not start, or a `$env:` variable is missing. | Not an app verdict. Tell the user what is missing. Do not edit the flow. |
| `untraced` | No trace and Jev unavailable. Nothing ran. | Tell the user to set the Jev key or run `/q-pilot record <id>`. |
| `needs-verify` | `record` ran with an empty `verify`. | Show the suggested checks and ask the user to add them. |
| `skipped` | The time budget ended before the flow started. | Run it again with `/q-pilot run <id>`. |
| `error` | Invalid flow or config file, or a runner crash. | Read the message and fix the file, except `verify` (Rule 2). |

## Commands (the user's)

`/q-pilot run [all|<id>]`, `record <id>`, `accept [<id>]`, `status`, `export <id>`, `init`, `mode off|affected|all`. Recording and accepting are the user's decisions, so ask rather than doing them in a shell.
