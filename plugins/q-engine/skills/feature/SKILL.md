---
name: feature
description: Take a feature from idea to verified code with the q-engine team (product manager, product owner, architect, engineer, reviewer, verifier), pausing for the user's approval between stages. Each stage writes a file that the next stage reads.
argument-hint: <feature idea or request> [--from=po|architect|engineer] [--skip-pm]
disable-model-invocation: true
allowed-tools: Agent, Read, Write, Glob, Bash(mkdir:*), Bash(date:*), Bash(git status:*), Bash(git diff:*)
---

## Request

$ARGUMENTS

## Why this runs in stages

Each subagent starts with an empty context. Work passes between stages as **files**, never as a
one-line summary, so nothing decided earlier is lost. Every stage costs tokens, so skip what the
task does not need:

- Small, clear change → run `q-engine:swe-engineer` directly instead of this skill.
- Already validated idea → start at the PO (`--skip-pm` or `--from=po`).
- Stories and design already exist → `--from=engineer`, and pass their paths.

## Setup

1. Pick a slug from the request. Create `feature_dir` = `.q-engine/features/<YYYY-MM-DD>-<slug>/`
   with `mkdir -p` (unless the project already has a product docs folder; then the PM and PO
   write there and you record their paths).
2. Show the user the stage plan: which stages will run, and which are skipped and why.

## Stages

After each stage: read the stage's output file yourself, show the user a short summary
(3–6 bullets) and the path, and **wait for approval** before the next stage. If the user asks for
changes, re-run that stage with their feedback. Do not move on.

| # | Agent | Reads | Writes |
|---|-------|-------|--------|
| 1 | `q-engine:swe-product-manager` | the request | `01-brief.md`: problem, evidence, decision |
| 2 | `q-engine:swe-product-owner` | `01-brief.md` | `02-stories.md`: stories, acceptance criteria, out of scope |
| 3 | `q-engine:swe-architect` | `02-stories.md` + code | `03-design.md` (you save it; the architect has no Write tool) |
| 4 | `q-engine:swe-engineer` | `02-stories.md`, `03-design.md` | the code change, plus `04-implementation.md` (files changed, how it was verified) |
| 5 | `q-engine:swe-reviewer` | the diff | `05-review.md` (you save it) |
| 6 | `q-engine:swe-verifier` | `02-stories.md` + the diff | its verification report; copy the path into `06-verify.md` |

Rules for the stages:
- **Stage 1 says "don't build":** stop and report. Do not continue to stage 2 without the user's
  explicit approval.
- **Stage 3 is optional:** skip it when the stories need no design decision (one module, no new
  dependency, no schema change), and tell the user you skipped it. Pull in
  `q-engine:swe-database` when the stories touch the schema.
- **Stage 5 has Critical or Warning findings:** send them back to stage 4, then review again.
- **Stage 6 is FAIL or PARTIAL:** send the failing criteria back to stage 4, then re-run 5 and 6.
- Stop after **two** fix loops on the same criterion, and ask the user how to proceed.

In every agent prompt, pass the absolute paths of the files it reads and writes, and the
acceptance criteria verbatim when the agent needs them.

## Finish

Report the verdict, the files changed, the `feature_dir` path, and any open questions. Offer to
commit with `q-engine:swe-commit`. Do not commit unless asked.
