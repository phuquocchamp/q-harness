# q-bash

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Did that command work?** q-bash draws each Bash call as a clear panel and asks before destructive commands run.

**Version** 0.4.0 · **Author** phuquocchamp · Works with [`q-git`](../q-git/README.md) and [`q-files`](../q-files/README.md)

## What it ships

| Feature | What you see | Use it when |
|---------|--------------|-------------|
| **Bash panel** | A bordered panel per command: `$ npm test`, status and time (`failed · 8.4s`), the call's description, and the last 4 lines of output with stderr in red. The border is green (done), red (failed), yellow (running, interrupted) or blue (background, timed out). | You want to know at a glance whether a command passed and why it failed, without expanding anything. |
| **Click to expand** | Click the header for the full command and up to 400 lines of output. Long output keeps the head and the tail, so the error at the end is never cut. | The last lines are not enough to see the problem. |
| **Badges** | Only when there is something to say: tests `[✓ 128 ✗ 2 ○ 3]` (vitest, jest, pytest, go test, cargo test), changed lines `[+42 −7]`, git `[⎇ committed 9f3e21a]` `[↑ pushed main]` `[PR #42 created]`, `[⚠ unsandboxed]`. | Claude ran tests, changed files from the shell, or committed and pushed. |
| **Copy command** | One button: `[ copy command ]`. | You want to run the command yourself. |
| **Guard** | Before `git push --force`, `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`, `rm -rf /`, `~`, `$HOME` or `*`, `DROP TABLE` / `TRUNCATE TABLE`, the command needs your OK, with the reason shown. This holds even when an allow rule matched. It never loosens a deny, and asks if the guard itself fails. | Claude works in `acceptEdits` or `auto` mode and you want a last check on commands you can't undo. |
| **Tidy transcript** | Claude Code's own result block under a Bash row is hidden (images excepted). Groups made only of Bash calls are unfolded so each command gets its panel; groups that also hold Reads stay folded. | Always on. |

## Commands

| Command | What it does |
|---------|--------------|
| `/q-bash config` | Show the settings |
| `/q-bash config previewLines 8` | Lines in a collapsed panel (default `4`) |
| `/q-bash config guard off` | Turn the guard off (`on` to turn it back on) |
| `/q-bash config unfoldGroups off` | Leave Bash groups folded |
| `/q-bash config reset` | Restore the defaults |
| `/q-bash help` | Usage |

Settings are saved across sessions. q-bash stores nothing else: no command history. 0.4 deletes the `history` key that 0.2 and 0.3 saved.

For more guard patterns, add `permissions.ask` rules to Claude Code's settings. Removed in 0.4: history and stats, secret masking, diff view, extra copy buttons, and the files, agent and todo views. For files, use [`q-files`](../q-files/README.md).

## Install

```text
/plugin install q-bash --marketplace phuquocchamp/q-harness
```

## Develop

```bash
claude --plugin-dir ./plugins/q-bash        # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-bash
claude plugin test ./plugins/q-bash         # 25 tests
```

`hooks/register.tsx` holds every hook. `hooks/lib.ts` holds pure helpers: clipping, previews, test parsing, guard rules and settings. State: `open` and `duration` per call, and `settings`.
