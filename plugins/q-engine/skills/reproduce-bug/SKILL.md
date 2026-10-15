---
name: reproduce-bug
description: Reproduce a web app bug in a real browser and write an evidence report. swe-architect plans the hypotheses, swe-verifier reproduces them with playwright-cli, and the main session compiles the report. Proposes a fix but does not apply it.
argument-hint: <app URL> <bug report: observed vs expected, route or feature>
disable-model-invocation: true
allowed-tools: Agent, Read, Write, Glob, Bash(mkdir:*), Bash(date:*)
---

## Input

$ARGUMENTS

From the input, take:
- **Target URL:** the first URL in the input, otherwise `$QE_APP_URL`. If neither exists, ask
  for it before starting.
- **Bug report:** everything else, kept verbatim.

If the bug report is ambiguous (no route, no expected behavior), ask one question before stage 1
instead of guessing.

## Login

Never put credentials in this conversation, in agent prompts, or in any file. If the app needs a
login, pick the first of these that exists and pass only its *name* to the agents:
1. a Playwright storage state file (`$QE_STORAGE_STATE`, or an `auth.json` the user points to),
   loaded with `playwright-cli state-load <file>`;
2. the environment variables `QE_APP_USER` and `QE_APP_PASSWORD`, typed in the browser as
   `"$QE_APP_USER"` / `"$QE_APP_PASSWORD"` so the shell expands them.

If the app needs a login and none of these is set, stop and tell the user which variables to set.

## Run directory

Create it once before stage 1 and pass the same paths to every stage:

- `run_dir` = `.q-engine/bugs/<YYYY-MM-DD>/<kebab-case-summary>/`
- `screenshots_dir` = `<run_dir>/screenshots/`

Use `date +%F` and `mkdir -p`. Every screenshot and stage document goes under `run_dir`. Suggest
adding `.q-engine/` to `.gitignore` if it is not ignored yet.

## Stages

Run the stages **strictly in sequence**. Each one needs the previous stage's document.

### Stage 1 — plan (`q-engine:swe-architect`, no browser, no edits)

Give it the bug report verbatim, the target URL, the route or feature, and the project root. Ask
it for:
- ranked root-cause hypotheses, each tied to file:line where possible (say so when it can't);
- browser-level reproduction steps;
- acceptance criteria that would show the bug is gone.

It has no Write tool. Save its answer yourself to `<run_dir>/01-plan.md`.

### Stage 2 — reproduce (`q-engine:swe-verifier`, reproduction mode)

Tell it explicitly:
- no fix has been applied; it is reproducing the **original** bug, not checking a fix;
- read `<run_dir>/01-plan.md` and run its reproduction steps in a fresh browser session with the
  `q-engine:playwright-cli` skill, logging in as described under **Login** (give it the variable
  or file *names* only);
- save screenshots with explicit names into `<screenshots_dir>`
  (`01-initial.png`, `02-failing-state.png`, …): at least the initial state, the failing state,
  and each step that matters;
- collect console messages and network requests at the moment the bug shows;
- mark each acceptance criterion PASS / FAIL / NOT TESTABLE with evidence, and say which
  hypotheses the evidence confirms or refutes;
- use the verdict **REPRODUCED | NOT REPRODUCED | PARTIALLY REPRODUCED**;
- write `<run_dir>/02-reproduction.md`, close the browser, and edit no source files.

### Stage 3 — report (you)

Read both stage documents and write `<run_dir>/report.md`:

```markdown
# Bug report: <short title>
**Date:** <yyyy-mm-dd> · **Target:** <URL> · **Verdict:** <verdict>

## Bug
<the bug report, verbatim>

## Reproduction
<steps actually run, with screenshots embedded as ![](screenshots/<file>.png)>

## Evidence
<console errors, failing network requests, criteria table>

## Root cause
<the hypothesis the evidence supports, with file:line, or "not established">

## Proposed fix (not applied)
<diff or description>
```

Embed only screenshots that exist, with relative paths.

## After stage 3

1. Give the user the verdict, the root cause as far as the evidence supports it, the proposed
   fix, and the path to `report.md`.
2. Do **not** apply the fix as part of this skill. Offer to hand it to `q-engine:swe-debugger` or
   `q-engine:swe-engineer`.
3. If a stage fails or returns nothing usable, stop and report what you have. Do not re-run the
   same stage a third time.
