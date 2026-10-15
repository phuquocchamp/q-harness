# q-harness

![q-harness: a marketplace of plugin harnesses that equip Claude Code for real software engineering work](docs/images/q-harness.png)

> A marketplace of plugin harnesses that equip Claude Code for real software engineering work, by [**phuquocchamp**](https://github.com/phuquocchamp)

This repository is a Claude Code plugin **marketplace** named `q-harness`. Each plugin lives in its own folder under `plugins/` and is installed, enabled and versioned on its own. A plugin can ship any mix of components:

| Component | What it adds |
|-----------|--------------|
| Mods | TypeScript running inside Claude Code: panels, guards, bands above the prompt |
| Subagents | Focused workers Claude can hand a task to |
| Skills | Packaged know-how Claude loads when a task calls for it |
| Commands | Slash-command workflows |
| Hooks | Handlers on tool and prompt events |
| MCP servers | External tools and data sources |

## Plugins

| Plugin | Version | Components | Description |
|--------|---------|------------|-------------|
| [`q-panel`](plugins/q-panel/README.md) | 0.3.0 | mod | Draws each Bash call and each file change (Write, Edit, NotebookEdit) as a bordered panel, and frames the code blocks in replies with copy and collapse buttons. Replaces `q-bash`, `q-git` and `q-files`. |
| [`q-pilot`](plugins/q-pilot/README.md) | 0.9.0 | mod, skill | Runs browser tasks from a prompt like jev-ultrafast: `/q-pilot task "<what to do>"`, Claude writes the task, Jev picks every step, Playwright executes it, and a live inspector in your own browser shows and pauses each decision. When Jev is stuck (a loop, a picker, a CAPTCHA, a DONE nothing checks) a helper model (Haiku by default) answers first, then your session through `pilot_help`, with the browser still open. Settings: `/q-pilot config`. Tests UI features too: `/q-pilot test "<what to check>"` or Claude itself writes a spec with checks, Jev drives, and code grades the checks. Passing tests can be saved as flows that the stop gate replays with no model. Replaces q-e2e. |
| [`q-graph`](plugins/q-graph/README.md) | 0.1.0 | mod | Shows the subagents and teammates of a session as a live graph: a roster band above the prompt, an alert when one waits for you, and a pane with the agent tree, what each agent used (tools, skills, MCP servers, rules) and the session's harness, plus a live browser view with a session timeline, where clicking a node shows its prompt, result and every tool call with input and output. |
| [`q-advisor`](plugins/q-advisor/README.md) | 0.1.0 | mod | Context advice at turn boundaries: focuses Claude Code's own autocompact on the plan, decisions and changed files, and suggests compacting, clearing for a new task or switching model. Jev (Haiku fallback) makes the judgement calls; it starts in shadow mode. |
| [`q-engine`](plugins/q-engine/README.md) | 0.2.0 | agents, skills | A software engineering team as subagents (`swe-product-manager`, `swe-product-owner`, `swe-architect`, `swe-database`, `swe-engineer`, `swe-debugger`, `swe-reviewer`, `swe-verifier`) that hand work to each other through files, with the `/q-engine:feature` and `/q-engine:reproduce-bug` workflows and the `swe-core`, `swe-commit` and `playwright-cli` skills. |

## Use case 1: Install from GitHub (users)

You only want to use the plugins. Nothing to clone.

**One step**, at the prompt of a Claude Code terminal session:

```text
/plugin install q-panel --marketplace phuquocchamp/q-harness
```

Answer `y` to add the marketplace, then pick a scope (`user`, `project` or `local`).

**Or two steps**, from your shell:

```bash
claude plugin marketplace add phuquocchamp/q-harness   # GitHub shorthand; a git URL also works
claude plugin install q-panel@q-harness                 # -s user|project|local, default user
```

Then run `/reload-plugins` in an open session (or start a new one). Check the result with `claude plugin list` or `/plugin`.

Install more plugins from the same marketplace with `claude plugin install <plugin>@q-harness`.

### Stay up to date and remove

```bash
claude plugin marketplace update q-harness   # fetch the latest marketplace from GitHub
claude plugin update q-panel                  # then restart or /reload-plugins
claude plugin disable q-panel                 # turn off without removing (enable to turn back on)
claude plugin uninstall q-panel               # remove the plugin
claude plugin marketplace remove q-harness   # remove the marketplace
```

## Use case 2: Clone and develop (contributors)

You want to change an existing plugin or add a new one, and try it in a real session.

### 1. Clone and check

```bash
git clone git@github.com:phuquocchamp/q-harness.git   # or https://github.com/phuquocchamp/q-harness.git
cd q-harness
claude plugin validate .                              # marketplace + every plugin must pass
```

Requirements: Claude Code with plugin support (`claude plugin --help` should list `validate`, `test` and `tag`). Node is only needed for the optional type-check (`npx`).

> If you already installed `q-harness` from GitHub (use case 1), remove it first so the GitHub copy and your working copy do not both load:
> `claude plugin uninstall q-panel && claude plugin marketplace remove q-harness`

### 2. Load a plugin while you edit

Pick one of two ways. Both read the files from your working copy.

**A. Load one plugin folder directly (fastest loop).** No install, nothing to clean up:

```bash
claude --plugin-dir ./plugins/q-panel                                  # saving a file reloads the mod
claude --plugin-dir ./plugins/q-panel --plugin-dir ./plugins/<other>   # repeat the flag for several
claude --debug --plugin-dir ./plugins/q-panel                          # also logs skipped hooks / refused trees
```

**B. Add the clone as a local marketplace (tests the real install flow).** Use this to check what a user gets from use case 1:

```bash
claude plugin marketplace add ./           # adds "q-harness" from this folder
claude plugin install q-panel@q-harness     # or pick specific plugins: <plugin>@q-harness
claude plugin list                         # "Read from:" points at your clone
```

Because each marketplace entry's `source` is a relative path (`./plugins/q-panel`), Claude Code reads the plugin straight from your clone. After editing, run `/reload-plugins` in the session. No reinstall or version bump is needed.

Clean up when you are done:

```bash
claude plugin uninstall q-panel
claude plugin marketplace remove q-harness
```

### 3. Test

```bash
claude plugin validate ./plugins/q-panel      # manifest, state contract, what it hooks and calls
claude plugin test ./plugins/q-panel          # run tests/*.test.ts
npx -p typescript tsc -p plugins/q-panel      # optional type-check
```

CI (`.github/workflows/ci.yml`) runs the same validate and test steps for every plugin on each push and pull request.

Then try it by hand: start a session with way A or B, ask Claude to run a Bash command, and check the panel.

### 4. Add a new plugin

1. Create `plugins/<name>/` with `.claude-plugin/plugin.json` and its components. See [Adding a plugin](docs/guides/adding-a-plugin.md), and [Developing a mod](docs/guides/developing-a-mod.md) for a mod.
2. Register it in `.claude-plugin/marketplace.json`:

   ```json
   { "name": "<name>", "source": "./plugins/<name>", "description": "..." }
   ```

3. Run `claude plugin validate .`, load it with way A or B, and add a row to the [Plugins](#plugins) table.

### 5. Release

Bump `version` in `plugins/<name>/.claude-plugin/plugin.json`, commit, then tag and push:

```bash
claude plugin tag plugins/<name> --dry-run   # prints <name>--v<version>
claude plugin tag plugins/<name> --push
```

Users pick it up with `claude plugin marketplace update q-harness` and `claude plugin update <name>`. Details in [Marketplace and release](docs/guides/marketplace.md).

## Project structure

```
.
├── .claude-plugin/
│   └── marketplace.json          # The marketplace: lists every plugin and its folder
├── .claude/                      # Claude Code settings and rules for working on this repo
├── .github/workflows/ci.yml      # validate, plugin test for every mod, viewer and runner tests, shared UI drift check
├── shared/ui/q-theme.css         # Design tokens (source of truth); plugins ship generated copies
├── scripts/sync-ui.mjs           # Copies the tokens into each plugin (--check fails on drift)
├── plugins/                      # One folder per plugin; only these folders are shipped
│   ├── q-panel/                  # Plugin with a mod
│   │   ├── .claude-plugin/plugin.json
│   │   ├── hooks/hooks.json      # { "modules": ["./register.tsx"] } makes it a mod
│   │   ├── hooks/register.tsx    # every hook, and every helper that takes $
│   │   ├── hooks/lib/*.ts        # pure helpers (no $), imported by register.tsx
│   │   ├── types/index.d.ts
│   │   ├── tests/*.test.ts
│   │   ├── tsconfig.json
│   │   ├── LICENSE               # copy of the root LICENSE (the root file is never installed)
│   │   └── README.md
│   ├── q-graph/                  # Plugin with a mod, laid out like q-panel
│   ├── q-pilot/                  # Mod + skills/ + runner/ (Node CLI: task + live inspector, explore, replay, Jev record/heal, verify) + examples/demo-app/
│   ├── q-engine/                 # agents/ + skills/ only, no mod; LICENSE + NOTICE for adapted skills
│   └── q-advisor/                # Mod only (hooks/register.tsx + hooks/lib/)
├── docs/
│   ├── guides/                   # How-to guides (see Docs below)
│   ├── images/                   # README banner and other images
│   └── playground/               # Scratch notes
├── LICENSE                       # MIT; each plugin folder carries a copy
└── TODOS.md                      # Ideas for upcoming plugins
```

Files at the repository root (`README.md`, `docs/`, `TODOS.md`, `.claude/`) are never installed. Everything a user receives must be inside the plugin's folder. A plugin can also ship `skills/`, `agents/`, `commands/` and `.mcp.json`; see [Adding a plugin](docs/guides/adding-a-plugin.md).

## Design system

Plugins that serve a UI (the q-graph viewer, the q-pilot inspector) share one token sheet, `shared/ui/q-theme.css`: cool neutrals, one accent, light and dark (`prefers-color-scheme`, or `data-theme` on `<html>`). Every token starts with `--q-`. Because each plugin installs on its own, the sheet is copied into the plugin by `node scripts/sync-ui.mjs`; the copies are generated (do not edit them) and CI runs `node scripts/sync-ui.mjs --check` to fail on drift. Rules: kind colours (`--q-k-*`) mark graph kinds only (main, subagent, teammate, tool, skill, mcp, rule); UI chrome and "running" use `--q-accent`; success, warning and error use `--q-ok`, `--q-warn`, `--q-bad`. Terminal UI uses the host's theme keys instead. Details in [Design system](docs/guides/design-system.md).

## Docs

| Guide | Covers |
|-------|--------|
| [Adding a plugin](docs/guides/adding-a-plugin.md) | Plugin types (mod, skills, agents, commands, MCP), folder layout, registering it in the marketplace |
| [Developing a mod](docs/guides/developing-a-mod.md) | The files a mod needs, loading, type-checking, testing, debugging |
| [Marketplace and release](docs/guides/marketplace.md) | Installing from the local folder or GitHub, publishing, versioning and tagging |
| [Command cheat sheet](docs/guides/commands.md) | Every command, grouped: create, run, check, test, marketplace, install, release |
| [Design system](docs/guides/design-system.md) | The shared `--q-*` tokens, colour rules, the sync script, terminal theme keys |
| [Claude Code tools](docs/guides/claude-code-tools.md) | Built-in and MCP tools, skills, when to use each, rules of tool use, permissions |

## License

[MIT](LICENSE). Every plugin folder ships its own copy, because files at the repository root are never installed. A plugin that adapts third-party material lists it in its own `NOTICE` (see [q-engine](plugins/q-engine/NOTICE)).
