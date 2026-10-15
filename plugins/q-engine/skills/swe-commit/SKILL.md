---
name: swe-commit
description: Commit discipline for git. Use when the user asks to commit, write or fix a commit message, split work into several commits, or prepare changes for a pull request. Stages only related changes, keeps secrets out, and writes messages in the project's convention.
---

# Commit

Make commits that a reviewer can read one at a time and that are safe to push.

## 1. Look before staging

```bash
git status --short
git diff            # unstaged
git diff --staged   # already staged
git log --oneline -15
```

- If you are on the default branch and the project uses feature branches, ask before committing
  there, or create a branch.
- Never commit unless the user asked for a commit.

## 2. Keep secrets and noise out

Do not stage, and warn the user about:
- `.env*` files (except `.env.example`), keys, certificates, credential or token files
- secrets inside tracked files: API keys, passwords, connection strings with credentials
- build output, dependency folders, local caches, editor files, large binaries

If a file like this is already staged, unstage it (`git restore --staged <file>`) and say why.
If a secret was already committed, tell the user it must be rotated. Rewriting history does not
make a pushed secret safe.

## 3. One logical change per commit

- Stage by file (`git add <path>`) when files belong to different changes. Never use
  `git add -A` or `git add .` blindly.
- If one file mixes unrelated changes, tell the user and suggest separate commits. Do not use
  interactive staging (`git add -p`), which needs a terminal.
- Code and the tests or docs for it belong in the same commit.

## 4. Write the message

Follow the project's existing convention, read from `git log`. If it has none, use
Conventional Commits:

```
<type>(<optional scope>): <imperative summary, ≤ 72 chars, no trailing period>

<body: what changed and why, not how; wrap at 72>

<footer: BREAKING CHANGE: ..., Refs #123, Co-authored-by: ...>
```

Types: `feat`, `fix`, `refactor`, `perf`, `test`, `docs`, `build`, `ci`, `chore`, `revert`.

- The summary says what the commit does to the codebase ("add rate limit to login"), not what
  you did ("added some changes").
- The body explains the reason when it isn't obvious from the diff.
- Keep any attribution trailer that the environment or project requires.

## 5. Verify

- Run the project's fast checks first (lint, type-check, unit tests) when they exist. Do not
  bypass hooks with `--no-verify` unless the user asks.
- After committing, show `git log --oneline -1` and `git status --short`, so the user can see
  what is left.
- Never amend, rebase, or force-push commits that are already pushed unless the user asks.
