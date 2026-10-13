# q-files

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**What did Claude just read and change?** q-files sums up each turn in one line above the prompt and lists every file the session touched.

**Version** 0.1.0 · **Author** phuquocchamp · Works with [`q-bash`](../q-bash/README.md) and [`q-git`](../q-git/README.md)

## What it ships

| Feature | What you see | Use it when |
|---------|--------------|-------------|
| **Turn line** | After each turn, above the prompt: `read 2 (1 partial) · changed 2 +1 −1 · created 1 · bash 1 (1 failed)  [ files ]`. It stacks under other plugins' lines (for example q-git's), so both show. A follow-up turn that ran no tools keeps the last busy turn on show. | You come back after a turn and want the result in one glance: how much Claude read, what it changed, whether anything failed. |
| **Files list** | `/q-files` (or `[ files ]`, hotkey `f`) opens a pane with two groups. **changed**: `+12 −3` or `new`, then the path. **read only**: the path. `40% read` marks a file Claude read only part of; `re-read 2×` marks repeated reads of an unchanged file. Newest first. Press a row to copy its path. | Before you review or commit: which files did this session change? Did Claude read the whole file before editing it? |
| **What counts** | Read, Write, Edit and NotebookEdit calls, plus Bash commands that changed files (`sed -i`, formatters, from the engine's own diff). Calls inside subagents count too. | Always on. |

## Commands

| Command | What it does |
|---------|--------------|
| `/q-files` | Open the files list |
| `/q-files band off` | Hide the turn line (`on` to show it); saved across sessions |
| `/q-files clear` | Forget the files recorded so far |
| `/q-files help` | Usage |

The files list lives in session state only. Nothing about your files is written to disk; q-files stores only the `band` switch.

## Install

```text
/plugin install q-files --marketplace phuquocchamp/q-harness
```

## Develop

```bash
claude --plugin-dir ./plugins/q-files       # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-files
claude plugin test ./plugins/q-files        # 11 tests
```

`hooks/register.tsx` holds every hook: the recorder, turn hooks, the turn line and the pane. `hooks/ledger.ts` holds pure helpers: the file ledger, read coverage, turn counts and grouping. State: `ledger`, `turn`, `lastTurn`, `settings`.
