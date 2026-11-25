# handoffmd format specification

Version: **1** (the `handoff` frontmatter field).

`handoffmd` has one portable artifact and one local evidence file. Any agent that can read Markdown can consume the artifact; the CLI only automates capture and verification.

## Files

| Path | Purpose | Commit? |
|---|---|---|
| `HANDOFF.md` | The handoff itself. Configurable with `config.file`. | Yes |
| `.handoff/config.json` | Project configuration. | Yes |
| `.handoff/state.json` | Evidence used for freshness checks. | Yes |
| `.handoff/archive/*.md` | Previous handoffs. | Optional |
| `.handoff/tmp/` | Scratch space. | No |
| `.claude/skills/handoffmd/SKILL.md` etc. | Agent skill. | Yes |

## `HANDOFF.md`

### Frontmatter

The file starts with a `---` block. Values are plain scalars; quoted values use JSON string escaping.

```yaml
---
handoff: 1
title: "Fix the OAuth callback"
status: in-progress
updated: 2026-11-25T10:00:00.000Z
agent: claude
session: "ses_01H..."
branch: "main"
commit: a1b2c3d4e5f6...
generated: manual
---
```

| Field | Required | Meaning |
|---|---|---|
| `handoff` | yes | Format version. Must be `1`. |
| `title` | yes | One line. Used by `list` and the H1. |
| `status` | yes | `in-progress`, `blocked`, `review` or `done`. |
| `updated` | yes | ISO 8601 timestamp of the last narrative review. |
| `agent` | no | `claude`, `codex`, `opencode` or `generic`. |
| `session` | no | Session id, for traceability. |
| `branch` | no | Branch at capture time. |
| `commit` | no | Full SHA at capture time. |
| `generated` | no | `auto` when the narrative was auto-extracted, `manual` after review. |

### Sections

The H1 title is followed by `##` sections. Required sections:

| Section | What it must contain |
|---|---|
| `Goal` | The concrete outcome and why it matters. User-visible behaviour when relevant. |
| `State` | What is true now: implemented, broken, unverified. Grounded in the repository. |
| `Next steps` | Ordered `- [ ]` checklist. The first unchecked item is where the next agent starts. |
| `Open questions` | Unknowns and decisions that need a human. `_None._` is valid. |
| `Evidence` | Branch, commit, changed files, test results. Usually generated. |

Optional sections: `Decisions`, `What changed`, `What didn't work`, `Constraints`.

The highest-value content is what the next agent **cannot reconstruct** from the code or git history: intent, rejected approaches, exact next step, and constraints.

### Status semantics

- `in-progress`: work is unfinished; at least one unchecked next step is expected.
- `blocked`: waiting on a human, a dependency, or an external system. Explain the blocker under `State` or `Open questions`.
- `review`: implementation is done; someone must review or verify.
- `done`: no continuation expected. Unchecked steps are allowed but unusual.

## `.handoff/config.json`

```json
{
  "version": 1,
  "file": "HANDOFF.md",
  "maxTokens": 4000,
  "loadMaxTokens": 1500,
  "warnAgeDays": 7,
  "maxAgeDays": 30,
  "redact": true,
  "include": [],
  "exclude": [".env", ".env.*", "*.pem", "*.key", "secrets/**"]
}
```

| Field | Default | Meaning |
|---|---|---|
| `file` | `HANDOFF.md` | Relative `.md` path inside the repo whose basename contains `handoff`; it cannot point into `.git/` or `.handoff/`. |
| `maxTokens` | `4000` | Hard budget for `HANDOFF.md`; `check` fails above it. |
| `loadMaxTokens` | `1500` | Default budget for `load`; `--max-tokens` overrides. |
| `warnAgeDays` | `7` | `check` warns after this age. |
| `maxAgeDays` | `30` | `check` fails after this age (`0` disables). |
| `redact` | `true` | Redact secrets when writing. `--no-redact` overrides per run. |
| `include` | `[]` | If non-empty, only these globs are considered changed files. |
| `exclude` | secret patterns | Globs excluded from evidence and hashing. |

## `.handoff/state.json`

The state is the evidence behind the handoff. It is not the handoff.

```json
{
  "version": 1,
  "savedAt": "2026-11-25T10:00:00.000Z",
  "handoffSha256": "...",
  "repo": { "branch": "main", "head": "...", "headShort": "a1b2c3d", "dirty": true },
  "changes": [
    { "path": "src/auth.ts", "status": "M", "sha256": "..." }
  ],
  "session": { "agent": "claude", "id": "ses_...", "model": "claude-opus-5", "source": "...", "compactions": 1 }
}
```

