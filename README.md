# q-harness

> A collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

This repository is a plugin **marketplace** named `q-harness`. Each plugin lives in its own folder under `plugins/` and is installed, enabled and versioned on its own. A plugin can ship any mix of components: a mod (TypeScript running inside Claude Code), skills, agents, commands and MCP servers.

## Plugins

| Plugin | Version | Components | Description |
|--------|---------|------------|-------------|
| [`q-bash`](plugins/q-bash/README.md) | 0.1.0 | mod | Draws each Bash call as a bordered panel with a short output preview; click to expand the full command and output. |

## Install

At the prompt of a Claude Code terminal session:

```text
/plugin install q-bash --marketplace <owner>/q-harness
```

Answer `y` to add the marketplace, then pick a scope. Replace `<owner>` with the GitHub account that hosts this repository. Once the marketplace is added, install more plugins with `claude plugin install <plugin>@q-harness`.

## Project structure

```
.
├── .claude-plugin/
│   └── marketplace.json          # The marketplace: lists every plugin and its folder
├── plugins/                      # One folder per plugin; only these folders are shipped
│   └── q-bash/                   # Plugin with a mod
│       ├── .claude-plugin/plugin.json
│       ├── hooks/hooks.json      # { "modules": ["./register.tsx"] } makes it a mod
│       ├── hooks/register.tsx
│       ├── types/index.d.ts
│       ├── tests/*.test.ts
│       ├── tsconfig.json
│       └── README.md
├── docs/
│   ├── guides/                   # How-to guides (see Docs below)
│   └── playground/               # Scratch notes
└── TODOS.md                      # Ideas for upcoming plugins
```

Files at the repository root (`README.md`, `docs/`, `TODOS.md`) are never installed. Everything a user receives must be inside the plugin's folder. A plugin can also ship `skills/`, `agents/`, `commands/` and `.mcp.json`; see [Adding a plugin](docs/guides/adding-a-plugin.md).

## Quick start for development

```bash
claude --plugin-dir ./plugins/q-bash        # run a session with the plugin loaded (hot-reloads on save)
claude plugin validate .                    # check the marketplace and every plugin in it
claude plugin validate ./plugins/q-bash     # check one plugin: manifest, contract, hooks, calls
claude plugin test ./plugins/q-bash         # run the mod's tests
```

## Docs

| Guide | Covers |
|-------|--------|
| [Adding a plugin](docs/guides/adding-a-plugin.md) | Plugin types (mod, skills, agents, commands, MCP), folder layout, registering it in the marketplace |
| [Developing a mod](docs/guides/developing-a-mod.md) | The files a mod needs, loading, type-checking, testing, debugging |
| [Marketplace and release](docs/guides/marketplace.md) | Installing from the local folder or GitHub, publishing, versioning and tagging |
| [Command cheat sheet](docs/guides/commands.md) | Every command, grouped: create, run, check, test, marketplace, install, release |
