<img src="../../docs/images/icons/q-pilot.svg" width="72" alt="" align="right">

# q-pilot

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Tell it a task, watch Jev do it.** `/q-pilot task "<what to do>"` runs any browser task like [jev-ultrafast](https://github.com/browser-use/jev-ultrafast): Claude writes the task, Jev (TypeSafe) picks every click and field, Playwright executes it, and the q-pilot Dashboard shows each decision live, with Pause, Choose next, Execute and Take control (see [Browser tasks](#browser-tasks)).

**Does the app still work for a user, and who decides?** You type a prompt such as `/q-pilot test "buy coffee beans and check the total"`. Claude reads the code and writes a small test spec: a start route, a goal, fixtures and checks. Jev (TypeSafe) drives the browser, choosing every step. Code then grades the checks. The verdict never comes from Jev. Claude also calls the test itself (`pilot_test`) after it builds or changes UI, so "it works" comes with a run behind it.

A passing test can be saved as a flow plus a recorded trace. Saved flows replay with no model call, heal a drifted step with one Jev request, and run as a stop gate when a turn changes UI files.

**Version** 0.10.2 · **Author** phuquocchamp · Design reports (artifacts): [flows and replay](https://claude.ai/artifact/4xGkHn6HugVUsyJcEQtyYS), [prompt mode](https://claude.ai/artifact/5UZPbG3UKDTQqRrUmEfnC4)

## What it ships

| Component | What it is |
|-----------|------------|
| **Task mode**: `/q-pilot task "<prompt>"`, tools `mcp__q-pilot__pilot_run` and `mcp__q-pilot__pilot_help` | Any browser task from a prompt. Claude writes the task, Jev drives, checks are optional. Where Jev is stuck, the run asks Claude (`pilot_help`) with the browser still open. |
| **q-pilot Dashboard** (`runner/dash-server.mjs`, `runner/inspector/`) | One loopback dashboard per project: a session for each task, test, gate run and flow run, the runs of one prompt under one entry (Chromium, Chrome over CDP or Electron), a live view with Take control, the numbered targets, Jev's probabilities, the decision trail, Pause / Choose next / Execute / Stop, and the history of `.q-pilot/runs/` |
| **Prompt mode**: `/q-pilot test "<prompt>"`, tool `mcp__q-pilot__pilot_test` | Claude writes a spec, Jev drives, code grades. No flow file needed. |
| **Mod** (`hooks/register.tsx`) | `/q-pilot`, the tools, the stop gate for saved flows (classic `Stop`, with a `turn.complete` fallback), the impact map, a band above the prompt while a run is red or drifted, and the status line |
| **Runner** (`runner/pilot.mjs`) | Plain Node ESM CLI (Node 18+): `task`, `explore`, `save`, `run`, `record`, `accept`, `export`, `list`. It drives Chromium through Playwright (the project's own, else a global install), takes a DOM snapshot, calls Jev and evaluates the checks. |
| **Evidence tool** `mcp__q-pilot__pilot_status` | The last run per flow, and the last prompt-mode run: outcome, time and `jevCalls`. The skill tells Claude to call it before saying UI tests pass. |
| **Skill** `flows` | Rules for Claude: when to call `pilot_test`, how to write a spec, never change checks after a run, what each outcome means |
| **Export** (`runner/export.mjs`) | Turns a flow and its trace into a Playwright test file |

## Install

```text
/plugin install q-pilot --marketplace phuquocchamp/q-harness
```

q-pilot ships no browser of its own. It uses the first Playwright it finds, in this order:

1. the project's own `playwright` or `@playwright/test` (exported specs then run with the same version);
2. the folder in `Q_PILOT_PLAYWRIGHT` (set in your shell): the package, its `node_modules`, or the folder above;
3. a global install: npm's prefix (`NPM_CONFIG_PREFIX`), the prefix of the node that runs the runner (for a Homebrew node, the prefix above its `Cellar`), `NODE_PATH`, `~/.npm-global`, and every nvm version (`~/.nvm/versions/node/*`, newest first). So `npm install -g` from an nvm shell works even when q-pilot runs on a Homebrew node.

So one global install serves every project, also repos with no `package.json`:

```bash
npm install -g playwright && npx playwright install chromium
```

When none is found, the run fails with one error that lists every folder it looked in. Each result says which one it used (`"playwright": { "from": "project" | "env" | "global", "version" }`). Prompt mode needs no config file: the spec carries its `baseURL`. Saved flows use `q-pilot.config.json` (`/q-pilot init` writes it, together with `flows/example.flow.json`, and never overwrites an existing file). Add `.q-pilot/runs/` and `.q-pilot/settings.local.json` to `.gitignore`; commit `.q-pilot/traces/` and `.q-pilot/settings.json`.

Jev needs a TypeSafe API key. Set it once for every project: the `jevApiKey` option in `/plugin` (stored as a sensitive value), or `TYPESAFE_API_KEY` exported in your shell profile. The option wins when both are set. Never put the key in `q-pilot.config.json`: that file is committed. Without a key, prompt mode ends as `blocked`, and replay of saved traces still works.

## Browser tasks

Task mode is q-pilot's version of [jev-ultrafast](https://github.com/browser-use/jev-ultrafast): you give a task in plain words and Jev does it in a real browser, while you watch every decision in the [q-pilot Dashboard](#q-pilot-dashboard).

```text
/q-pilot task "find one-way flights from Zurich to London on 20 September for one adult; stop when results show, do not book"
```

The path of one task:

```text
you ─ prompt ─▶ Claude ─ pilot_run(task) ─▶ q-pilot mod ─ node runner/pilot.mjs task ─▶ runner
                                                                                         │
             ┌───────────────────────── one loop per step ───────────────────────────────┤
             │ snapshot: numbered elements ─▶ Jev: operation + target (+ fixture key)    │
             │ ─▶ Playwright executes on the observed node ─▶ settle ─▶ next snapshot    │
             └──────────────────────── until DONE, BLOCKED or the budget ────────────────┤
                     │ every observation and decision                     │ final page   │ stuck
                     ▼                                                    ▼              ▼
             q-pilot Dashboard (127.0.0.1:8767)       checks graded by code   help request ─▶ Claude
                                                       (optional)              (pilot_help) ─▶ resume / done / stop
```

Claude turns the request into a task: where it starts, a goal that says when to stop and what not to do, and **fixtures** for every value Jev must type (search terms, places, dates, emails). Jev only sees fixture key names and picks which one goes into a field, so a task without fixtures can click but cannot type. Claude then calls `pilot_run`. Where the site has a URL that already holds the search (Google Flights `?q=Flights from SGN to DAD on 2026-10-20 one way`), Claude starts there: no form, no autocomplete, no date picker. You can also ask in your own words ("open arXiv and find the latest paper on browser agents"); the skill tells Claude to use `pilot_run` for browser tasks, once per prompt: several searches go into one goal, and a stuck run is answered with `pilot_help`, not restarted.

| Field | Meaning |
|-------|---------|
| `url` | Full `http`/`https` URL where the task starts. Omit it to start on the configured app (`baseURL` from `q-pilot.config.json` plus `start`). |
| `goal` | The whole task in plain words, with a stop condition and what not to do |
| `fixtures` | Values Jev may type: a literal, or `"$env:E2E_NAME"` for a secret |
| `checks` | Optional, the same closed set as `pilot_test`. With checks, the run is graded like a test. Write the stop condition as a strong check (text only the finished page shows): the run then ends as soon as it is reached. |
| `name`, `softChecks`, `budget` | As for a test; `budget` defaults to 40 steps and 180 seconds |

| Outcome | When |
|---------|------|
| `done` | The task had no checks and the run ended on DONE. With `doneBy: "claude"` Claude confirmed it on the page; otherwise nothing was verified, and the result says so. |
| `pass` / `fail` | Jev said DONE and every check is green / a check is red. A task with at least one strong check (`text`, `contains` or `value`) also passes as soon as its checks are green on two looks 300 ms apart after a step, without waiting for DONE (`doneBy: "checks"`); a spec of only `url`/`title`/`visible` checks still waits for DONE. |
| `blocked` | Jev said BLOCKED and Claude could not help, a loop or a bot wall stopped it, the budget ran out, a step failed, Jev is unavailable, Claude answered `stop`, or you pressed Stop |
| `env`, `error` | As for a test |

A task with checks that passes can be saved with `/q-pilot flows save`, like a test. A `done` task cannot: nothing showed that it worked.

#### When Jev is stuck: help requests

After each action the runner waits for what the action started: a page load, or (at most 3 s) the XHR/fetch requests it sent, so content that arrives by script (Google Flights' date grid shows `0000` placeholders until its prices load) is on the page Jev sees next. A WAIT also waits for data requests already in flight. Background traffic that was running before the action does not hold a step.

Jev is fast (about 0.3 s a step) but has no memory of the goal beyond its last ten actions and no idea whether a value it typed was committed. On real sites that showed as loops and false endings (22 runs on Traveloka, Vietnam Airlines, Google and YouTube, 1 real pass). So `pilot_run` does not end there: it hands the run to Claude while the browser stays open.

| Reason | When |
|--------|------|
| `loop` | The same 2 to 5 actions ran twice in a row, even when each one changed the page (Traveloka: type the destination, search, go back, 20 times) |
| `stuck` | 3 actions, or 10 waits and scrolls, without a page change; or Jev keeps typing one fixture into the same field |
| `jev_blocked` | Jev chose BLOCKED |
| `low_confidence` | 3 decisions in a row below p 0.25 |
| `human_needed` | A bot wall covers the page: a CAPTCHA iframe (DataDome, Cloudflare, hCaptcha, reCAPTCHA challenge, Arkose), an in-page CAPTCHA (AWS WAF's `awswaf-captcha` on Traveloka), or a challenge page. Claude asks you to solve it in the run's window. |
| `checks_red` | Jev chose DONE but a check of the task is red (a search with the wrong date): Claude can still fix it while the browser is open. With no helper request left, the first such DONE is refused instead: DONE is not offered for 3 steps (or until the checks turn green), so Jev can finish the form (arXiv: the sort picked, "Go" not clicked). If the run then ends any other way than a stop, it still ends as that DONE, so a real bug still grades `fail`. |
| `confirm_done` | Jev chose DONE and the task has no checks: Claude checks the page before it stands |
| `budget` | The step budget is spent |

`pilot_run` then answers `needs_help` with the reason, a screenshot path, the numbered elements and the page text (marked untrusted). Claude answers with `pilot_help`: up to 8 actions on those elements (`click`, `fill` with text or a fixture key, `select`, `press` Enter/Escape/Tab/arrows, `scroll`, `wait`), then `observe` (look again), `resume` (Jev goes on with fresh loop counters), `done` or `stop`. A run asks at most 6 times. Each request waits 4 minutes for an answer (10 for a bot wall, which a person solves); that time does not count against the task's budget. The inspector shows "Asking Claude" while it waits, and marks Claude's actions in the trail.

The runner does this with `task --help`: it writes `help-<n>.json` (and `help-<n>.png`) into the run folder, prints `[q-pilot] help {...}` on stderr, and reads `help-<n>.answer.json`. Without `--help` (the stop gate, `pilot_test`), a loop ends the run as `blocked: loop: ...` and a bot wall as `blocked: bot wall (...)`.

#### The helper model

Before a help request reaches your chat, the **helper model** answers it: a Claude model you pick with `/q-pilot config helper haiku|sonnet|opus` (default `haiku`). It gets the same request Claude would (the whole goal, up to 2000 characters, the reason, the numbered elements, the page text marked untrusted) and answers with actions on those elements, then `resume` or `observe`. The run goes on with no round trip through the session. So a stuck run climbs this ladder:

```text
Jev (text) ─▶ Jev with the screenshot (vision) ─▶ Box rescue (box on) ─▶ helper model ─▶ your Claude session
```

The helper hands the request to the session when:

- the reason is `human_needed` (a person solves a bot wall) or `confirm_done` (only the session confirms that the goal is met);
- it answers anything but `resume` or `observe`, or no valid JSON, or it fails or times out (45 s);
- it tries to type free text (it may only fill fixtures);
- Jev comes back stuck for the same reason the helper's last answer was meant to fix;
- it has already answered 3 requests of this run.

The session's request then starts with what the helper did (`The haiku helper answered 2 help request(s) of this run (...)`), and the result counts them (`3 help request(s) to Claude (2 answered by the haiku helper)`). With `helper session`, every request goes to the session as before 0.8. The helper never confirms DONE and never buys, books, sends or deletes. It goes through Claude Code's own model client, so it uses your Claude Code account.

#### Jev vision (preview)

Jev 1.13 and 1.14 accept images as a TypeSafe preview ("Dreamer-ready", turned on per request with the `TypeSafe-Danger-Zone-Images: true` header; see [docs.typesafe.ai/images](https://docs.typesafe.ai/images)). q-pilot uses it in three ways, each set with `/q-pilot config` and changeable in the inspector while the run goes:

| Setting | What happens |
|---------|--------------|
| `vision: off` | Jev decides from the element list and page text only (about 0.3 s a step) |
| `vision: gated` (default) | Jev answers from text first; when it is unsure (operation p below 0.6, the top two targets within 0.25, or DONE/BLOCKED) it is asked again with the screenshot, and that answer is used (about +0.4 s on those steps). An unsure BLOCKED (p below 0.6) from the screenshot does not overrule an action the text answer chose (with `always`, the text answer is asked for then); the decision is marked `vision.overruled: "BLOCKED"`. |
| `vision: always` | The screenshot goes with every decision |
| `visionModel` | `jev-1.13.0` (jev-latest) or `jev-1.14.0` (preview) answers with the image |
| `box: on` | **Box rescue**: where Jev is stuck (loop, no progress, BLOCKED, low confidence), Jev 1.14 locates on the screenshot the control that advances the goal (a Box question plus a "visible at all?" Noul, since Box never answers "not found") and the run clicks its centre, before asking the helper model. At most 3 per run, and only above Box confidence 0.5 and visibility 0.6. The step is recorded as `click_at`. |

The screenshot is the viewport in CSS pixels as JPEG, cut to Jev's size limits (256 to 1568 px a side). A run that types a `$env:` secret never sends a screenshot, whatever the setting. Screenshots go to TypeSafe.

Measured on 15/10/2026 with the run's own screenshots: Traveloka's airport suggestion (a role-less div) went from p 0.34 to 0.90 with the image; YouTube's channel search versus the site search from 0.54 to 0.86 (1.14). The YouTube channel task that failed four times passed with Jev alone (gated, 1.14): 11 decisions, the image on 8 of them (about 0.38 s each), 17 s, no help request.

#### What Jev sees, and when

- **First decision on a loaded page.** Like jev-ultrafast, which waits for `readyState` "complete", the run waits for the load event and then until the number of controls stops changing (up to 3 s). Without this, Jev decided on YouTube's half-hydrated shell, where the only control was the search box.
- **A page with no controls is observed again** for up to 10 s (within the task's time budget) before Jev is asked: a booking engine's results app can stay empty for seconds after a search, and Jev can only answer WAIT or BLOCKED there.
- **Element state.** Each element and target carries `checked`, `selected`, `expanded` (as in jev-ultrafast) plus `pressed` and `current`. A segmented control styled only by a class such as `_active_x9` or `is-selected` (Vietnam Airlines' one-way/round-trip switch has no ARIA state) is reported as `selected`.
- **`scope`**: the name of the nearest named form, dialog, landmark or list, so two controls called "Search" can be told apart.
- **`holds_fixture`**: the key of the fixture a field already holds. Code compares the value; Jev gets the key only.
- **`recent_actions`** carry `kind`, `page_changed` and, as in jev-ultrafast, the `text` typed (`[secret]` for a `$env:` fixture), so Jev sees which of its actions did nothing and can match what it typed to a suggestion.
- **"Open" clicks.** Like jev-ultrafast, every editable field is also offered as a click ("Open Departure"): that is how a date or place field that opens a picker on click is reached.
- **Typing.** A field is clicked, its text selected and replaced key by key (a single `fill()` input event left Traveloka's airport list unfiltered). Then the run waits until an element near the field shows the typed text (a suggestion list made of plain divs counts, not only `role=option`), up to 1.5 s; a field nothing reacts to returns after 0.3 s. PRESS_ENTER is only offered when no suggestion came up.
- **After a click** the run waits up to 0.6 s for the page to change, so a picker that opens a moment later is in the next observation.
- **Consent banners** are closed before the first decision (refuse when the banner offers it, else accept), in any frame.
- **The fixture for a field** is asked in a second request once the field is chosen, when there are several fixtures (one request answered "to" for the origin box before).
- **DONE and BLOCKED** stand only on the page they were decided for: when the page changed since (results arriving), Jev is asked again (twice at most).
- **Jev transport**: 15 s timeout; 429, 503, 529 and dropped connections are retried twice with backoff.

The next-action rules are jev-ultrafast's, plus lines q-pilot adds (a link to the needed control, cookie dialogs, scrolling before BLOCKED, replacing prefilled values, picking the autocomplete suggestion after typing, `holds_fixture`, `page_changed`, PRESS_ENTER only when no suggestion is listed, ESCAPE for a list or popup in the way). The CLICK operation says, as in jev-ultrafast, that it covers autocomplete suggestions and calendar days.

**Bot walls.** Travel sites guard their results: Traveloka shows an AWS WAF CAPTCHA and Vietnam Airlines' booking engine a Cloudflare challenge to an automated Chromium, whoever drives it. q-pilot detects the wall and stops for a person instead of clicking around it. To get past it more often, attach your own Chrome (`/q-pilot config cdpUrl ...`) so the run uses your real profile.

### q-pilot Dashboard

One dashboard per project, shared by every kind of run. The mod starts it (`runner/dash-server.mjs`) the first time a run needs it, and it lives as long as the Claude session. It listens on `http://127.0.0.1:8767/` (a free port when that one is taken). The URL is toasted once per session, and `/q-pilot dashboard` starts the Dashboard if no run has happened yet and opens it in your browser (`node runner/dash-server.mjs --root . --open` does the same from a shell; `--port 0` picks a free port). It opens as its own **app window**, like the Playwright Dashboard: no tabs or address bar, its own browser profile, separate from the browser under test. There is one window per project, and later runs reuse it instead of opening another. The window uses Chrome, Edge, Chromium or Brave started with `--app`; if none is installed it uses Playwright's Chromium, and if that is missing too, a tab in your default browser (through the system's `open`, `xdg-open` on Linux, `start` on Windows). `/q-pilot config set dashboardWindow tab` always uses a tab in your default browser instead (`app` is the default). The window and the tab show the q-pilot icon, with a badge in the run's colour: grey idle, blue running, amber paused or warning, purple held, orange while you have control, green passed, red failed. With the `inspector` setting `on` (the default) a `pilot_run` also brings its session up there by itself; `pilot_test`, the stop gate and `/q-pilot run|record` register their sessions without opening anything. The browser under test stays apart: the Chromium q-pilot launches, your Chrome when `cdpUrl` is set, or an Electron app.

**Sessions.** Each run is a session in the left column, with the kind of what started it and the target it drives:

| Kind | Started by | Controls |
|------|------------|----------|
| `task` | `pilot_run`, `/q-pilot task` | Pause, Choose next, Execute, Stop, Take control |
| `test` | `pilot_test`, `/q-pilot test` | The same |
| `gate` | the stop gate | Review only: the gate replays flows without a model and is never held |
| `flow` | `/q-pilot run`, `/q-pilot record` | Review only |

The target chip tells Chromium (launched), Chrome (CDP attach) and Electron apart. The stop gate's red band links to its first red flow (`· http://127.0.0.1:8767/#s=<runId>:<flow>`), and `#s=<runId>:<flow>` selects any session; the gate never opens a tab itself.

**One entry per prompt.** The runs that `pilot_run` and `pilot_test` start while answering one prompt (your own, or a `/q-pilot task|test`) share a prompt group: the mod mints an id on every prompt and passes it as `--prompt-group`, and the runner keeps it in the session and in `<flow>.session.json`. The left column shows such runs as one entry: the newest run's name, the number of runs, and the most urgent status of them (live, held, failed, then the rest). Click it to open or close the list below; selecting a session opens its group. A single run, a gate or flow run, and runs made before prompt groups stay entries of their own. Claude is also told to make one `pilot_run` per prompt (several searches in one goal, `pilot_help` instead of a new run), so most prompts give one session.

**Live view and Take control.** For a live `task` or `test` session the page shows the browser as it is now (a screencast, a snapshot per observation when the screencast is not available), not only the frame Jev saw. While the run is paused or held, **Take control** lets you click, scroll and type in that view: the runner performs each input with Playwright, so it is in the trace, and your typed text is never stored, only its length. When you release control, a decision made before your input is dropped and Jev looks again. A session that types a `$env:` secret has no screenshots and no live view, and no control.

**History.** The Dashboard rebuilds the list of past runs from `.q-pilot/runs/` when it starts (the 200 newest, more on request), so a run that has ended is reviewable: its trail, outcome and checks, the screenshot, the Playwright trace and `decisions.json`. Runs from before 0.10.0 have no per-step frames, only what `result.json` and `decisions.json` hold. A session keeps its frames in memory (the 20 newest ended ones) until the Dashboard stops; after a restart, a past run's trail comes back from its `<flow>.session.json`, without screenshots.

A session shows:

- the page as Jev saw it, with the numbered targets drawn on it;
- Jev's operation probabilities (CLICK, TYPE_TEXT, SELECT, PRESS_ENTER, ESCAPE, WAIT, DONE, BLOCKED) and the indexed elements ranked by the target head;
- the decision trail: each executed action (Jev's, Claude's from help requests, and yours from Take control), the model that chose it (Jev with its model id, Jev vision when it saw the screenshot, Box rescue, or Claude with the helper model), its confidence and latency, whether the page changed, and the DONE or BLOCKED that ended the run;
- the outcome and each check when the run ends;
- **Jev vision**: Off / When unsure / Every step, the vision model, and Box rescue, switched during the run (from the next decision on; off and locked for a run with a secret). A decision that saw the screenshot is marked 👁 in the trail and shows its p before and after; a Box is drawn on the frame. Each of the three settings carries a chip with the scope it came from (`user`, `project`, `local`, `env`, `default`), or "changed for this run" once you switched it here (a switch lasts for the run only). **Save as default** writes the three settings to the scope you pick (user by default) so later runs start with them: neither the runner nor the Dashboard writes a settings file, they hand the request to the mod, which applies it like `/q-pilot config set … --scope …` (same checks; a toast says `saved vision=gated to project (.q-pilot/settings.json)` and the panel shows the result). A higher scope can still override what you saved. It also works for a session that has ended;
- **review**: click any row of the trail (or use ← →) to see that step again as it was recorded: the screenshot with its numbered targets, the elements and Jev's probabilities. **L** goes back to the live page. Help requests are marked on their step.

The right panel keeps its layout while a run updates it: each block has a fixed size (the headline two lines, the goal three, the operation bars six rows with the rest folded into "+N more", the targets table a fixed height), so only the values change. Checks, which arrive when the run ends, sit below the session settings. It has no **Ask Claude** box for now (the Dashboard's `/api/ask` endpoint stays). The model that answers Jev's help requests is the `helper` setting, on the Settings page.

When a session ends, its banner offers **Open Playwright trace** (Playwright's own trace viewer, in its own window), **Download trace.zip** and **Download decisions.json**. The tab's title and icon follow the selected session (blue running, amber paused, violet waiting on you or Claude, green passed, red failed). The Dashboard uses the shared q-harness theme (`shared/ui/q-theme.css`, light and dark by `prefers-color-scheme`).

| Control | What it does |
|---------|--------------|
| **Pause** | Holds the loop before the next Jev request |
| **Choose next** | While paused: asks Jev for one decision and shows it without running it |
| **Execute choice** | Runs the shown decision. If the page changed while it was held, the decision is dropped and Jev is asked again. |
| **Run automatically** | Goes on without holding |
| **Take control** | Pauses and lets you drive the live view (see above) |
| **Stop** | Ends the run as `blocked` ("stopped from the dashboard") |

Set `/q-pilot config inspector pause` to hold a task before its first step, or `off` for no Dashboard (nothing is started and the runners get no dashboard file). Paused time counts against the task's budget (`maxTaskSeconds`), so a long pause ends the run as `blocked`. In a headless run (`Q_PILOT_HEADLESS=1`, CI) nothing opens: open the URL from the toast yourself.

**Settings page.** The header's **Settings** button opens a page with the theme (System, Light or Dark, remembered in the browser) and the q-pilot settings as a grid of cards (two columns on a wide window, one on a narrow one). Each setting has a short name with its key beside it, a one-line help and a control (a segmented control for a few choices, an input otherwise); where a value came from shows as small text ("from user") only when it is not the default. Pick one scope for the whole page with **Save to** (Project, Local or User; personal settings (`cdpUrl`, `node` and `trust`) always go to User). A change is not written at once: the changed rows are marked and a bar at the bottom counts them, with **Save** and **Discard**. Saving sends one `/q-pilot config set` per changed row; a small **Reset** link on a row removes its value from the chosen scope. Less-used settings (`visionModel`, `box`, `dashboard`, `dashboardWindow`, `cdpUrl`, `node`, `trust`, `followUp` and the time budgets) sit under **Advanced**, collapsed. The page asks the mod, which writes through the same path and the same checks as `/q-pilot config set|unset`, and a message confirms it. Settings are read again for every run, so a change applies from the next `pilot_run`, `pilot_test`, gate or flow run without a restart (`dashboardWindow` applies the next time the window opens). A value set in a higher scope (`env`, `cli`, or `local` over `project`) still wins until it is removed, and the row says so. The page works only when Claude Code started the Dashboard (`/q-pilot dashboard`); a run from a shell shows why it cannot change settings. Grid, History and Settings hide the session details panel and use its width. A running session's own vision switches stay in that panel (**Session vision settings** jumps there).

**Security.** The Dashboard listens on 127.0.0.1 only, checks the `Host` header, refuses a POST from another origin, and keeps two tokens apart: the page token (injected into the page it serves; the API for your browser) and a runner token (in `.q-pilot/dashboard/server.json`, mode 0600; the API the runners use). Neither token opens the other's API. It gets the same redacted data Jev gets. `.q-pilot/dashboard/` ignores itself with a `.gitignore`, but your own `.gitignore` should cover `.q-pilot/runs/` as before.

**Lifetime and fallback.** The Dashboard is a child of the mod: it ends with the Claude session, and after 15 minutes with no live run and no open tab. An open tab then shows "dashboard restarted, reload" the next time. Two Claude sessions in one project share the first one's Dashboard, and then Save goes through that session. A run never fails or waits because of the Dashboard: if it cannot start (a toast says so once), or goes away mid-run, runs go on without it, and a `pilot_run` falls back to its own single-run inspector.

**Not verified yet.** The live view on an Electron renderer (`Page.startScreencast` over `connectOverCDP`), and the Playwright Dashboard's `bind()` on a CDP-attached browser, have not been tried on a real app. If the screencast does not start, the view falls back to a snapshot per observation and says so.

From a shell, without Claude:

```bash
node runner/pilot.mjs task --root . --inspect \
  --spec-json '{"url":"https://en.wikipedia.org/wiki/Main_Page","goal":"Open the article about Gödel'"'"'s incompleteness theorems. Stop when it is open.","fixtures":{"query":"Gödel incompleteness theorems"}}'
```

## Prompt mode

### Quick start

[examples/demo-app](examples/demo-app) is a two-page static shop. Copy it out of the plugin folder, install Playwright there, and start Claude Code in the copy.

```bash
cp -r plugins/q-pilot/examples/demo-app /tmp/demo && cd /tmp/demo
npm install && npx playwright install chromium
export TYPESAFE_API_KEY=...
claude --plugin-dir /path/to/q-harness/plugins/q-pilot
```

Then type:

```text
/q-pilot test "buy one bag of coffee beans and confirm the order total and confirmation"
```

Claude reads `src/`, writes a spec like the one below, calls `pilot_test` once, and reports the result as it came back: outcome, each check with its actual value, and the path of a screenshot of the final page. When the test passes, `/q-pilot flows save` keeps it as a flow plus trace (see [Saved tests](#saved-tests-flows-and-replay)).

You do not have to type the command. After Claude builds or changes UI, the skill tells it to write a spec and call `pilot_test` before it says the UI works.

### Three roles

| Role | Does | Never does |
|------|------|------------|
| **Claude** | Reads the code, writes the spec (start route, goal, fixtures, checks) before the run, and reads the evidence after it | Change the checks after the run to make it pass |
| **Jev** | Chooses every action: which element to click, what to type, when to stop | Decide pass or fail |
| **Code** | Evaluates every check against the real page and sets the outcome | Guess, or ask a model |

Jev's `DONE` only ends the loop. jev-ultrafast's own README says it plainly: "A DONE choice still requires independent outcome verification." A model that says it is done can be wrong, and the demo shows how: in the design PoC a checkout page showed €120 where the spec expected €12, Jev said DONE, and the run was reported as `fail` because the `total` check was red.

### The spec

```json
{
  "name": "checkout-coffee",
  "baseURL": "http://localhost:4321",
  "start": "/",
  "goal": "Buy one bag of coffee beans and place the order with the email from the fixtures. Stop when an order confirmation is shown.",
  "fixtures": { "email": "buyer@example.test", "password": "$env:E2E_PASSWORD" },
  "checks": [ { "testid": "total", "text": "€12.00" }, { "role": "status", "text": "Order confirmed" } ],
  "softChecks": ["Does the page show that the order was placed?"],
  "budget": { "steps": 20, "seconds": 60 }
}
```

| Field | Meaning |
|-------|---------|
| `name` | Optional, `[a-z0-9-]+`, default `explore`. Names the run's files and is the default flow id on save. |
| `baseURL` | Optional; falls back to `q-pilot.config.json`. Any URL works by default, a site on the internet included. With `Q_PILOT_ALLOW_REMOTE=0` in your shell it must be loopback. If the config has a `server`, it is started as usual. |
| `start` | Path where the test begins. Claude takes it from the code (the route that renders the feature). |
| `goal` | What a user wants to do, in plain words, with a stop condition ("Stop when an order confirmation is shown") |
| `fixtures` | Values Jev may type: a literal, or `"$env:NAME"` with `NAME` starting `E2E_` or `Q_PILOT_`. Jev sees key names only; values are redacted everywhere. |
| `checks` | Required, at least one. The same closed set as a flow's `verify` (see [verify checks](#verify-checks)). |
| `softChecks` | Optional, at most 5 yes/no questions about the final page |
| `budget` | `steps` (default 20) and `seconds` (default 60) |

**Soft checks** are one extra Jev request after the loop, one question each. Each answer is reported as `{ question, p }` and labelled model judgement. They never change the outcome.

**`weak-checks` warning.** A spec whose checks are all `url`, `title` or a bare `visible` still runs, but the result carries the warning `weak-checks`: a page can have the right URL and still show a wrong total. Check business values (totals, statuses, saved data).

### Outcomes

The loop runs until Jev says DONE or BLOCKED, or the budget ends. Then code always runs the checks (also after BLOCKED, so you see the state), then the soft checks. There is no re-run.

| Outcome | When |
|---------|------|
| `pass` | Jev said DONE and every check is green |
| `fail` | Jev said DONE and a check is red. The result lists each failed check with what was found (`null` when the element is missing). |
| `blocked` | Jev said BLOCKED, or the budget ran out, a step failed, or Jev is unavailable. Check results are still reported. |
| `env` | `start` unreachable, the server did not start, a `$env:` fixture is missing, or the page landed on `loginPath` |
| `error` | The spec is invalid (for example no checks, an unknown check key, a bad fixture name) |

Every run writes `.q-pilot/runs/<runId>/` with a screenshot of the final page (always, with numbered element overlay). A `pass` also writes a proposed trace and flow.

### Save a passing test

`/q-pilot flows save [<runId>|last] [<name>]` copies a passing run's proposed flow to `<flowsDir>/<name>.flow.json` and its trace to `.q-pilot/traces/<name>.json`. It refuses when the flow file already exists, when the run has no proposal (only `pass` runs have one) or when the name is invalid. If there is no `q-pilot.config.json`, it creates one with the spec's `baseURL`. The stop gate then replays the flow.

Commit the flow and the trace. The prompt-mode run itself is not run by the stop gate.

### Numbers (measured in the PoC)

From the prompt-mode design PoC. They were not re-measured for this README.

| Case | Result | Jev calls | Time |
|------|--------|-----------|------|
| Demo app checkout | `pass` | 4 | 1.7 s |
| Demo app with a wrong total (€120) | `fail`, although Jev said DONE | n/a | n/a |
| arXiv `/search/` | `pass` | 3 | 3.4 s |
| arXiv search from the home page | `blocked` (an overlay covers the search control) | n/a | n/a |

And from the earlier flows PoC, for saved flows: green replay 0.32 s with 0 Jev calls, a drifted step healed in 0.77 s with 1 call, and today's Playwright spec on the same drift 31.7 s.

## Saved tests: flows and replay

A flow is a goal, fixtures and a `verify` block. Jev records the path once into a trace. Later runs replay the trace with no model. When one step no longer matches, Jev re-picks that step only (a heal). Pass or fail always comes from `verify`, evaluated by code. You can write a flow by hand, or get one from `/q-pilot save`. When a turn that changed UI files ends, the [gate](#the-gate) replays the flows that change affects.

### The flow file

`<flowsDir>/<id>.flow.json`, written by a person. `id` equals the file name stem (`[a-z0-9-]+`).

```json
{
  "id": "checkout-coffee",
  "start": "/",
  "goal": "Buy one bag of coffee beans and place the order using the email from the fixtures.",
  "fixtures": { "email": "buyer@example.test", "password": "$env:E2E_PASSWORD" },
  "verify": [
    { "url": "/checkout\\.html\\?item=coffee$" },
    { "testid": "total", "text": "€12.00" },
    { "role": "status", "text": "Order confirmed" }
  ],
  "covers": ["src/checkout.html", "src/index.html"],
  "tags": ["smoke"],
  "budget": { "steps": 20, "seconds": 20 }
}
```

| Field | Meaning |
|-------|---------|
| `start` | Path where the flow begins |
| `goal` | What a user wants to do, in plain words. Jev reads it. |
| `fixtures` | Values the flow may type. A string, or `"$env:NAME"`, read from the runner's environment at run time. `NAME` must start with `E2E_` or `Q_PILOT_` (`TYPESAFE_API_KEY` never), or the flow is invalid (`error`): a cloned repo must not read arbitrary secrets from your environment. A missing variable gives outcome `env`. |
| `verify` | The checks that decide pass or fail (below) |
| `covers` | Globs of source files whose change selects this flow |
| `tags` | `smoke` flows run when UI code changed and nothing matched |
| `budget` | `steps` (default 20) and `seconds` (default 20) |

#### verify checks

Every check has exactly one target and at most one expectation. An unknown key makes the flow invalid (outcome `error`). Each check polls for up to 2 s. A failed check reports what it found (`null` when the element is missing). Checks are strict, like Playwright's `expect`: a target that matches several elements fails with `ambiguous: N elements match` instead of grading the first one. Add a `name` or use a `testid`.

| Target | Meaning |
|--------|---------|
| `url` | Regex source, tested against `pathname + search` |
| `title` | Exact document title |
| `role` (+ `name`) | `getByRole(role, { name, exact: true })` |
| `testid` | `getByTestId` |
| `label` | `getByLabel(label, { exact: true })` (checks the input's value) |
| `text` alone | `getByText(text, { exact: true })` is visible |

| Expectation | Meaning |
|-------------|---------|
| `text` | Trimmed text content equals this |
| `contains` | Text content contains this |
| `value` | Input value equals this (for `label`) |
| `visible` | `true` (the default) or `false` |

### Traces and runs

| Path | What | Commit it? |
|------|------|------------|
| `.q-pilot/traces/<id>.json` | The recorded steps: `op`, `role`, accessible `name`, `scope`, `url`. A `fill` stores the fixture's key, never its value. No timings or probabilities. | Yes. Only `/q-pilot record` and `/q-pilot accept` write it. |
| `.q-pilot/runs/<runId>/` | `result.json`, screenshots, a proposed trace `<id>.trace.json` for a drift or a first recording, and a Playwright trace `<id>.trace.zip` for a run that was not a clean pass | No (git-ignored) |

The Playwright trace holds the DOM before and after every action, network and console. Open it with `npx playwright show-trace <file>`, or from the shell with `npx playwright trace open <file>` then `trace actions` (Playwright 1.59+). Use the same Playwright the run used (see `playwright` in the result): `npx` in a folder without it downloads one.

The trace is named `q-pilot task <name>` (or `test`, `flow <id>`), and each executed step is a group titled with its number, target and source, for example `Step 3 · click button "Search" · p 0.83 · jev`. Sources are `jev`, `claude` (a help answer), `box` (Box rescue), `replay`, and `healed p 0.71` for a step Jev re-picked; a DONE or BLOCKED decision is an empty group. Titles carry the role and accessible name only, never a typed value. Older Playwright versions without trace groups just record the plain actions. `--keep-trace` on the runner keeps the trace of a clean pass too (failures always keep it).

**Playwright Dashboard.** With `/q-pilot config dashboard on`, the launched browser is bound as `q-pilot · <task>`. Run `playwright-cli show` in a terminal to list it, look over the run and take control. Combine it with `/q-pilot config inspector pause` so the run waits before step 1 while you open the Dashboard. A flow or spec with `$env:` fixtures records no Playwright trace, because a trace stores typed values unredacted. Each result also lists `pageErrors`: uncaught page errors and console errors, at most 10.

During replay a step matches an observed element with the same `op`, `role` and exact accessible `name`. If several look alike, the `scope` (the name of the nearest form, dialog, landmark or list) must pick exactly one. Otherwise it is a miss. q-pilot never guesses between look-alikes.

### Flow outcomes

| Outcome | When |
|---------|------|
| `pass` | Every step replayed (or a fresh recording) and verify passed. `recorded: true` means the run made a proposal, not a trace. |
| `drift` | A step missed, Jev re-picked it, verify passed. The result lists old and new. A proposal is written to the run folder. |
| `app-bug` | Verify failed, and failed again on a re-run in a fresh browser context |
| `flaky` | Verify failed, then passed on the re-run |
| `blocked` | A step missed and Jev was unavailable, chose BLOCKED/DONE early, or picked a replacement with a probability below 0.5; more than 2 steps missed; or the step or time budget ran out |
| `env` | `start` unreachable, landed on `loginPath`, the server did not start, or a `$env:` fixture is missing |
| `untraced` | No trace and Jev unavailable. Nothing ran. |
| `needs-verify` | `record` with an empty `verify`. The result carries suggested checks. |
| `skipped` | The command budget ran out before the flow started |
| `error` | Invalid flow or config file, or a runner crash for this flow |

### The gate

When a turn of the main loop ends and it edited a UI-relevant file (not docs, configs, unit tests, `.q-pilot/**`, `flows/**` or the `ignore` globs), q-pilot picks the flows with the impact map: a changed file selects a flow whose `covers` glob matches it. UI code that selects nothing selects the `smoke` flows. When only some changed files match, the `smoke` flows are added. `mode: all` runs every flow.

The runner then runs those flows. What the gate does with each outcome depends on `trust`:

| Outcome | `trust: shadow` (default) | `trust: on` |
|---------|---------------------------|-------------|
| `pass` | Allow | Allow |
| `flaky` | Block | Allow |
| `app-bug`, `blocked`, `error` | Block with the flow, step, failed checks and actual values | Same |
| `drift` | Reported once to you; Claude is not sent back for it. You run `/q-pilot accept` | Auto-accept when the turn's diff mentions the old or the new element name, otherwise block |
| `env` | Block | Allow and notify |
| `untraced`, `needs-verify` | Allow with a note asking you to run `/q-pilot record <id>` | Same |

In shadow mode the gate never writes `.q-pilot/traces/`. At most 2 blocks or follow-ups happen per prompt you send.

The band above the prompt shows `pilot ✗ 1 of 3 flows: checkout app-bug` while a run is red, and `pilot ≈ 1 of 3 flows: checkout drift · /q-pilot accept` (amber) when the only problem is drift. The status line shows `pilot ✓ 3/3 flows` when all pass. (Text as reported by the mod agent; not run by me.)

`classic.Stop` is the primary path and `turn.complete` is the fallback for machines where managed settings skip `classic.Stop` hooks in user-installed plugins.

## Commands

| Command | What it does |
|---------|--------------|
| `/q-pilot task "<prompt>"` | Ask Claude to turn the request into a task with fixtures, call `pilot_run`, answer its help requests with `pilot_help`, and report the outcome; the Dashboard opens with the run |
| `/q-pilot test "<prompt>"` | Ask Claude to read the code, write a spec, call `pilot_test` once and report the result as it came back, including red checks and the screenshot path |
| `/q-pilot dashboard` | Start the q-pilot Dashboard if it is not up, open it in your browser, and print its URL. Works before any run; with `inspector off` it says the Dashboard is off |
| `/q-pilot flows` | Last outcome per flow (the same as `/q-pilot flows status`) |
| `/q-pilot flows save [<runId>\|last] [<name>]` | Save a passing prompt-mode run as a flow plus trace |
| `/q-pilot flows run [all\|<id>]` | Replay the affected flows, one flow, or all |
| `/q-pilot flows record <id>` | Record the flow with Jev and write its trace on a pass |
| `/q-pilot flows accept [<id>]` | Save the proposed trace from the latest run that has one |
| `/q-pilot flows export <id>` | Write a Playwright spec (default `tests/q-pilot/<id>.spec.ts`) |
| `/q-pilot init` | Write a starter `q-pilot.config.json` and `flows/example.flow.json`, never overwriting |
| `/q-pilot config [--all]` | Show the settings that differ from the default and where each value comes from; `--all` shows every setting, see [Settings](#settings) |
| `/q-pilot config set\|unset\|explain\|reset …` | Change or explain the settings, see [Settings](#settings) |
| `/q-pilot mode off\|affected\|all` | Short form of `/q-pilot config mode` |

Bare `/q-pilot` prints one line of state and a pointer to `dashboard`; `/q-pilot help` lists the commands above. The flow commands used to be top-level (`/q-pilot save`, `run`, `record`, `accept`, `export`, `status`); those names still work as aliases.

The runner takes the same commands directly: `node runner/pilot.mjs <task|explore|save|run|record|accept|export|list> --root <projectDir>`. `task` and `explore` take the spec as `--spec-json '<json>'`; `task` also takes `--inspect` or `--inspect-pause`, `--inspect-port N`, `--linger` (keep the single-run inspector up after the result; only without a Dashboard), `--vision off|gated|always`, `--vision-model jev-1.13.0|jev-1.14.0`, `--box`, `--ask-via-mod` (the single-run inspector's Ask goes through the mod), `--session-model <id>` and `--settings-sources '<json>'` (the resolved settings and their scopes, for the Dashboard's chips; set by the mod). `--session-kind task|test|gate|flow` (set by the mod). `dash-server.mjs` takes `--window app|tab` (set by the mod from `dashboardWindow`) names what started a run in the Dashboard. A runner finds the Dashboard through `Q_PILOT_DASH_FILE` (the path of `.q-pilot/dashboard/server.json`, set by the mod); without it, `--inspect` serves the single-run inspector as before, and `--help` (help requests through the run folder, see [When Jev is stuck](#when-jev-is-stuck-help-requests)). It prints one line of result JSON last on stdout, and progress on stderr.

## Settings

One plugin option is left, set in `/plugin`: **`jevApiKey`**, the TypeSafe Jev API key (sensitive). When it is empty, `TYPESAFE_API_KEY` is used. When both are missing, Jev is unavailable.

Everything else is set with `/q-pilot config`, in layers like Claude Code's settings. Each value comes from the highest scope that sets it, and `/q-pilot config` shows which one:

| Scope | Where | Who it is for |
|-------|-------|---------------|
| `cli` | Flags of one runner run | One run. The resolver supports it; the mod does not pass any yet |
| `env` | `Q_PILOT_CDP_URL` (the one variable the runner already reads) | Your shell |
| `local` | `<project>/.q-pilot/settings.local.json` | You, in this project. Not committed: `/q-pilot config set … --scope local` adds it to `.gitignore` |
| `project` | `<project>/.q-pilot/settings.json` | The team. Commit it |
| `user` | The plugin store | You, in every project (what `/q-pilot config set` writes by default) |
| default | Built in | |

`cli` beats `env`, then `local`, `project`, `user` and the default. Every setting is a single value, so the highest scope wins as a whole; nothing is merged. The files are read again on every command and tool call, so an edit, or a change from another session, applies at once.

```text
/q-pilot config                              the settings that differ from the default: value, source, what it overrides, warnings
/q-pilot config --all                        every setting
/q-pilot config set helper sonnet            set one in the user scope
/q-pilot config set vision always --scope project    the team's default, in .q-pilot/settings.json
/q-pilot config set box on --scope local     only you, only here
/q-pilot config unset vision --scope project drop it from that scope
/q-pilot config explain vision               every scope's value and which one wins
/q-pilot config helper sonnet                short form of set, user scope
/q-pilot config helper default               same as unset in the user scope
/q-pilot config reset [--scope local]        empty a scope (user by default)
```

The Dashboard shows where its vision settings came from and can save them as defaults (see [q-pilot Dashboard](#q-pilot-dashboard)); that goes through the same writer as `config set`, to the user, project or local scope.

An example `.q-pilot/settings.json`, committed for the team:

```json
{
  "vision": "gated",
  "visionModel": "jev-1.14.0",
  "box": true,
  "mode": "affected"
}
```

**Stale plugin options.** Older versions kept these as plugin options, and they may still sit in `~/.claude/settings.json` under `pluginConfigs["q-pilot@q-harness"].options`: `mode`, `trust`, `followUp`, `cdpUrl`, `vision`, `visionModel`, `visionBox`. They are not read any more. Remove them by hand and keep only `jevApiKey`; set the values with `/q-pilot config` instead.

**Personal settings.** `node` (a command that is run), `cdpUrl` (the Chrome the run attaches to) and `trust` (accepts drift without a person) are read only from `user`, `env` and `cli`, and are marked `*` in `/q-pilot config`. A repo file, even a `settings.local.json` someone force-committed, cannot set them: they are ignored with a warning, and `config set node … --scope project` is refused. Settings files never hold secrets: `jevApiKey` stays the plugin option, and an unknown key, or anything that looks like a key or token, is dropped with a warning. A value that does not fit its setting, or a file that is not valid JSON, is dropped with a warning naming the scope and the key; the rest of the settings still apply.

**One scope setting hides another.** `Q_PILOT_CDP_URL` in your shell beats `cdpUrl` in `user`, so `/q-pilot config` shows `cdpUrl … env`; unset the variable to use the stored value. A `cdpUrl` that is set in any scope (`off` included) is passed to the runner as `Q_PILOT_CDP_URL`, empty for `off`.

`.q-pilot/runs/` and `.q-pilot/settings.local.json` are the only things there that stay out of git; `.q-pilot/traces/` and `.q-pilot/settings.json` are committed.

| Setting | Default | What it does |
|---------|---------|--------------|
| `helper` | `haiku` | The Claude model that answers Jev's help requests first: `haiku`, `sonnet` or `opus`. `session`: your chat answers every one. See [The helper model](#the-helper-model). |
| `vision` | `gated` | Jev vision for tasks and tests: `off`, `gated` (asks again with the screenshot when unsure), `always`. The stop gate's replay uses no model, so it takes none. |
| `visionModel` | `jev-1.13.0` | The Jev model that answers with the screenshot (`jev-1.14.0` is the preview) |
| `box` | `off` | `on`: Box rescue with Jev 1.14 before a stuck run goes to the helper |
| `inspector` | `on` | `on`: the q-pilot Dashboard is started and every run reports to it; a task also opens in your browser. `pause`: the same, with tasks held before the first step. `off`: no Dashboard. |
| `dashboardWindow` | `app` | How the q-pilot Dashboard opens: `app` (its own app window, one per project) or `tab` (a tab in your default browser). Not the Playwright Dashboard, see `dashboard`. |
| `dashboard` | `off` | `on`: runs show up in the Playwright Dashboard (`playwright-cli show`), where you can watch and take over the launched browser. Pause in the inspector (`inspector pause`) before you take control. Needs a Playwright with `browser.bind`; ignored otherwise and with `cdpUrl`. |
| `mode` | `affected` | Stop gate: `off`, `affected` (flows the turn's edits affect), or `all`. `/q-pilot mode <value>` is a short form. |
| `cdpUrl` (personal) | off | Run the browser under test in your own running Chrome, e.g. `http://127.0.0.1:9222`. See [Use your own Chrome](#use-your-own-chrome) |
| `node` (personal) | `node` | Command that runs the runner, e.g. `/opt/homebrew/bin/node` |
| `trust` (advanced, personal) | `shadow` | `shadow` or `on`, see [The gate](#the-gate) |
| `followUp` (advanced) | `auto` | What the fallback gate does on red: `auto`, `suggest` or `off` |
| `maxStopSeconds` (advanced) | `60` | Time budget for the gate (10 to 600) |
| `maxTestSeconds` (advanced) | `120` | Time limit for one `pilot_test` run (20 to 600) |
| `maxTaskSeconds` (advanced) | `300` | Time limit for one `pilot_run` task, paused time included (30 to 600). Time spent waiting for an answer to a help request is not counted. |

**Upgrading from 0.7.** The options `network`, `inspectorPort` and `playwrightPath` are gone. Network access is open unless `Q_PILOT_ALLOW_REMOTE=0` is set in your shell; the inspector takes port 8767, or a free one when it is taken; Playwright is found as described in [Install](#install), and `Q_PILOT_PLAYWRIGHT` still names a folder. A `/q-pilot mode` you had set is copied into `/q-pilot config` on the first start; the old options are not read any more, so set them again with `/q-pilot config` (in particular `node`).

**Browser window.** Chromium opens in a visible window by default, so you can watch Jev click and type. That includes the stop gate, which opens a window at the end of a turn that changed UI files. Set `Q_PILOT_HEADLESS=1` in your environment to run without a window. It is headless anyway in CI (`CI` set) and on Linux without a display.

`q-pilot.config.json` (project root): `baseURL` (required), `flowsDir` (default `flows`), `server` (`command`, `url`, `timeoutMs`; started when `url` does not answer and stopped after the run), `loginPath` (landing on it means `env`), `storageState` and `ignore`.

**Start logged in.** `storageState` is a path inside the project to a Playwright storage state (cookies and local storage), for example saved with `npx playwright codegen --save-storage=.auth/state.json <url>`. Every run's fresh context starts from it. The file holds session tokens: git-ignore it. A Playwright trace of such a run (kept when it is not a clean pass) records requests with those cookies, so treat `.q-pilot/runs/` as private.

#### Use your own Chrome

Set `/q-pilot config cdpUrl <url>` (or `Q_PILOT_CDP_URL`) to attach to a Chrome that is already running. q-pilot opens a new tab in its default profile, so your logins apply, and closes only that tab; it never closes the browser. Start Chrome for this with a separate profile, because recent Chrome refuses remote debugging on the default one:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" --remote-debugging-port=9222 --user-data-dir="$HOME/.q-pilot-chrome"
```

Pick a port nothing else uses: an Electron app in debug mode may already listen on it, and it refuses new tabs (`Target.createTarget: Not supported`). On macOS, Chrome keeps running after its last window closes, and in that state it refuses to attach (`Browser context management is not supported`); q-pilot then opens a tab through `/json/new` and attaches again once. With `cdpUrl` set, `storageState` and the 1280×720 viewport are not applied, and no Playwright trace is recorded: a trace would capture every tab of your profile.

Trust boundaries:

- `server.command` runs code from the repo, with the same trust as Playwright's `webServer`. Read it before you run a repo you did not write. It gets the runner's environment minus the Jev key (`TYPESAFE_API_KEY` is removed before the spawn).
- Playwright is loaded from the project first, so a repo's `node_modules` runs inside the runner. Same trust as the server command.
- Network access is open by default: `baseURL` and `server.url` may be any URL, and a run may follow a link to another origin. A spec Claude writes, or a repo's `q-pilot.config.json`, can therefore point the browser at any host, and `$env:` fixtures are typed into whatever page Jev picks. Set `Q_PILOT_ALLOW_REMOTE=0` in the shell Claude Code starts from to allow loopback apps only (`localhost`, `127.0.0.1`, `[::1]`) and block a run that leaves the base origin. A repo file cannot change it.

## Jev: what is sent, what never is

Jev is called to drive prompt-mode tests, to record, and to heal a step. Replay of a saved trace makes no call. A prompt-mode run makes about one request per step (two for a fill when there are several fixtures: the fixture is asked for the chosen field), plus one for soft checks if the spec has any. Each request has a 15 s timeout and is retried twice on 429, 503, 529 or a dropped connection (model `jev-latest`).

| Sent | Never sent |
|------|------------|
| With vision on: the viewport screenshot, on the steps that use it (never in a run that types a secret) | |
| Page URL and title | `$env:` fixture values (secrets): only their key names, `[secret]` in the action history |
| Visible page text (up to 6000 characters) | Cookies, `Authorization`/Bearer values, `password=` pairs, JWTs |
| Interactive elements: index, role, label, value, state (checked, selected, expanded, pressed, current), scope, the fixture key a field holds, allowed operations | The exact resolved fixture values, even when they appear on the page |
| Fixture key names, the last 10 actions (with whether each changed the page, and the literal text typed, as jev-ultrafast sends it), and for a heal the missed step | The `checks` and `verify` blocks |
| Soft-check questions, with the final page state | |

Page text and element values are redacted before sending. Traces and proposals store fixture keys, never values.

## How it differs

- **q-e2e** (removed; q-pilot replaces it) ran Playwright specs you write and maintain. When a locator drifts, the spec fails and waits out its timeout. q-pilot keeps no spec: the flow is the source, the trace is generated, and a drifted step is re-picked in under a second. q-pilot can [export](#commands) a flow as a spec when you want one.
- **jev-ultrafast** is a loop where the model picks every action. Task mode follows it closely: the same snapshot, the same operation and target heads in one request, the same next-action rules, and an inspector with the same controls. The differences: Claude is the front end and writes the task; typed text comes from fixtures Claude writes up front, not from a second text model; the browser is Playwright (launched Chromium, or your Chrome over CDP) instead of Browser Harness. For tests, Claude writes the checks first and code evaluates them: the pass/fail verdict never comes from Jev reporting DONE. Saved flows replay without it.

## Limits

- Flows are JSON, not the YAML the first design report showed.
- Each prompt-mode run costs about one Jev call per step (the PoC runs took 3 and 4 calls). Saved-flow replay costs none.
- Prompt-mode runs are not deterministic. The same spec can take a different path on the next run, and a run can end `blocked` where the last one passed. The checks are what stays fixed, so write them strongly.
- A control covered by an overlay is not offered to Jev: the snapshot drops an element whose centre is covered by another one. In the PoC, arXiv's search from the home page ended `blocked` this way, while `/search/` passed. Start on the route that has the control, or add a step that opens it.
- There is no Haiku fallback. Without Jev, prompt mode ends as `blocked`, a missed step in a saved flow ends as `blocked` (`jev unavailable`), and an untraced flow as `untraced`. Replay of existing traces needs no model.
- Soft checks are model judgement and never decide the outcome.
- A task can only type the fixtures Claude wrote before the run; there is no text model choosing words mid-run. A field that needs a value nobody foresaw ends the task as `blocked`.
- A task without checks proves nothing: `done` only means Jev said so.
- The stop gate does not run prompt-mode tests, only saved flows.
- The DOM snapshot does not see shadow roots, iframes, canvas, file uploads or popup tabs.
- Look-alike elements (same role and name, not told apart by scope) become misses, never guesses.
- A flow heals at most 2 steps, each only when Jev's pick has a probability of at least 0.5. Otherwise the flow ends as `blocked`, naming the pick.
- Electron apps are not a target yet: q-pilot launches Chromium or attaches to Chrome.
- Exported specs do not narrow a locator by `scope`, so an export of a flow with look-alike elements may need a hand edit.
- The PoC numbers above are from the design reports. They are not a benchmark of this release.

See [TODOS.md](TODOS.md) for what is next.

## Develop

| Path | What |
|------|------|
| `.claude-plugin/plugin.json` | Mod manifest and its one option (the Jev key) |
| `hooks/register.tsx`, `hooks/lib/` | The mod: gate, commands, tools, band; pure helpers such as the impact map |
| `runner/pilot.mjs` and `runner/*.mjs` | The CLI: driver (Playwright resolution, launch or CDP attach, sessions), snapshot, executor, replay, record, jev, verify, redact, flow, trace |
| `runner/dash-server.mjs`, `runner/dash-client.mjs`, `runner/session.mjs`, `runner/history.mjs`, `runner/config-bridge.mjs` | The q-pilot Dashboard: its loopback server, how a runner reports a session to it, the session core, and the history rebuilt from `.q-pilot/runs/` |
| `runner/inspect.mjs`, `runner/inspector/` | The single-run inspector a shell run without a Dashboard serves, and the page both use |
| `hooks/lib/dash.ts` | Pure helpers for the Dashboard's ready mark and the band's link |
| `runner/settings-save.mjs` | The Dashboard's "Save as default": a request file in the run folder that the mod applies |
| `runner/export.mjs` | `exportSpec(flow, trace, { baseURL })`, a pure function |
| `skills/flows/SKILL.md` | Rules Claude follows |
| `examples/demo-app/` | Demo app with a flow and a config |

```bash
claude --plugin-dir ./plugins/q-pilot       # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-pilot
claude plugin test ./plugins/q-pilot        # mod tests (tests/*.test.ts)
node --test plugins/q-pilot/runner/*.test.mjs   # runner and export tests
Q_PILOT_LIVE=1 node --test plugins/q-pilot/runner/live.test.mjs   # real Jev calls (needs TYPESAFE_API_KEY)
```

The export test also runs an exported spec with `playwright test` against a copy of `examples/demo-app`. It is skipped when Playwright is not installed there.
