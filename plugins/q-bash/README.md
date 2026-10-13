# q-bash

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

`q-bash` changes how Claude Code shows **Bash tool calls**. Each shell command appears in its own bordered, color-coded panel. The panel shows what happened at a glance: status, duration, git activity, changed files and test results. It also asks before destructive commands run and keeps a history of everything you ran.

Since 0.3.0 it also tracks the **files Claude reads and changes** (Read, Write, Edit, NotebookEdit and file changes made by Bash), sums up each turn in one line above the prompt, and draws finished subagents and todo lists as compact cards.

- **Version:** 0.3.0
- **Author:** phuquocchamp
- Pairs well with [`q-git`](../q-git/README.md), which shows the repository status above the prompt.

## Features

### Panel

| Feature | Description |
|---------|-------------|
| **Bordered Bash panel** | Every panel (Bash, Agent card, Todos) spans the full width of the transcript, so they line up. The header shows `$ <command>`, the status and the duration (`done · 2.4s`). If the call has a `description`, it appears below the header in dimmed text. |
| **Status colors** | 🟡 `running…` / `interrupted`, 🔴 `failed`, 🟢 `done`, 🔵 `⧗ background <id>` / `⏱ timed out after …`. Background and timed-out commands are no longer shown as finished. |
| **Duration** | Measured around the tool call. Shown in amber when slower than `slowMs` (10 s by default). |
| **Tail preview (collapsed)** | Shows the last `previewLines` lines (4 by default). When both streams have output, stderr gets at most half the room, so warnings can't push the result out of view. Lines are cut by terminal cell width, so color codes, emoji and CJK text don't break the layout. |
| **Head + tail (expanded)** | Click the header or `[ show details ]`. Up to `maxExpandedLines` lines (400 by default) are drawn. Longer output shows the first and last halves around a `… N lines hidden …` marker, so the error at the end is never cut. |
| **Git badges** | `[⎇ committed 9f3e21a on main]`, `[↑ pushed main]`, `[⑂ rebased main]`, `[PR #42 created]`, taken from the engine's own git detection. Includes a `[ copy PR link ]` button. |
| **Changed files** | `[3 files · +42 −7]` when the command changed files. `[ show diff ]` draws the per-file diffs. |
| **Test summary** | `[✓ 128  ✗ 2  ○ 3]` for vitest, jest, pytest, go test and cargo test output. |
| **Exit-code meaning** | Shows the engine's note for exit codes that are not errors (for example, `grep` exit 1 means no matches). |
| **Sandbox warning** | `[⚠ unsandboxed]` when the call disabled the sandbox. |
| **Secret masking** | Tokens such as `ghp_…`, `AKIA…`, `sk-…`, Slack tokens and JWTs are masked in the panel. `[ reveal N secrets ]` shows them. Only the display changes; what the model received is untouched. |
| **Large output** | When the engine saved the full output to a file, the panel shows its size and path, with `[ copy path ]`. |
| **Copy buttons** | `[ copy command ]`, `[ copy output ]`, `[ copy as markdown ]` (a fenced block with the command and output, for issues and PRs). A toast confirms the copy, or says why it failed. |
| **Highlighted command & output** | The command has a gray background (`commandBg`, `#323334`). The output sits on `outputBg` (`#22282e`). Change both with `/q-bash config`. |
| **Unfold grouped Bash calls** | Claude Code folds consecutive calls into a "ran N shell commands" line. q-bash unfolds any group that contains a Bash call, so each call gets its own panel. This unfolds the whole group, including Read/Grep calls in it. Turn it off with `/q-bash config unfoldGroups off`. |
| **No duplicate output** | The default result block under a Bash row is hidden, because the panel already shows the output and the diff. Image output is the exception: Claude Code still draws the picture. |

### Guard

Before a Bash command runs, q-bash checks it against destructive patterns. On a match it turns an **allow** into an **ask**, with the reason shown, even where an allow rule matched. A deny is never loosened. If the guard itself fails, it asks rather than letting the command through.

What happens next depends on the permission mode:

| Mode | Result of the guard's ask |
|------|---------------------------|
| `default`, `acceptEdits` | You get a confirmation prompt. |
| `auto` | The auto-mode classifier decides, and it sees the guard's reason. |
| `dontAsk` | The command is denied. |
| `bypassPermissions` | Probably no effect, since this mode skips permission checks (not verified). |

