# q-advisor

> Part of [q-harness](../../README.md), a collection of Claude Code plugins by [**phuquocchamp**](https://github.com/phuquocchamp)

**Is this still the right model, the right session, and enough room in the context?** q-advisor watches the session and, at the moment it matters, suggests one thing: switch model, compact with a focus, start fresh, or set up a long task the right way. A decision model (TypeSafe's **Jev**, the "System 1" of the harness, with Haiku as the fallback when there is no Jev key) makes the quick judgement calls; the numbers come from the session itself.

**Status** Design (not built yet) · **Version** 0.0.0 · **Author** phuquocchamp

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/supervision-loop-dark.png">
  <img alt="The supervision loop: the developer prompts the coding agent (System 2); at five checkpoints (prompt submit, tool check, context, stop, attention) the agent asks Jev (System 1) a typed question and gets a probability back; only a vague prompt and a moment that needs a decision reach the developer." src="images/supervision-loop-light.png" width="100%">
</picture>

## Why

Three things quietly go wrong in long sessions:

| Problem | What it costs you |
|---------|-------------------|
| The context fills up, autocompact fires mid-task and keeps the wrong things | Claude forgets the plan, the files it changed, the decision you made an hour ago |
| A new task starts in an old session | Every turn pays for (and is distracted by) unrelated history |
| The model doesn't fit the task: Opus for renaming a variable, Haiku for an architecture call | Money and rate limit, or quality |

Claude Code shows the raw numbers (`/context`, `/cost`, the status line) but leaves the decision to you, at a time you are not looking. q-advisor makes the decision visible at the right moment and leaves the action one key away.

## Principles

- **Suggest, never act.** Every piece of advice is a Tab-to-accept suggestion in the prompt box or a button. q-advisor never switches the model, compacts or clears on its own.
- **One piece of advice at a time, at a turn boundary.** Nothing appears while Claude is working.
- **Show the reason with the numbers.** `context 78% · 3 turns since the plan` beats "you should compact".
- **Cheap.** Rules over numbers first; Jev is asked only when a rule cannot decide, never for short prompts, and with a time limit. The advisor must cost far less than what it saves.
- **Learns to be quiet.** Advice you dismiss again and again is shown less often.

## Features

Priority: **P0** first version, **P1** next, **P2** later.

### P0: Context advice

| Signal | Advice |
|--------|--------|
| Context ≥ 60% and the current task is finished (the last turn ended with no tool errors and no open todo) | `Compact now while it's cheap: /compact keep the plan, changed files and open questions` |
| Context ≥ 80% mid-task | `Compact before autocompact does it for you`, with focus instructions Jev writes from the current goal, the files changed and the last decisions |
| Jev says the new prompt is a **different task** from the last few turns | `New task: /clear (or a new session) gives Claude a clean context` |
| Several compactions already in this session | `This session has compacted 3×; a fresh session with a short handoff note is cleaner`, with a button that writes the handoff note |

The **focused compact** is the key feature: instead of the engine's generic summary, the `/compact` instructions name what to keep (the plan, the decisions, the files and their state, the open questions), so the session survives the compaction.

### P0: Model fit

Jev sorts each prompt into a task size, then compares it with the current model:

| Task size | Examples | Fits |
|-----------|----------|------|
| trivial | rename, typo, format, a one-line question | Haiku |
| routine | a feature in known code, tests, a bug with a clear stack trace | Sonnet |
| deep | architecture, an unclear bug, a large refactor, security review, a plan | Opus |

- A mismatch two steps away (deep task on Haiku, trivial task on Opus) shows `/model sonnet` as a Tab suggestion, with the reason.
- **Cache-aware:** switching model throws away the warm prompt cache, and re-caching a large context costs money. q-advisor suggests a switch when the cache is already cold (idle longer than the cache TTL) or the context is small, and says so when it is not: `Switch would re-cache 140k tokens; finish this task first`.
- **Rate-limit aware:** when the five-hour window is above 80%, suggest the cheaper model for routine work.

### P1: Long-task setup (big plan, loop, goal)

When Jev reads a prompt as a long task, q-advisor suggests how to run it before Claude starts:

| Kind | Advice |
|------|--------|
| **Big plan** (many steps, many files) | Plan mode first; compact with the plan as the focus once it is approved; one session per phase |
| **Loop** (poll, babysit, retry until green) | `/loop` with a sensible interval instead of a long blocking turn; compact between iterations |
| **Goal** (open-ended: "make the tests pass", "improve performance") | Write down the done-criteria first; checkpoints (commit, compact) after each milestone |
| **Parallel work** (independent parts) | Subagents or worktrees, so the main context stays small |

### P1: Session report

`/q-advisor` prints where the session stands and what q-advisor would do now:

```text
q-advisor  ·  claude-opus-5-5  ·  42 turns  ·  $3.18
context    78%  ████████████████░░░░  156k / 200k   compacted 1×
cache      warm (last turn 2m ago, TTL 5m)
limits     five-hour 46%  ·  seven-day 12%
task       routine (Jev)  →  sonnet fits
advice     compact now: the task finished 1 turn ago
```

### P2: Learn from your answers

Count, per kind of advice, how often it was accepted or dismissed (`$.store`, across sessions). Advice dismissed five times in a row needs a stronger signal before it shows again. `/q-advisor stats` shows the counts.

## Commands (planned)

| Command | What it does |
|---------|--------------|
| `/q-advisor` | The session report and the advice for now |
| `/q-advisor on\|off` | Turn the advice on or off (saved) |
| `/q-advisor mute <kind>` | Stop one kind of advice: `context`, `model`, `task`, `limits` |
| `/q-advisor stats` | Accepted and dismissed counts per kind |
| `/q-advisor config` | Show the settings |
| `/q-advisor config <key> <value>` | `compactAt` (default `60`), `urgentAt` (`80`), `jev` (on/off), `jevModel` (default `haiku`), `quietTurns` (minimum turns between two pieces of advice, default `3`) |

## How it would be built

| Need | Claude Code mod API |
|------|---------------------|
| Context %, rate limits, cost | `$.session.usage()` |
| Current model, turn count | `$.session.model()`, `$.session.turns()` |
| Jev's judgement (task size, same or new task, long-task kind) | `$.model.classify(text, labels, { model: 'haiku' })` |
| Focus instructions and handoff note | `$.model.complete({ model: 'haiku', … })` over `$.session.messages()` |
| When to advise | `prompt.submit` (classify the prompt, without blocking it), `turn.complete` (decide), `session.compact` (count compactions) |
| Show advice | `$.prompt.suggest` (Tab to take), a button in a row above the prompt, `$.ui.toast` for urgent advice |
| Act on a click | `$.session.compact({ instructions })`, `$.command.run` for `/model` and `/clear` (queued until the session is idle) |
| Remember answers and settings | `$.store` |

## Limits

- A mod cannot switch the model or clear the session on its own; q-advisor can only suggest the command or run it after a click, once the turn is over.
- Jev's labels are guesses. A wrong "new task" or "deep task" is cheap to dismiss, which is why everything is a suggestion.
- Each Jev call costs a little. It is skipped for short prompts and slash commands, and can be turned off (`jev off`): q-advisor then uses the number rules only.
- Cache warmth is estimated from the idle time and the cache TTL; the engine does not report it directly.

## Feedback on the original idea

The idea in [TODOS.md](../../TODOS.md) (model choice, when to start a new session, when to compact, how to run big plans, loops and goals) is sound; a few changes make it useful in practice:

1. **Make the advice actionable.** "Consider compacting" is noise; a ready `/compact` with focus instructions is a tool. Every piece of advice ships its command.
2. **Advise at turn boundaries only.** Advice during a turn interrupts, and nothing can be acted on then anyway.
3. **Don't let the advisor cost more than it saves.** A Haiku call on every prompt adds latency and tokens; rules decide most cases, Jev only the unclear ones, in the background.
4. **Count the cost of a model switch.** Changing model throws away the prompt cache, so "Opus is overkill" is only good advice when the cache is cold or the context is small.
5. **Rate limits are part of the decision.** Near the five-hour limit, the right model is often the cheaper one.

## Install

Not published yet. When it is:

```text
/plugin install q-advisor --marketplace phuquocchamp/q-harness
```

## Develop

```bash
claude --plugin-dir ./plugins/q-advisor       # load from disk; saving a file reloads it
claude plugin validate ./plugins/q-advisor
claude plugin test ./plugins/q-advisor
```
