# q-advisor

Not built yet.

## Long-task setup advice

When Jev reads a prompt as a long task, suggest how to run it before Claude starts. Unprobed: check that Jev separates the kinds before building.

| Kind | Advice |
|------|--------|
| Big plan (many steps, many files) | Plan mode first; compact with the plan as the focus once approved; one session per phase |
| Loop (poll, babysit, retry until green) | `/loop` with a sensible interval; compact between iterations |
| Goal (open-ended) | Write down the done-criteria first; checkpoint after each milestone |
| Parallel work | Subagents or worktrees, so the main context stays small |

## Web-search result triage (opt-in idea)

After a `Web Search` tool call, ask Jev whether the results are trash, so junk does not stay in the context. Probed 4/4.

## Verify

- Whether the focus measurably changes the engine's summary.
