# Design system

Plugins with a web UI (the q-graph viewer and the q-pilot inspector) share one token sheet so they look alike in light and dark. The source of truth is [`shared/ui/q-theme.css`](../../shared/ui/q-theme.css).

## Sharing the sheet

A plugin installs on its own, so it cannot import from the repo root. `scripts/sync-ui.mjs` copies the sheet into each plugin, under a `GENERATED ... do not edit` header:

```bash
node scripts/sync-ui.mjs           # write the copies
node scripts/sync-ui.mjs --check   # exit 1 and list copies that drifted (CI runs this)
node --test scripts/*.test.mjs     # tests for the script
```

Targets are listed in `TARGETS` in the script. Today: `plugins/q-graph/viewer/q-theme.css` and `plugins/q-pilot/runner/inspector/q-theme.css`. A plugin's server must serve the file without a token, like its other static assets, and its page links it before its own `<style>`.

## Theme

Light is on `:root`. Dark applies under `@media (prefers-color-scheme: dark)` unless `<html data-theme="light">`, and always under `<html data-theme="dark">`. Both blocks set `color-scheme`. All tokens start with `--q-`; there is no alias layer, use the names below.

## Tokens

| Group | Tokens | Use |
|-------|--------|-----|
| Surfaces | `--q-bg` page, `--q-surface` panels and cards, `--q-sunken` wells and code, `--q-raised` popovers | Background of a layer |
| Text | `--q-fg`, `--q-fg-2`, `--q-muted`, `--q-faint` | Primary, secondary, labels, disabled or hints |
| Lines | `--q-line`, `--q-line-2`, `--q-grid` | Borders, stronger borders, canvas grid |
| Accent | `--q-accent`, `--q-accent-fg`, `--q-accent-soft`, `--q-accent-line` | Links, focus, selection, running, primary button (text on it is `-fg`) |
| Status | `--q-ok`, `--q-warn`, `--q-bad`, `--q-held` each with `-soft` (fill) and `-line` (border) | Success, needs attention, error, held (waiting on a person) |
| Kinds | `--q-k-main`, `-sub`, `-team`, `-tool`, `-skill`, `-mcp`, `-rule` | Graph kinds only |
| Type | `--q-sans`, `--q-mono`, `--q-fs-2xs` 10, `-xs` 11, `-sm` 12, `-md` 13, `-lg` 14, `-xl` 16, `-2xl` 18 px | System stacks, no web fonts |
| Shape | `--q-r-xs` 3, `-sm` 4, `-md` 6, `-lg` 9, `-pill` 999 px; `--q-shadow-1`, `--q-shadow-2`, `--q-focus` | Radii, elevation, focus ring (a `box-shadow` value) |

## Colour rules

- Kind colours identify what a node is in a graph (main, subagent, teammate, and an agent's tool, skill, MCP or rule uses). Never use them for buttons, links, focus or status.
- UI chrome is neutral plus `--q-accent`: links, focus outlines, selected and pressed states, pins, resize grips.
- Running means accent. Done is `--q-ok`, failed `--q-bad`, needs you `--q-warn`, held `--q-held`.
- Canvas code that cannot use `var()` (a minimap, a chart) reads the computed token and re-reads it when `prefers-color-scheme` changes.
- Do not restyle a third-party stylesheet in place; override it from the page's own style with `--q-*` values.

## Terminal UI

A mod's Ink output follows the host's theme, not these tokens. Use a `ThemeKey` for meaning: `'success'`, `'warning'`, `'error'` (`Color` is `ThemeKey | string`). A kind colour has no theme key, so use a mid-luminance hex that reads on light and dark terminals: main `#3969de`, subagent `#1f966f`, teammate `#a72f83`; the q-graph raster also uses tool `#8b5628`, skill `#9a55d1`, MCP `#1080a6`, rule `#3ea313`. Leave body text in the terminal's own colour.
