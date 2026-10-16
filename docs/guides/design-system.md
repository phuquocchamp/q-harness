# Design system

Plugins with a web UI (the q-graph viewer and the q-pilot Dashboard) share one token sheet so they look alike in light and dark. The source of truth is [`shared/ui/q-theme.css`](../../shared/ui/q-theme.css).

## Sharing the sheet

A plugin installs on its own, so it cannot import from the repo root. `scripts/sync-ui.mjs` copies the sheet into each plugin, under a `GENERATED ... do not edit` header:

```bash
node scripts/sync-ui.mjs           # write the copies
node scripts/sync-ui.mjs --check   # exit 1 and list copies that drifted (CI runs this)
node --test scripts/*.test.mjs     # tests for the script
```

Copies are listed in `COPIES` in the script, one `{ source, target }` each. Today: `q-theme.css` into `plugins/q-graph/viewer/` and `plugins/q-pilot/runner/inspector/`, and each of those plugins' icon as `icon.svg` beside it. A plugin's server must serve these files without a token, like its other static assets, and its page links the sheet before its own `<style>`.

## Icons

Every plugin has an icon in [`docs/images/icons/`](../images/icons/) (the source of truth), with PNG exports at 1024, 512, 256 and 32 px in `png/`:

| | | | | | |
|:-:|:-:|:-:|:-:|:-:|:-:|
| <img src="../images/icons/q-harness.svg" width="64" alt=""> | <img src="../images/icons/q-pilot.svg" width="64" alt=""> | <img src="../images/icons/q-panel.svg" width="64" alt=""> | <img src="../images/icons/q-graph.svg" width="64" alt=""> | <img src="../images/icons/q-advisor.svg" width="64" alt=""> | <img src="../images/icons/q-engine.svg" width="64" alt=""> |
| `q-harness` `q_` | `q-pilot` pointer | `q-panel` panel | `q-graph` agent tree | `q-advisor` speech bubble | `q-engine` gear |

`q-pilot-window.svg` is an alternate q-pilot icon (a browser window), not used.

Rules:

- One family: a dark dotted tile (`#0E0F12`, dots and border `#2A2D35`), the amber q from the banner (`#F5A623`), and one off-white (`#ECEAE4`) glyph per plugin. Keep the q amber; change only the glyph.
- Drawn on the macOS app-icon grid: a 412 px tile, corner radius 92, inside a 512 px box. The sync copies crop the viewBox to the tile (`50 50 412 412`) so a favicon or header mark fills its box.
- A web UI uses its copy as the favicon and as the mark in its header. The q-pilot Dashboard draws the run's tone as a badge on the icon's top-right corner (`renderTab` in `inspector/app.js`), and the app window shows that favicon. Chrome's `--app` window takes its title-bar and taskbar icon from the favicon. On macOS the Dock still shows the browser's own icon.
- To add or change an icon, edit the SVG under `docs/images/icons/`, add a `COPIES` entry for a plugin that serves it, and run `node scripts/sync-ui.mjs`. Re-export the PNGs when the SVG changes.

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
| Type | `--q-sans`, `--q-mono`; `--q-fs-2xs` 10, `-xs` 11, `-sm` 12, `-md` 13, `-lg` 14, `-xl` 16, `-2xl` 18 px, `--q-fs-cap` 11; `--q-lh-tight` 1.25, `--q-lh-ui` 1.45, `--q-lh-prose` 1.55; `--q-fw-normal` 400, `-medium` 500, `-strong` 600; `--q-track-cap` .06em | System stacks, no web fonts. The theme also sets tabular digits on `body` |
| Shape | `--q-r-xs` 3, `-sm` 4, `-md` 6, `-lg` 9, `-pill` 999 px; `--q-shadow-1`, `--q-shadow-2`, `--q-focus` | Radii, elevation, focus ring (a `box-shadow` value) |

## Type rules

- Sans for prose, labels and headlines; mono only for data: ids, selectors, actions, URLs and numbers in tables. A headline is sans even when its text is an action.
- Uppercase captions (section titles, table headers, field labels over a value) use `--q-fw-strong`, `--q-fs-cap` or `--q-fs-2xs` and `--q-track-cap`. Small labels inside a tile stay sentence case.
- Live values must not move the layout: digits are tabular (from the theme), a changing number gets a `min-width` in `ch`, changing text is clamped to a fixed number of lines (`line-clamp`, full text in `title`), a list that fills in has a fixed height, and a scrolling column uses `scrollbar-gutter: stable`. A placeholder takes the same box as the content that replaces it.

## Colour rules

- Kind colours identify what a node is in a graph (main, subagent, teammate, and an agent's tool, skill, MCP or rule uses). Never use them for buttons, links, focus or status.
- UI chrome is neutral plus `--q-accent`: links, focus outlines, selected and pressed states, pins, resize grips.
- Running means accent. Done is `--q-ok`, failed `--q-bad`, needs you `--q-warn`, held `--q-held`.
- Canvas code that cannot use `var()` (a minimap, a chart) reads the computed token and re-reads it when `prefers-color-scheme` changes.
- Do not restyle a third-party stylesheet in place; override it from the page's own style with `--q-*` values.

## Terminal UI

A mod's Ink output follows the host's theme, not these tokens. Use a `ThemeKey` for meaning: `'success'`, `'warning'`, `'error'` (`Color` is `ThemeKey | string`). A kind colour has no theme key, so use a mid-luminance hex that reads on light and dark terminals: main `#3969de`, subagent `#1f966f`, teammate `#a72f83`; the q-graph raster also uses tool `#8b5628`, skill `#9a55d1`, MCP `#1080a6`, rule `#3ea313`. Leave body text in the terminal's own colour.
