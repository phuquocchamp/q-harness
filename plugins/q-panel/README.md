# q-panel

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Did that command work, where is the repo, and what did the turn just touch?** q-panel draws each Bash call as a clear panel, asks before destructive commands, and keeps one row above the prompt with the repository status and what the last turn read, changed and ran.

**Version** 0.1.0 · **Author** phuquocchamp · Replaces `q-bash` 0.4.0, `q-git` 0.1.1 and `q-files` 0.1.0

## What it ships

| Feature | What you see | Use it when |
|---------|--------------|-------------|
| **Bash panel** | A bordered panel per command: `$ npm test`, status and time (`failed · 8.4s`), the call's description, and the last 4 lines of output with stderr in red. The border is green (done), red (failed), yellow (running, interrupted) or blue (background, timed out). Click the header for the full command and up to 400 lines (head and tail). | You want to know at a glance whether a command passed and why it failed. |
| **Badges** | Only when there is something to say: tests `[✓ 128  ✗ 2]` (vitest, jest, pytest, go test, cargo test), changed lines `[+42 −7]`, git `[⎇ committed 9f3e21a on main]` `[PR #42 created]`, `[⚠ unsandboxed]`. | Claude ran tests, changed files from the shell, or committed and pushed. |
| **Guard** | Before `git push --force`, `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`, `rm -rf /`, `~`, `$HOME` or `*`, `DROP TABLE` / `TRUNCATE TABLE`, the command needs your OK, with the reason shown. This holds even when an allow rule matched. It never loosens a deny, and asks if the guard itself fails. | Claude works in `acceptEdits` or `auto` mode and you want a last check on commands you can't undo. |
| **The row above the prompt** | `⎇ feat/x → origin/feat/x  ↑2  ●3 staged  ✚1 modified │ read 2 (1 partial) · changed 2 +18 −3 · bash 3 (1 failed)  [ files ] [ timeline 4 ] [ hide ]`. Stacks under other plugins' rows. A follow-up turn that ran no tools keeps the last busy turn on show. | You come back after a turn: which branch, what's uncommitted, what did Claude read and change, did anything fail? |
| **Files pane** | `/q-panel files` or `[ files ]` (hotkey `f`): **changed** files with `+12 −3` or `new`, then **read only** files. `40% read` marks a file Claude read only part of, `re-read 2×` repeated reads. Press a row to copy its path. | Before you review or commit: what did this session change, and did Claude read the whole file before editing it? |
| **Git timeline pane** | `/q-panel timeline` or `[ timeline N ]`: this session's commits, pushes, merges, rebases and PRs, newest first. Press a commit to copy its SHA, a PR to copy its link. | What did Claude commit and push this session? |
| **Tidy transcript** | Claude Code's own result block under a Bash row is hidden (images excepted). Groups made only of Bash calls are unfolded so each command gets its panel. | Always on (`unfoldGroups` turns the unfolding off). |

What counts in the files list: Read, Write, Edit and NotebookEdit calls, plus Bash commands that changed files (`sed -i`, formatters, from the engine's own diff), inside subagents too. The list keeps the 500 most recent files; read-only files leave before changed ones.

## Commands

| Command | What it does |
|---------|--------------|
| `/q-panel files` | Open the files pane |
| `/q-panel timeline` | Open the git timeline pane |
| `/q-panel status` | Print the repository status |
| `/q-panel clear` | Forget the files and the turn counts recorded so far |
| `/q-panel band on\|off` | Show or hide the row above the prompt (saved). `[ hide ]` on the row hides it for this session only. |
| `/q-panel guard on\|off` | Turn the guard on or off (saved) |
| `/q-panel config` | Show the settings |
| `/q-panel config <key> <value>` | `band`, `git`, `files`, `guard`, `unfoldGroups` (on/off), `previewLines` (a number, default `4`) |
| `/q-panel config reset` | Restore the defaults |
| `/q-panel help` | Usage |

`git off` drops the git segment from the row and stops reading `git status` on its own; `files off` drops the turn segment. Only the settings are saved across sessions. The files list, turn counts and git timeline live in session state only.

## Moving from q-bash, q-git and q-files

The three plugins are merged into this one and removed from the marketplace. Uninstall them first, or you get two panels, two guards and two rows:

```bash
claude plugin uninstall q-bash && claude plugin uninstall q-git && claude plugin uninstall q-files
claude plugin marketplace update q-harness
claude plugin install q-panel@q-harness
```

Saved settings don't carry over (each plugin has its own store), so set `previewLines`, `guard` and the row again if you changed them. Command names changed: `/q-bash config …`, `/q-git …` and `/q-files …` are now `/q-panel …`.

## Install

```text
/plugin install q-panel --marketplace phuquocchamp/q-harness
```

## Develop

```bash
claude --plugin-dir ./plugins/q-panel       # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-panel
claude plugin test ./plugins/q-panel
```

`hooks/register.tsx` holds every hook, the state atoms and every helper that takes `$` (the validator follows `$` and `on` only within one module). `hooks/lib/` holds pure helpers: `bash.ts` (clipping, previews, test parsing, guard rules), `git.ts` (porcelain v2 parser, timeline events), `ledger.ts` (files ledger, read coverage, turn counts) and `settings.ts` (defaults, `/q-panel config` parsing, usage). State: `settings`, `hidden`, `open` and `duration` per Bash call, `status`, `timeline` (last 200), `ledger`, `turn`, `lastTurn`.
