# q-git

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Where is the repository right now?** q-git keeps the branch and pending changes in view above the prompt, and records the git activity of the session.

**Version** 0.1.1 · **Author** phuquocchamp · Works with [`q-bash`](../q-bash/README.md) and [`q-files`](../q-files/README.md)

## What it ships

| Feature | What you see | Use it when |
|---------|--------------|-------------|
| **Status line** | Above the prompt: `⎇ feat/x → origin/feat/x  ↑2 ↓1  ●3 staged  ✚1 modified  ?2 untracked  ✖1 conflicts  stash 1`, or `✓ clean`. A detached HEAD shows `⎇ detached at <sha>`. Hidden outside a git repository. It stacks with other plugins' lines (for example q-files'). | You want to know which branch Claude is on, whether you are ahead or behind, and what is uncommitted, without running `git status`. |
| **Live refresh** | The line is read again at session start, after every Bash call that runs `git` or `gh` (or where the engine saw git activity), and at the end of each turn. | Always on: the line stays current while Claude edits, commits and pushes. |
| **Session timeline** | `/q-git timeline` or `[ timeline N ]` opens a pane of this session's commits, pushes, merges, rebases and PRs, newest first. Press a commit to copy its SHA, or a PR to copy its link. | At the end of a session: what did Claude commit and push? You need the SHA or the PR link. |

The timeline uses the engine's own detection of git and gh operations (`gitOperation`), so it never parses command output.

## Commands

| Command | What it does |
|---------|--------------|
| `/q-git status` | Print the repository status |
| `/q-git refresh` | Read the status again |
| `/q-git timeline` | Open the session timeline |
| `/q-git band off` | Hide the status line (`on` to show it); saved across sessions. `[ hide ]` on the line hides it for this session only. |
| `/q-git help` | Usage |

## Install

```text
/plugin install q-git --marketplace phuquocchamp/q-harness
```

## Develop

```bash
claude --plugin-dir ./plugins/q-git         # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-git
claude plugin test ./plugins/q-git          # 9 tests
```

`hooks/register.tsx` holds every hook: `/q-git`, the status refresh, the status line and the timeline pane. `hooks/lib.ts` holds pure helpers: the porcelain v2 parser and timeline events. State: `status`, `timeline` (last 200), `band`.
