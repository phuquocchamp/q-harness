# Adding a plugin

This repository is a marketplace (`q-harness`). It holds any number of plugins, each in its own folder under `plugins/`. For a one-page list of commands, see the [command cheat sheet](commands.md).

## Marketplace, plugin, component

| Layer | Defined by | In this repo | Users |
|-------|-----------|--------------|-------|
| Marketplace | `.claude-plugin/marketplace.json` | The repository root | Add it once: `claude plugin marketplace add phuquocchamp/q-harness` |
| Plugin | `.claude-plugin/plugin.json` | `plugins/<name>/` | Install, enable, disable and update each one on its own |
| Component | A file or folder inside the plugin | `hooks/`, `skills/`, `agents/`, … | Receive them with the plugin |

A **mod** is not a separate layer. It is a plugin whose `hooks/hooks.json` has a `"modules"` key pointing to a TypeScript file that runs inside Claude Code.

## Components a plugin can ship

| Component | Location in the plugin | Installed as |
|-----------|-----------------------|--------------|
| Mod | `hooks/hooks.json` with `{ "modules": ["./register.tsx"] }` + `hooks/register.tsx` | Runs in every session while the plugin is enabled |
| Skill | `skills/<skill>/SKILL.md` (+ `references/`, `scripts/`) | `<plugin>:<skill>` |
| Agent | `agents/<agent>.md` | `<plugin>:<agent>` |
| Command | `commands/<cmd>.md` | `/<plugin>:<cmd>` |
| MCP server | `.mcp.json` | The server's tools |

These folder names are discovered automatically. To use other locations, declare them in `plugin.json` with paths that start with `./` (for example `"agents": ["./agents", "./more-agents"]`).

## Layout with several plugins

```
q-harness/
├── .claude-plugin/marketplace.json
└── plugins/
    ├── q-bash/                       # mod (+ optional skills/agents)
    │   ├── .claude-plugin/plugin.json
    │   ├── hooks/hooks.json · hooks/register.tsx
    │   ├── types/ · tests/ · tsconfig.json
    │   ├── skills/<skill>/SKILL.md
    │   └── agents/<agent>.md
    ├── <name>-skills/                # no code: skills and commands only
    │   ├── .claude-plugin/plugin.json
    │   ├── skills/<skill>/SKILL.md
    │   └── commands/<cmd>.md
    └── <name>-tools/                 # MCP server
        ├── .claude-plugin/plugin.json
        ├── .mcp.json
        └── server/
```

## Steps

1. Create `plugins/<name>/.claude-plugin/plugin.json`:

   ```json
   {
     "name": "<name>",
     "version": "0.1.0",
     "author": { "name": "phuquocchamp" },
     "description": "One line about what the plugin does"
   }
   ```

2. Add the components. For a mod, follow [Developing a mod](developing-a-mod.md). For a skill:

   ```markdown
   ---
   name: <skill>
   description: What it does. Use when <situation>.
   ---
   Instructions for Claude.
   ```

   For an agent (`agents/<agent>.md`):

   ```markdown
   ---
   name: <agent>
   description: What it does and when to use it.
   tools: Read, Grep
   ---
   System prompt for the agent.
   ```

3. Register the plugin in `.claude-plugin/marketplace.json`. The `name` must match `plugin.json`:

   ```json
   { "name": "<name>", "source": "./plugins/<name>", "description": "…" }
   ```

4. Add a `README.md` in the plugin folder and a row in the plugin table of the root `README.md`.

5. Check it:

   ```bash
   claude plugin validate .                    # marketplace + every plugin
   claude plugin validate ./plugins/<name>
   claude --plugin-dir ./plugins/<name>        # skills/agents are not listed by validate: load and look
   ```

## Rules

- Only what is inside `plugins/<name>/` is installed. Files at the repository root never ship.
- One plugin per feature that users should be able to turn on or off separately.
- Each plugin has its own `version`; tag a release with `claude plugin tag plugins/<name>`.