Only changed files are hashed. Files larger than 1 MiB, secret files and handoff infrastructure are skipped. Text hashes normalize CRLF so a handoff saved on one platform still verifies on another.

## Freshness

`handoffmd check` compares the state with the current repository:

1. If `HANDOFF.md` changed after the last save, fail with `HANDOFF_CHANGED`. Run `save --lock` after reviewing the narrative.
2. If `HEAD` moved:
   - When the saved commit is an ancestor of the current `HEAD`, inspect the commits between them. If they touch only handoff files (`HANDOFF.md`, `.handoff/**`, installed skills), the handoff is still fresh.
   - Otherwise fail with `HEAD_MOVED`.
   - When the handoff was saved before the first commit and a first commit now exists, fail with `HEAD_CREATED` unless it contains only handoff files.
   - If the saved commit is no longer an ancestor (rebase, reset, filter), fail with `HISTORY_REWRITTEN`.
3. If the branch differs, warn with `BRANCH_CHANGED`.
4. Compare the saved changed-file set and hashes with the current worktree:
   - recorded file changed → `FILE_DRIFT`
   - recorded file no longer modified → `CHANGES_CLEANED`
   - new worktree change → `NEW_CHANGES`

A handoff is fresh only when the narrative and the repository agree. `save --lock` refreshes the frontmatter `updated`, branch, commit and evidence hash **without touching the narrative**, and marks a reviewed `generated: auto` handoff as `generated: manual`. `save` refreshes evidence and preserves the narrative; `save --rewrite` regenerates both.

## Checks and exit codes

`handoffmd check` verifies:

- frontmatter and required sections;
- placeholder text (`_TODO: ..._`, `TODO`, `TBD`, `<...>`);
- age (`warnAgeDays`, `maxAgeDays`);
- freshness (above);
- secrets in `HANDOFF.md` and `state.json`;
- local Markdown links inside the repository;
- token budget;
- at least one unchecked next step unless `status: done`;
- auto-generated narrative not reviewed;
- unsafe paths (`HANDOFF_UNSAFE`, `STATE_UNSAFE`, `ARCHIVE_UNSAFE`), unreadable or oversized files (`HANDOFF_UNREADABLE`, `HANDOFF_TOO_LARGE`), and secrets in archived handoffs (`SECRET_ARCHIVE`).

Exit codes:

| Code | Meaning |
|---|---|
| `0` | Clean. With `--strict`, also no warnings. |
| `1` | Findings. |
| `2` | Usage, configuration or internal error. |

`--allow-stale` downgrades freshness errors (including `HEAD_CREATED`) to warnings for read-only archives.

`check` returns findings for unsafe, unreadable or oversized files; `show` and `load` exit `2` when they cannot read the file, because they cannot render a brief from it. `--no-secrets` skips the secret scan (not recommended).

## Token budget

`load` estimates tokens as `ceil(characters / 4)` and keeps sections in this order until the budget is exhausted:

`Goal`, `Next steps`, `State`, `Open questions`, `Decisions`, `What didn't work`, `Constraints`, `What changed`, `Evidence`.

If a section does not fit, it is truncated at a paragraph boundary with a pointer to `HANDOFF.md`. `--full` ignores the budget.

## Secret handling

`save` redacts before writing:

- PEM private key blocks;
- GitHub, AWS, Anthropic, OpenAI, Stripe, Slack, Google and npm tokens;
- JWTs and `Authorization: Bearer/Basic` headers;
- passwords embedded in URLs;
- secret-looking `KEY=value` or `KEY: value` assignments.

`check` scans `HANDOFF.md` and `state.json` again and fails on any finding. Redaction is a safety net; review the file before committing.

## Adapter contract

Adapters turn an agent transcript into:

```ts
interface Session {
  agent: "claude" | "codex" | "opencode" | "generic";
  id?: string;
  title?: string;
  model?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  messages: Array<{ role: "user" | "assistant" | "system"; text: string; at?: string }>;
  toolCalls: Array<{ name: string; input?: unknown; output?: string; status?: string }>;
  tests: Array<{ command: string; status: "passed" | "failed" | "unknown"; summary?: string }>;
  compactions: number;
  source: string;
}
```

Adapters must be read-only, tolerate malformed lines, cap memory, and never execute transcript content. `--transcript` accepts Claude/Codex JSONL, a generic role/content JSONL, or a JSON export with a `messages` array.

## Non-goals

- Long-term memory or a vector database.
- A hosted service, account, or sync protocol.
- Replacing the agent's own session resume.
- Storing secrets.
