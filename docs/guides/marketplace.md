# Marketplace and release

This repository is a marketplace named `q-harness`. `.claude-plugin/marketplace.json` lists each plugin and the folder it lives in. For a one-page list of commands, see the [command cheat sheet](commands.md).

## Try the install flow locally

Install from your working copy, the way a user would install from GitHub:

```bash
claude plugin marketplace add ./           # adds "q-harness" from this folder
claude plugin install q-bash@q-harness        # -s user|project|local, default user
claude plugin list                         # shows "Read from:" the folder
```

Because the marketplace is a folder and each entry's `source` is a relative path (`./plugins/q-bash`), Claude Code reads the plugin straight from your working copy, not from a copy. After editing, run `/reload-plugins` in the session. No reinstall or version bump is needed.

When you are done:

```bash
claude plugin uninstall q-bash
claude plugin marketplace remove q-harness
```

## Publish

1. Push the repository to GitHub.
2. Run `claude plugin validate .` and fix any errors.
3. Put this install line in the README, with the real owner:

```text
/plugin install q-bash --marketplace <owner>/q-harness
```

Users type it at the prompt of a Claude Code terminal session, answer `y` to add the marketplace, and pick a scope. Other sources work too: a git URL or a local path.

## Release a new version

1. Bump `version` in `plugins/<name>/.claude-plugin/plugin.json`.
2. Validate and test (see [Developing a mod](developing-a-mod.md#checklist-before-a-commit)).
3. Commit, then tag the release:

```bash
claude plugin tag plugins/<name> --dry-run   # prints <name>--v<version>
claude plugin tag plugins/<name> --push      # creates and pushes the tag to origin
```

`claude plugin tag` refuses a dirty working tree, and it checks that `plugin.json` and the marketplace entry agree.

Users pick up the new version with:

```bash
claude plugin marketplace update q-harness
claude plugin update <name>               # restart or /reload-plugins to apply
```

## Manage an installed mod

| Task | Command |
|------|---------|
| See what it contains | `claude plugin details <name>` |
| Turn off / on | `claude plugin disable <name>` / `claude plugin enable <name>` |
| Remove | `claude plugin uninstall <name>` (`--keep-data` keeps its saved data) |
| Skip all mods for one session | `claude --safe-mode` |
