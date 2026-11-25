# Recipes

## Switch agents mid-task

Claude Code hit a quota or you want Codex to review the work.

```bash
npx @hamzaabili/handoffmd save --from claude
# review HANDOFF.md, correct anything auto-extraction got wrong
npx @hamzaabili/handoffmd save --lock
npx @hamzaabili/handoffmd check --strict
```

In Codex:

```bash
npx @hamzaabili/handoffmd check
npx @hamzaabili/handoffmd load --for codex
```

Paste the brief into the first prompt, or let the installed skill do it. The next agent starts by verifying the repository and continues from the first unchecked step.

## Before context compaction

```bash
npx @hamzaabili/handoffmd save --from claude
npx @hamzaabili/handoffmd save --lock
npx @hamzaabili/handoffmd check --strict
```

If you only have a minute, `save` still records the goal, state, changed files and next steps. Review the narrative later with `save --lock`.

## Another machine

Commit the handoff and the evidence:

```bash
git add HANDOFF.md .handoff .claude .codex .opencode .agents
git commit -m "docs: handoff"
```

On the other machine:

```bash
git pull
npx @hamzaabili/handoffmd check --strict
npx @hamzaabili/handoffmd load --for claude
```

`check` will detect that the commit moved. A handoff-only commit is allowed; if the pulled commits touch source files, `check` fails until you re-save. That is intentional: the handoff must match the code.

## Hand off to a human

Set the status and keep the file short:

```bash
npx @hamzaabili/handoffmd save --from claude --status review
npx @hamzaabili/handoffmd save --lock
npx @hamzaabili/handoffmd check --strict
```

The reviewer reads `HANDOFF.md`; the next agent reads `handoffmd load`. The same file serves both.

## CI gate

Fail a pull request when a committed handoff is stale, unsafe or over budget:

```yaml
name: handoff
on: [pull_request]
jobs:
  check:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with:
          node-version: 22
      - run: npx @hamzaabili/handoffmd@0.1.1 check --strict
```

Run it from the repository root. `handoffmd` uses one handoff per repository; use a separate worktree for a separate task.

## Parallel worktrees

Each worktree gets its own handoff because `HANDOFF.md` and `.handoff/` live in the worktree.

```bash
git worktree add ../app-feature -b feature/login
cd ../app-feature
npx @hamzaabili/handoffmd init
npx @hamzaabili/handoffmd save --from opencode
```

When the work is merged, archive or remove the worktree. `handoffmd prune --keep 5 --yes` keeps the last five archived handoffs in the main checkout.

## Fresh test evidence

Run the relevant test command at save time:

```bash
npx @hamzaabili/handoffmd save --from codex --test "bun test"
npx @hamzaabili/handoffmd save --from codex --test "pnpm typecheck"
```

The command runs in the repository root, with a 120-second timeout by default (`--test-timeout` changes it). The result is written under `Evidence`, so the next agent knows what was actually run.

## Blocked work

```bash
npx @hamzaabili/handoffmd save --from claude --status blocked
```

Put the blocker under `State` or `Open questions`, and the exact unblocking action under `Next steps`. `check` still requires a next step, because "blocked" is not "done".

## Start a new task

```bash
npx @hamzaabili/handoffmd save --new --from claude
```

The previous handoff is copied to `.handoff/archive/` and a new one is created. `handoffmd list` shows the chain; `handoffmd prune --keep 10 --yes` cleans old archives.
