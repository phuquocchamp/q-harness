# q-engine

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**A small software team you can delegate to.** q-engine gives Claude Code eight subagents, one per engineering role. Each works in its own context, so the reviewer didn't write the code and the architect isn't anchored to the plan it's judging. Work passes between them as files, so nothing decided earlier is lost.

**Version** 0.2.0 · **Author** phuquocchamp · **License** MIT

## What it ships

### Agents

| Agent | Model | Edits code | Use it when | Hands off to |
|-------|-------|-----------|-------------|--------------|
| `swe-product-manager` | opus | docs only | "Is this worth building?" Market and competitor research, feature proposal, BRD, MVP scope | product owner |
| `swe-product-owner` | opus | docs only | "What exactly counts as done?" User stories, Given/When/Then criteria, out of scope, Definition of Ready | architect or engineer |
| `swe-architect` | opus | no | "What's wrong with this design?" Argues for and against, then gives a verdict | engineer, database |
| `swe-database` | sonnet | yes | Schema, normalization, migrations, slow queries; detects the engine and migration tool first | engineer, reviewer |
| `swe-engineer` | sonnet | yes | Implementing stories, a design, or a bug with a known cause; preloads `swe-core` | reviewer, verifier |
| `swe-debugger` | inherit | yes | A failing test or error with an unknown cause: reproduce, find the root cause, smallest fix | engineer or architect, reviewer |
| `swe-reviewer` | sonnet | no | After any code change: correctness, security and maintainability of the branch diff. The only agent that triggers proactively | engineer, verifier |
| `swe-verifier` | sonnet | report only | Before "done": checks each acceptance criterion with evidence and writes a report | engineer (on fail), `swe-commit` |

Invoke one by asking for it ("have the architect review this design"), with `@agent-q-engine:swe-architect`, or with `claude --agent q-engine:swe-architect`.

### Workflow skills (run only when you type them)

| Skill | What it does |
|-------|--------------|
| `/q-engine:feature <idea>` | Runs PM → PO → architect → engineer → reviewer → verifier and pauses for your approval after each stage. Each stage writes a file the next one reads (`.q-engine/features/<date>-<slug>/`). Review or verification failures loop back to the engineer, at most twice. Use `--skip-pm` or `--from=po\|architect\|engineer` to skip stages you've already done. |
| `/q-engine:reproduce-bug <url> <bug>` | The architect ranks root-cause hypotheses, the verifier reproduces the bug in a real browser with screenshots, console and network evidence, and you get `report.md` with a proposed fix (not applied). Output goes to `.q-engine/bugs/<date>/<slug>/`. |

### Knowledge skills (Claude loads them when relevant)

| Skill | What it does |
|-------|--------------|
| `swe-core` | Guidelines against common LLM coding mistakes: state assumptions, simplest solution, surgical diffs, verifiable success criteria |
| `swe-commit` | Stages only related changes, keeps secrets out, writes messages in the project's convention (Conventional Commits by default) |
| `playwright-cli` | Drives a real browser from the shell: open, click, fill, snapshot, screenshot, console, network |

## Install

```text
/plugin install q-engine@q-harness
```

### Prerequisites

- **Browser work** (`playwright-cli`, `reproduce-bug`): install Microsoft's Playwright CLI.
  ```bash
  npm install -g @playwright/cli@latest
  ```
  The skill won't install it for you.
- **Apps behind a login** (`reproduce-bug`): set one of these before starting Claude Code. Credentials are never written into prompts or files.
  ```bash
  export QE_STORAGE_STATE=./auth.json          # a saved Playwright storage state, or
  export QE_APP_USER=… QE_APP_PASSWORD=…       # typed into the login form via the shell
  export QE_APP_URL=http://localhost:3000      # optional default target
  ```
- Add `.q-engine/` to your `.gitignore` unless you want to commit the stage files.

## When it pays off

Subagents cost tokens: each starts fresh and re-reads what it needs. Use the team where a mistake is expensive:

| Situation | Use |
|-----------|-----|
| Typo, rename, small obvious edit | Nothing; do it in the main chat |
| A diff before you merge | `swe-reviewer` |
| A migration on a big table | `swe-database` |
| "Is it really done?" | `swe-verifier` |
| A bug you can't explain | `swe-debugger`, or `/q-engine:reproduce-bug` for UI bugs |
| A new feature from a vague idea | `/q-engine:feature` |

## Works with

- **q-pilot**: when both are installed, use q-pilot for checking user flows at turn end (`/q-pilot record`, `/q-pilot run`). `playwright-cli` is for ad-hoc browser work.
- **q-graph**: shows the agents q-engine spawns as a live graph.

## Credits

`skills/playwright-cli` is adapted from [microsoft/playwright-cli](https://github.com/microsoft/playwright-cli) (Apache-2.0). `skills/swe-core` is adapted from [forrestchang/andrej-karpathy-skills](https://github.com/forrestchang/andrej-karpathy-skills) (MIT). See [NOTICE](NOTICE).
