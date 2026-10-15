# q-panel

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Did that command work, and what did Claude just change?** q-panel draws each Bash call and each file change (Write, Edit, NotebookEdit) as a clear bordered panel, and frames the code blocks in Claude's replies so you can collapse them.

**Version** 0.3.0 · **Author** phuquocchamp · Replaces `q-bash` 0.4.0, `q-git` 0.1.1 and `q-files` 0.1.0

## What it ships

| Feature | What you see | Use it when |
|---------|--------------|-------------|
| **Bash panel** | A bordered panel per command: `$ npm test`, status and time (`failed · 8.4s`), the call's description, and the last 4 lines of output with stderr in red. The border is green (done), red (failed), yellow (running, interrupted) or blue (background, timed out). Click the header for the full command and up to 400 lines (head and tail). | You want to know at a glance whether a command passed and why it failed. |
| **Badges** | Only when there is something to say: tests `[✓ 128  ✗ 2]` (vitest, jest, pytest, go test, cargo test), changed lines `[+42 −7]`, git `[⎇ committed 9f3e21a on main]` `[PR #42 created]`, `[⚠ unsandboxed]`. | Claude ran tests, changed files from the shell, or committed and pushed. |
| **File panel** | A bordered panel per Write, Edit and NotebookEdit call: `▸ Edit src/app.ts   done · +5 −1`, then the first 4 changed lines (green `+`, red `−`). Click the header for the whole diff with its hunk headers and context lines (up to 400 rows). New files say `Create … created`; a failed edit draws red with the error; a running one is yellow `writing…`. | You want to see what Claude changed in a file without opening it. |
| **Code blocks in replies** | Each fenced block in Claude's reply is drawn in a rounded frame with the language and line count on top, coloured by Claude Code's own highlighter. Its header has `[ copy ]`, which puts the block on your clipboard, and `[ collapse ]` / `[ expand ]`; clicking the language label (`▾ ts`) also folds it. Blocks longer than 40 lines start collapsed. Prose around the blocks stays Claude Code's normal markdown, and replies without a code block are not touched. | Claude answers with code you want to copy, or long code you want to fold away. |
| **Tidy transcript** | Claude Code's own result block under a Bash or file row is hidden (Bash images excepted). Groups made only of Bash, Write, Edit and NotebookEdit calls are unfolded so each call gets its panel. | Always on (`unfoldGroups` turns the unfolding off). |

## Commands

| Command | What it does |
|---------|--------------|
| `/q-panel config` | Show the settings |
| `/q-panel config <key> <value>` | `filePanels`, `unfoldGroups`, `codeBlocks` (on/off), `previewLines` (a number, default `4`), `codeFoldLines` (a number, default `40`) |
| `/q-panel config reset` | Restore the defaults |
| `/q-panel help` | Usage |

`filePanels off` leaves Write, Edit and NotebookEdit rows to Claude Code; `codeBlocks off` leaves replies to Claude Code. `previewLines` is shared by the Bash and file panels. `codeFoldLines` sets how long a block can be before it starts collapsed. Settings are saved across sessions; which panels and blocks you opened is kept for the session only.

## Limits

- Commands you run yourself with `! <command>` keep Claude Code's own plain row. Claude Code draws that row itself and gives plugins no hook on it, so no plugin can frame it. Ask Claude to run the command if you want the panel.
- Code blocks are coloured by Claude Code's highlighter; a language it doesn't know (bash, for one) is drawn plain inside the frame.
- A reply with a code block is drawn by q-panel. If you also install another mod that redraws replies (markdown or table renderers), only one of the two shows. Turn one off, for example with `/q-panel config codeBlocks off`.
- A NotebookEdit diff compares the cell's old and new source as whole blocks, not line by line.

## Removed in 0.2.0

The guard on destructive commands, the row above the prompt (git status and turn summary), the files and git timeline panes, and `/q-panel files`, `timeline`, `status`, `clear`, `band` and `guard` are gone. For a check on destructive commands, add them to `permissions.ask` in Claude Code's settings. Settings saved by 0.1.0 (`band`, `git`, `files`, `guard`) are ignored.

## Moving from q-bash, q-git and q-files

The three plugins are merged into this one and removed from the marketplace. Uninstall them first, or you get two panels:

```bash
claude plugin uninstall q-bash && claude plugin uninstall q-git && claude plugin uninstall q-files
claude plugin marketplace update q-harness
claude plugin install q-panel@q-harness
```

Saved settings don't carry over (each plugin has its own store), so set `previewLines` again if you changed it. Command names changed: `/q-bash config …` is now `/q-panel config …`.

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

`hooks/register.tsx` holds every hook, the state atoms and every helper that takes `$` (the validator follows `$` and `on` only within one module). `hooks/lib/` holds pure helpers:

| File | Holds |
|------|-------|
| `bash.ts` | Clipping, previews, test-output parsing, the Bash result record |
| `files.ts` | The diff of a Write, Edit or NotebookEdit call, previews, relative paths |
| `markdown.ts` | Splitting a reply at its code fences |
| `settings.ts` | Defaults, `/q-panel config` parsing, usage text |

Session state (`types/index.d.ts`): `settings`, `open` per Bash or file call, `duration` per Bash call, `codeOpen` per code block. Only `settings` is saved across sessions.

Tests live in `tests/`: one file per helper (`lib-*.test.ts`) and one per drawn surface (`bash-panel`, `file-panel`, `code-blocks`, `settings`); `host.ts` is the shared fake host.
