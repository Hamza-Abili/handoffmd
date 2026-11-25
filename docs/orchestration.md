# Multi-agent orchestration

`handoffmd` is a **coordination primitive**, not an orchestrator. It does not start agents, schedule work, or keep a daemon. That is deliberate: orchestration is a crowded, security-sensitive product category, and coupling it to the handoff format would make both worse.

What it gives an orchestrator is a small, stable contract:

| Command | Output |
|---|---|
| `handoffmd save --from <agent> --json` | Writes `HANDOFF.md` + `.handoff/state.json`, returns repo/session metadata, warnings and token count. |
| `handoffmd check --json` | Returns `{ ok, findings, stale, tokens, status }`; exit `0/1/2`. |
| `handoffmd load --for <agent> --json` | Returns `{ brief, sections, tokens, stale }`. The short brief is what you give the next agent. |
| `handoffmd list --json` | Current and archived handoffs with status and age. |
| `handoffmd show --json` | The full frontmatter, sections and evidence state. |

## Sequential handoff

```bash
# Agent A finishes a slice
npx @hamzaabili/handoffmd save --from claude --json > /tmp/handoff-a.json
npx @hamzaabili/handoffmd check --json

# Orchestrator chooses Agent B
npx @hamzaabili/handoffmd load --for codex --json > /tmp/brief.json
jq -r .brief /tmp/brief.json > /tmp/codex-prompt.txt
# start Codex and pass /tmp/codex-prompt.txt as the first prompt
```

The handoff is committed with the code, so the next agent (or a human) can verify the same evidence.

## Parallel worktrees

One worktree = one `HANDOFF.md` and one `.handoff/` directory. There is no shared lock or database to coordinate.

```bash
git worktree add ../app-auth -b feature/auth
cd ../app-auth
npx @hamzaabili/handoffmd init
npx @hamzaabili/handoffmd save --from opencode
```

When the work is merged, archive or remove the worktree. `handoffmd prune --keep 5 --yes` cleans the local archives in the main checkout.

## Orchestrator loop (pseudo-code)

```ts
for (const task of tasks) {
  const worktree = await createWorktree(task);
  const result = await runAgent(task.agent, { cwd: worktree, prompt: task.prompt });
  if (result.status !== "done") continue;

  await exec("npx", ["@hamzaabili/handoffmd", "save", "--from", task.agent, "--cwd", worktree]);
  const check = JSON.parse(
    await exec("npx", ["@hamzaabili/handoffmd", "check", "--json", "--cwd", worktree])
  );
  if (!check.ok) throw new Error(`stale handoff: ${JSON.stringify(check.findings)}`);

  const next = JSON.parse(
    await exec("npx", ["@hamzaabili/handoffmd", "load", "--for", task.nextAgent, "--json", "--cwd", worktree])
  );
  await runAgent(task.nextAgent, { cwd: worktree, prompt: next.brief });
}
```

Use the JSON fields, not `stdout` prose, and never interpolate untrusted transcript text into a shell command.

## What handoffmd will not do

- Start, stop, or supervise agents.
- Schedule tasks, allocate quotas, or manage subscriptions.
- Store secrets, memory, or a vector database.
- Replace your orchestrator's state machine.

If you need a runner, use the orchestrator you already trust (a shell script, a CI job, a workflow engine) and call `handoffmd` at the boundaries.