Built-in rules: `git push --force` / `-f` (but not `--force-with-lease`), `git reset --hard`, `git clean -f`, `git checkout .`, `git branch -D`, recursive `rm` of `/`, `~`, `$HOME` or `*`, and `DROP TABLE|DATABASE|SCHEMA` / `TRUNCATE TABLE`. Add your own with `/q-bash guard add`.

### History and stats

Every Bash call is recorded with its status and duration. The last 200 are kept across sessions.

- `/q-bash history` opens a pane listing the commands, newest first. Press `a`/`f` to show all or only failed commands, and `c` to clear. Press a row to copy its command.
- `/q-bash stats` prints the number of commands, the failure rate, total shell time, the five slowest commands and the most-run commands.

### Files ledger and turn band

A recorder on every Read, Write, Edit, NotebookEdit, Bash and Agent call keeps a list of the files touched this session. It uses the fields each tool returns: the lines a Read covered (`startLine`, `numLines`, `totalLines`), re-reads of unchanged files (`file_unchanged`), whether a Write created or overwrote a file, the `+/−` lines of each edit, and Bash's own file diffs (`sed -i`, formatters).

| Feature | Description |
|---------|-------------|
| **Turn band** | One line above the prompt: `this turn` (or `last turn · 13.2s`) · `read 2 files (1 partial)` · `changed 2 files` `+1` `−1` · `created 1` · `bash 1 (… failed)` · `agents 1`, with `[ Files ]` and `[ Hide ]`. A follow-up turn that ran no tools (such as the reply after a background agent) keeps the last busy turn on show. |
| **Files pane** | `/q-bash files` or `[ Files ]` on the band. One row per file: reads, edits, writes, `+/−`, **seen** (share of the file's lines read so far) and notes (`new`, `partial`, `changed 3×`, `overwritten`, `re-read 2× unchanged`, `via bash`, `via <agent>`). Filters: `a` All, `e` Changed, `r` Read only, `g` By agents, `c` Clear. Press a row to copy its path. |
| **Read summary** | Replaces the line under a standalone Read with `lines 41–60 of 200 (10%)`, `all 10 lines` or `unchanged since the last read`. In Claude Code 2.1.296 the terminal folds Reads into a `Read N files` group, where this line is not drawn; the band and the Files pane carry the same information. |

### Agent card and Todo progress

| Feature | Description |
|---------|-------------|
| **Agent card** | A finished (foreground) Agent call draws as one card: agent type, description, duration, model, tokens, tool calls, and `[read 14] [search 6] [bash 3] [2 files +40 −8]` from the agent's `toolStats`. `[ show report ]`, `[ copy report ]`, `[ copy prompt ]`. While the agent runs, and for background agents, Claude Code's own row is kept. |
| **Todo progress** | A TodoWrite call draws as `Todos 2/4 ━━━━░░░░ 50%`, one line per item, and `← done` / `← started` / `← added` next to what this call changed. |

### Features pane

`/q-bash features` lists every view with its on/off state: Turn band (`t`), Read summary (`r`), Agent card (`a`), Todo progress (`o`), Unfold Bash groups (`u`), Mask secrets (`s`) and Guard (`g`). Press the letter while the pane has focus, or click, to switch one. The choice is saved across sessions, the same as `/q-bash config <key> on|off`.

The band above the prompt has room for one plugin. If another plugin also draws there (for example `q-git`'s status band), only one of them shows; turn one off with `/q-bash config band off` or that plugin's own switch.

## Install

```text
/plugin install q-bash --marketplace phuquocchamp/q-harness
```

For development, load it from disk: `claude --plugin-dir ./plugins/q-bash` (from the repository root).

## Usage

```text
/q-bash expand-all                 # expand every panel
/q-bash collapse-all               # collapse every panel
/q-bash history                    # open the history pane
/q-bash files                      # open the files pane
/q-bash features                   # turn views on or off
/q-bash stats                      # summary of recorded commands
/q-bash config                     # show settings
/q-bash config previewLines 8      # change a setting (saved across sessions)
/q-bash config reset               # restore defaults (your guard rules are kept)
/q-bash guard list                 # show guard rules
/q-bash guard add 'kubectl\s+delete' deletes cluster objects
/q-bash guard remove 1
/q-bash guard off                  # or on
/q-bash help
```

`expand-all` and `collapse-all` set the default for every panel. Clicking a panel afterwards overrides it for that panel only, until the next `expand-all` / `collapse-all`. An unknown subcommand prints the usage and changes nothing.

### Settings

| Key | Default | Meaning |
|-----|---------|---------|
| `previewLines` | `4` | Lines in a collapsed panel |
| `maxExpandedLines` | `400` | Lines drawn in an expanded panel before the head/tail split |
| `slowMs` | `10000` | Durations at or above this are drawn in amber |
| `guard` | `on` | Ask before destructive commands |
| `maskSecrets` | `on` | Mask token-like strings in panels |
| `unfoldGroups` | `on` | Unfold "ran N shell commands" groups |
| `band` | `on` | Turn summary band above the prompt |
| `readSummary` | `on` | Line under a standalone Read saying which lines were read |
| `agentPanel` | `on` | Draw a finished Agent call as a card |
| `todoPanel` | `on` | Draw a TodoWrite call as a progress card |
| `commandBg` | `#323334` | Background of the command |
| `outputBg` | `#22282e` | Background of the output |

## Project structure

```
plugins/q-bash/
├── .claude-plugin/
│   └── plugin.json            # Plugin manifest (name, version, author, description, types)
├── hooks/
│   ├── hooks.json             # Registers the hook module
│   ├── register.tsx           # Every hook: /q-bash, guard, recorders, panels, cards, band, panes
│   ├── lib.ts                 # Pure helpers: clipping, previews, test parsing, masking, guard rules
│   └── ledger.ts              # Pure helpers: files ledger, read coverage, turn summary, todo changes
├── tests/
│   ├── bash-panel.test.ts     # Panel rendering and behavior
│   ├── guard-recorder.test.ts # Guard, recorder, /q-bash config and guard
│   ├── lib.test.ts            # Unit tests of the helpers
│   ├── ledger.test.ts         # Unit tests of the ledger helpers
│   └── views.test.ts          # Band, files pane, features pane, Agent card, Todo card, Read summary
├── types/
│   └── index.d.ts             # Typed plugin state
└── tsconfig.json              # Extends the generated .claude-plugin/types/tsconfig.json
```

## State

| Key | Type | Purpose |
|-----|------|---------|
| `panel` | `StateFamily<PanelView \| null>` | A panel's own open/closed choice and the epoch it was made in, keyed by `tool_use_id` |
| `mode` | `PanelMode` | Set by `expand-all` / `collapse-all`; each command bumps `epoch`, which makes older panel choices stale |
| `duration` | `StateFamily<number>` | Duration of each call in ms |
| `diffOpen` | `StateFamily<boolean>` | Whether a panel shows its diff |
| `revealed` | `StateFamily<boolean>` | Whether a panel shows masked secrets |
| `settings` | `BashSettings` | Settings, loaded from `$.store` at session start |
| `history` | `HistoryEntry[]` | Recorded commands, mirrored to `$.store` |
| `historyFilter` | `'all' \| 'failed'` | Filter of the history pane |
| `ledger` | `FileEntry[]` | Files read or changed this session |
| `turn` | `TurnStats \| null` | Counts of the current main-loop turn |
| `lastTurn` | `TurnStats \| null` | The last turn that did something, shown while the current one has not |
| `bandHidden` | `boolean` | `[ Hide ]` on the band, reset at the next turn |
| `filesFilter` | `FilesFilter` | Filter of the files pane |
| `agentNames` | `Record<string, string>` | Subagent id → agent type, for `via <agent>` |
| `reportOpen` | `StateFamily<boolean>` | Whether an Agent card shows its report |

`$.store` keeps `settings` and `history` across sessions.

## Tests

```bash
claude plugin test ./plugins/q-bash
```

The tests cover:

- panel rendering on terminal and desktop;
- the running, interrupted, failed, background, timed-out and empty-output states;
- expand-all / collapse-all together with clicks on single panels;
- usage text for unknown subcommands;
- git, diff, sandbox and test-summary badges;
- secret masking and revealing;
- the head/tail split of long output;
- result-block hiding (images excepted) and group unfolding;
- guard decisions, the recorder, `/q-bash config` and `guard`;
- every helper in `lib.ts` and `ledger.ts`;
- the turn band (including a quiet follow-up turn), the files pane and its filters, the features pane, the Agent card, the Todo card and the Read summary.

All hooks must stay in `register.tsx`: `claude plugin validate` does not follow `$` or `on` into an imported function, so only pure helpers live in other files.
