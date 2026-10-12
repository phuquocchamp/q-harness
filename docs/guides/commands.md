# Command cheat sheet

Every command this project uses, grouped by task. Run them from the repository root. Checked against Claude Code 2.1.296 (`claude plugin --help`).

Guides with more context:
- [Adding a plugin](adding-a-plugin.md): plugin types, folder layout, marketplace entry.
- [Developing a mod](developing-a-mod.md): create, load, type-check, test and debug a mod.
- [Marketplace and release](marketplace.md): install from a local or GitHub marketplace, update, tag and remove.

## Create

| Command | What it does |
|---------|--------------|
| *(none)* | There is no scaffold command for plugins in this repo. Create `plugins/<name>/` by hand; see [Adding a plugin](adding-a-plugin.md) and [Developing a mod](developing-a-mod.md#1-create-the-folder). |
| `claude plugin init <name>` | Scaffolds a different kind of plugin (skills, agents, command hooks) in `~/.claude/skills/<name>/`. Do **not** use it for plugins in this repo. |

## Run from disk while developing

| Command | What it does |
|---------|--------------|
| `claude --plugin-dir ./plugins/q-bash` | Starts a session with the mod loaded. Saving a file reloads it. Repeat the flag to load several mods. |
| `claude --debug --plugin-dir ./plugins/q-bash` | Same, and writes every skipped hook and refused tree to the debug log. |
| `/reload-plugins` *(in a session)* | Re-reads installed plugins, including ones installed from a local folder marketplace. |
| `/plugin` *(in a session)* | Shows installed plugins and how many mods are active; enable or disable them here. |

## Check

| Command | What it does |
|---------|--------------|
| `claude plugin validate ./plugins/q-bash` | Checks one mod: manifest, state contract, and lists what it hooks and calls. |
| `claude plugin validate .` | Checks the marketplace: every entry resolves to a valid plugin. |
| `claude plugin validate . --strict` | Treats warnings as errors (exit 1). Use in CI. |
| `claude plugin validate . --json` | Prints the report as JSON. |
| `npx -p typescript tsc -p plugins/q-bash` | Type-checks the mod against the types Claude Code generated in `.claude-plugin/types/`. |

## Test

| Command | What it does |
|---------|--------------|
| `claude plugin test ./plugins/q-bash` | Runs every `*.test.ts(x)` under the mod folder. Exits 1 when a test fails. |
| `for d in plugins/*/; do [ -d "$d/tests" ] && { claude plugin test "$d" \|\| exit 1; }; done` | Runs the tests of every plugin that has a `tests/` folder. |

## Marketplace

| Command | What it does |
|---------|--------------|
| `claude plugin marketplace add ./` | Adds this repository as a marketplace named `q-harness` (from `.claude-plugin/marketplace.json`). |
| `claude plugin marketplace add <owner>/q-harness` | Adds the marketplace from GitHub. |
| `claude plugin marketplace list` | Lists configured marketplaces. |
| `claude plugin marketplace update q-harness` | Re-reads the marketplace from its source. |
| `claude plugin marketplace remove q-harness` | Removes the marketplace. |

## Install and manage

| Command | What it does |
|---------|--------------|
| `/plugin install q-bash --marketplace <owner>/q-harness` *(in a session)* | One-step install for users: adds the marketplace, then installs. |
| `claude plugin install q-bash@q-harness` | Installs from a marketplace that is already added. `-s user\|project\|local` sets the scope. |
| `claude plugin install q-bash --marketplace ./` | Adds the local marketplace and installs in one step. |
| `claude plugin list` | Lists installed plugins and where each is read from. |
| `claude plugin details q-bash` | Shows the plugin's components and projected token cost. |
| `claude plugin disable q-bash` / `enable q-bash` | Turns the mod off or on without uninstalling it. |
| `claude plugin update q-bash` | Updates to the latest version from its marketplace (restart to apply). |
| `claude plugin uninstall q-bash` | Removes the mod. `--keep-data` keeps its saved data. |

## Release

| Command | What it does |
|---------|--------------|
| `claude plugin tag plugins/q-bash --dry-run` | Shows the tag it would create (`q-bash--v0.1.0`) after checking `plugin.json` and the marketplace entry agree. |
| `claude plugin tag plugins/q-bash --push` | Creates the tag and pushes it to `origin`. |

## Turn mods off

| Command | What it does |
|---------|--------------|
| `claude --safe-mode` | Starts one session with no mods running. |
| `"disableAllHooks": true` in settings | Turns off all hooks, mods included. |
