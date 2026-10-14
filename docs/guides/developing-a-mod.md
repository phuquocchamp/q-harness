# Developing a mod

How to add a mod (a plugin with a hooks module) to this repository and work on it from disk. For other plugin types and the overall layout, see [Adding a plugin](adding-a-plugin.md). For a one-page list of commands, see the [command cheat sheet](commands.md).

## 1. Create the folder

There is no scaffold command for mods. (`claude plugin init` creates a different kind of plugin in `~/.claude/skills/`.) Create the files by hand:

```
plugins/<name>/
├── .claude-plugin/plugin.json   # required
├── hooks/hooks.json             # required
├── hooks/register.tsx           # required
├── types/index.d.ts             # when the mod keeps values in $.state
├── tests/<feature>.test.ts      # recommended
├── tsconfig.json                # recommended
└── README.md
```

`plugins/<name>/.claude-plugin/plugin.json`:

```json
{
  "name": "<name>",
  "version": "0.1.0",
  "author": { "name": "phuquocchamp" },
  "description": "One line about what the mod does",
  "types": "./types/index.d.ts"
}
```

Leave out `"types"` if the mod has no state.

`plugins/<name>/hooks/hooks.json` (exactly one module, relative to this file):

```json
{ "modules": ["./register.tsx"] }
```

`plugins/<name>/hooks/register.tsx`:

```tsx
import type { Register } from 'claude-code'

export const register: Register = (on, options) => {
  on('tool.call', async ($, e, next) => next(e))
}
```

`plugins/<name>/types/index.d.ts` (no imports; the key must equal the mod's `name`):

```ts
declare module 'claude-code' {
  interface PluginState {
    '<name>': {
      count: number
    }
  }
}
```

`plugins/<name>/tsconfig.json`:

```json
{ "extends": "./.claude-plugin/types/tsconfig.json" }
```

Then list the plugin in `.claude-plugin/marketplace.json` (the `name` must match `plugin.json`) and in the table in the root `README.md`:

```json
{ "name": "<name>", "source": "./plugins/<name>", "description": "…" }
```

## 2. Load it in a session

```bash
claude --plugin-dir ./plugins/<name>
```

- The session watches the folder. Saving a file reloads the module: `register` runs again and `session.start` fires again.
- Values in `$.state` (per session) and `$.store` (across sessions) survive a reload. Variables in the module do not.
- Load several mods with several flags: `claude --plugin-dir ./plugins/q-panel --plugin-dir ./plugins/<name>`.
- On the first load Claude Code writes `.claude-plugin/types/` inside the mod: the API types, the built-in tools, the connected MCP tools and a `tsconfig.json`. It is git-ignored and regenerated on every load. Do not edit it.

`CLAUDE_CODE_PLUGIN_DIRS` does the same where you cannot pass a flag (desktop app, SDK). It is read from the process environment or from `~/.claude/settings.json`, not from a project's `.claude/settings.json`.

## 3. Validate

```bash
claude plugin validate ./plugins/<name>
```

Read the output, not just the verdict:

- `hooks:` lists every event the module hooks.
- `calls:` lists every `$` method it calls.
- `state reads/writes:` must match the keys in `types/index.d.ts`.
- `gating hook` lines mark hooks that can refuse something (a tool call, a prompt); decide whether each needs a `.catch`.

## 4. Type-check

```bash
npx -p typescript tsc -p plugins/<name>
```

This needs `.claude-plugin/types/`, so load the mod once first (step 2).

## 5. Test

```bash
claude plugin test ./plugins/<name>
```

A test imports `test`, `expect` and `mock` from `claude-code/testing`. For drawing, mount a component through the mod on a named surface and act on it by key:

```ts
import { expect, test } from 'claude-code/testing'

test('draws on every surface', async $ => {
  for (const surface of ['terminal', 'desktop'] as const) {
    const ui = await $.ui.mount({ plugin: '<name>', surface, component: 'ToolUse', props: { /* … */ } })
    expect(await ui.find({ type: 'Text', text: /expected/ })).toBeDefined()
    await ui.unmount()
  }
})
```

See `plugins/q-panel/tests/bash-panel.test.ts` for a full example.

Nothing beneath the plugins answers `$.store`, `$.clock`, `$.process` or `$.ui.open` in a test. A hook that calls them is skipped with `no implementation for store.set` (or similar). Answer them in the test with `on(...)`, returning `{ value }`:

```ts
const store = new Map<string, unknown>()
on('store.get', (_$, e) => ({ value: store.get(e.key) }))
on('store.set', (_$, e) => (store.set(e.key, e.value), { value: undefined }))
on('clock.now', () => ({ value: 1_000 }))
on('process.run', () => ({ value: { exitCode: 0, stdout: '…', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }))
```

The test `$` has no `$.state`. Check state through what the mod draws, or through what it wrote to the fake store. `plugins/q-panel/tests/code-blocks.test.ts` and `plugins/q-panel/tests/settings.test.ts` show both.

## Splitting a mod across files

`hooks.json` names one module, and that module may import sibling files. The validator traces `$` and `on` statically, so:

- Every `on(...)` call stays in `register.tsx`. Passing `on` to an imported `registerX(on)` is refused.
- `$` may only be passed to functions declared in `register.tsx`. A helper in another file that takes `$` is refused (`$ is followed only into a function declared in this same file, never across an import`).
- `atom(...)` references must be created in `register.tsx` too, so the validator can read their `plugin` and `key`.
- Pure helpers (parsing, formatting, constants) can live in `hooks/lib.ts` (or `hooks/lib/*.ts`, as q-panel does) and be unit-tested directly from `tests/`.

In `types/index.d.ts`, don't name a type the same as one in the `claude-code` module. Inside `declare module 'claude-code'` the module's own type wins, silently. For example, a contract field typed `Settings` resolves to Claude Code's `Readonly<Record<string, unknown>>`. q-panel uses `PanelSettings` for this reason.

## 6. Debug

- While a session hot-reloads the mod, a failed hook or module shows as one dim line in the transcript, naming the mod, the event and the reason.
- `claude --debug --plugin-dir ./plugins/<name>` writes every skipped hook and every refused UI tree to the debug log (`ui.render (<Component>): a hook returned a tree that does not validate`).
- `claude --safe-mode` starts a session with no mods, if a mod breaks the UI.

## Ship skills, agents and commands

A mod plugin can ship skills, agents, commands and MCP servers next to its hooks. See [Adding a plugin](adding-a-plugin.md).

## Checklist before a commit

```bash
claude plugin validate .                 # marketplace + every entry
claude plugin validate ./plugins/<name>     # the mod itself
claude plugin test ./plugins/<name>
npx -p typescript tsc -p plugins/<name>
```
