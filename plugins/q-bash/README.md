# q-bash

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

`q-bash` changes how Claude Code shows **Bash tool calls**. Each shell command appears in its own bordered, color-coded panel. The panel shows a short preview of the output, and you can click it to see the full command and output.

- **Version:** 0.1.0
- **Author:** phuquocchamp

## Features

| # | Feature | Description |
|---|---------|-------------|
| 1 | **Bordered Bash panel** | Each Bash call appears as a panel with a rounded border. The header shows `$ <command>` and a status label. If you gave the call a `description`, it appears below the header in dimmed text. |
| 2 | **Status colors** | The border and status label change color with the command's state: 🟡 `running…`, 🟡 `interrupted`, 🔴 `failed`, 🟢 `done`. |
| 3 | **Tail preview (collapsed)** | When a panel is collapsed, it shows only the **last 4 lines** of output, with a `… N earlier lines` hint above them. Long lines are cut to fit the terminal width (`…`). |
| 4 | **Click to expand** | Click the header (`▸` / `▾`) or the `[ show details ]` / `[ collapse ]` button to open or close a single panel. Expanded panels show the full multi-line command and up to **400 lines** of output. |
| 5 | **stderr highlighting** | `stderr` lines appear in red after `stdout`. For a failed call, the panel shows the error text the model received. |
| 6 | **Copy command** | The `[ copy command ]` button copies the full command to the clipboard and shows a `Command copied` toast. |
| 7 | **`/q-bash` slash command** | `/q-bash expand-all` opens every Bash panel. `/q-bash collapse-all` closes them all again, and you can still open panels one at a time by clicking. |
| 8 | **Unfold grouped Bash calls** | Claude Code normally folds consecutive calls into a "ran N shell commands" line. q-bash unfolds any group that contains a Bash call, so each call gets its own panel. |
| 9 | **No duplicate output** | Claude Code's default result block under a Bash row is hidden, because the panel already shows the output. Rows for other tools (Read, Edit, …) are not changed. |
| 10 | **Empty output notice** | When a finished command printed nothing, the panel shows `(no output)`. |
| 11 | **Highlighted command & output** | The `$ <command>` header (and the full command when expanded) has a gray background (`#323334`, same as Claude's prompt row). The output sits in its own box, one shade above the terminal background (`#22282e`). Change the colors with `COMMAND_BG` / `OUTPUT_BG` in `hooks/register.tsx`. |

## Install

```text
/plugin install q-bash --marketplace <owner>/q-harness
```

For development, load it from disk: `claude --plugin-dir ./plugins/q-bash` (from the repository root).

## Usage

```text
/q-bash expand-all     # expand every Bash panel
/q-bash collapse-all   # collapse all panels (click a header to open one)
```

## Project structure

```
plugins/q-bash/
├── .claude-plugin/
│   └── plugin.json          # Plugin manifest (name, version, description, types)
├── hooks/
│   ├── hooks.json           # Registers the hook module
│   └── register.tsx         # Panel rendering, /q-bash command, UI overrides
├── tests/
│   └── bash-panel.test.ts   # Tests for panel rendering and behavior
├── types/
│   └── index.d.ts           # Typed plugin state (expanded, expandAll)
└── tsconfig.json            # Extends the generated .claude-plugin/types/tsconfig.json
```

## State

| Key | Type | Purpose |
|-----|------|---------|
| `expanded` | `StateFamily<boolean>` | Whether each panel is expanded, keyed by Bash call (`tool_use_id`) |
| `expandAll` | `boolean` | Set by `/q-bash expand-all` to expand every panel |

## Tests

`tests/bash-panel.test.ts` checks that:

- a Bash row is drawn as a bordered panel that previews the output tail and expands when pressed (terminal and desktop);
- rows for other tools are left to Claude Code;
- a failed Bash row draws in red with the error text;
- the default result block is hidden for Bash only;
- tool groups that contain a Bash call are unfolded.
