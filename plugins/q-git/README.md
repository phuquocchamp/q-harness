# q-git

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

`q-git` keeps the repository in view while Claude works. A one-line band above the prompt shows the branch, tracking state and pending changes. A timeline records every commit, push, merge, rebase and PR made during the session.

- **Version:** 0.1.0
- **Author:** phuquocchamp
- Pairs well with [`q-bash`](../q-bash/README.md), which badges the same git activity on each Bash panel.

## Features

| Feature | Description |
|---------|-------------|
| **Status band** | `⎇ feat/x → origin/feat/x  ↑2 ↓1  ●3 staged  ✚1 modified  ?2 untracked  ✖1 conflicts  stash 1`, or `✓ clean`. A detached HEAD shows `⎇ detached at <sha>`. Hidden outside a git repository, and while a survey is showing. |
| **Live refresh** | The status is read at session start, after every Bash call that runs `git`/`gh` or that the engine detected git activity in, and at the end of each turn (to catch file edits). |
| **Session git timeline** | `/q-git timeline` or the band's `[ timeline N ]` button opens a pane listing this session's commits, pushes, merges, rebases and PRs, newest first. Press a commit to copy its SHA, or a PR to copy its link. |
| **Hide / show** | `[ hide ]` on the band hides it for the session. `/q-git band off` hides it and remembers that across sessions. |

The timeline uses the engine's own classification of git/gh operations in each Bash result (`gitOperation`), so it doesn't parse command output.

## Install

```text
/plugin install q-git --marketplace phuquocchamp/q-harness
```

For development: `claude --plugin-dir ./plugins/q-git` (from the repository root).

## Usage

```text
/q-git status        # print the repository status
/q-git refresh       # read the status again
/q-git timeline      # open the session git timeline
/q-git band off      # hide the band (remembered); band on shows it
/q-git help
```

## Project structure

```
plugins/q-git/
├── .claude-plugin/plugin.json
├── hooks/
│   ├── hooks.json        # Registers the hook module
│   ├── register.tsx      # /q-git, git status refresh, AbovePrompt band, timeline pane
│   └── lib.ts            # Pure helpers: porcelain v2 parser, timeline events
├── tests/q-git.test.ts
├── types/index.d.ts      # Typed plugin state
└── tsconfig.json
```

## State

| Key | Type | Purpose |
|-----|------|---------|
| `status` | `GitStatus \| null` | The latest `git status --porcelain=v2 --branch --show-stash`, null outside a repository |
| `timeline` | `GitEvent[]` | Git activity of this session (last 200) |
| `band` | `boolean` | Whether the band is shown; `/q-git band` also saves it in `$.store` |

The status is read with `$.process.run(['git', 'status', ...])`. Claude Code runs git with repository hooks off. `--show-stash` needs git 2.35 or later; older versions are retried without it.

## Tests

```bash
claude plugin test ./plugins/q-git
```

The tests cover the porcelain parser (including a detached HEAD), timeline events, `/q-git status` inside and outside a repository, the band drawing and hiding, a Bash call landing in the timeline, and `band off` being saved.
