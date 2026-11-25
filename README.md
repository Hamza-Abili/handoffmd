# handoffmd

**Your agent forgets. Hand off anyway.**

Verified session handoffs for any coding agent. One `HANDOFF.md`, grounded in git evidence, checked for freshness and secrets, loadable by Claude Code, Codex, OpenCode, or any agent that can read a file.

[![CI](https://github.com/Hamza-Abili/handoffmd/actions/workflows/ci.yml/badge.svg)](https://github.com/Hamza-Abili/handoffmd/actions/workflows/ci.yml)
[![npm](https://img.shields.io/npm/v/%40hamzaabili%2Fhandoffmd)](https://www.npmjs.com/package/@hamzaabili/handoffmd)
[![npm downloads](https://img.shields.io/npm/dt/%40hamzaabili%2Fhandoffmd)](https://www.npmjs.com/package/@hamzaabili/handoffmd)
[![license](https://img.shields.io/badge/license-MIT-blue)](LICENSE)

## The problem

You switch from Claude Code to Codex because a quota ran out, open a fresh session after compaction, move to another machine, or hand the work to a teammate. The next agent starts with none of your context. So you write a `HANDOFF.md` by hand — and it is stale, incomplete, too long, or contains a token you forgot to remove.

Native handoff exists, but it is single-vendor. Memory tools remember everything; they do not tell the next agent what is true **right now**.

`handoffmd` does one job: turn the current session and repository into a handoff that the next agent can trust.

## Quick start

```bash
npx @hamzaabili/handoffmd init
npx @hamzaabili/handoffmd save --from claude
# review HANDOFF.md, then:
npx @hamzaabili/handoffmd save --lock
npx @hamzaabili/handoffmd check --strict

# in the next agent:
npx @hamzaabili/handoffmd load --for codex
```

`init` creates `HANDOFF.md`, `.handoff/config.json` and the agent skill. `save` collects the session and git evidence. `check` verifies structure, freshness, secrets, links and token budget. `load` prints a compact brief for the next agent.

## What it looks like

```text
$ npx @hamzaabili/handoffmd save --from claude
✓ wrote HANDOFF.md from claude ses_01H...
  main@a1b2c3d, 3 changed file(s), ~740 tokens
  ⚠ narrative is auto-extracted; review it before handing off

Next: review HANDOFF.md, then run `handoffmd save --lock` and `handoffmd check --strict`.

$ npx @hamzaabili/handoffmd save --lock
✓ locked HANDOFF.md to main@a1b2c3d

$ npx @hamzaabili/handoffmd check --strict
HANDOFF.md · in-progress · main@a1b2c3d · just now · ~740 tokens
✓ handoff is clean and fresh

$ npx @hamzaabili/handoffmd load --for codex
# Handoff brief

Repository: `/home/you/app`
Branch: `main` at `a1b2c3d`
Status: **in-progress** · updated just now
Target agent: codex
Full handoff: `HANDOFF.md`

## Goal

Fix the OAuth callback so a failed login returns to the original page.

## Next steps

- [ ] Add a regression test for the callback redirect
- [ ] Verify the production callback URL

...
```

## Install

```bash
npm install -g @hamzaabili/handoffmd
# or run it without installing:
npx @hamzaabili/handoffmd --help
```

Requires Node 22 or newer. Zero runtime dependencies. No network calls, no telemetry.

## Commands

| Command | What it does |
|---|---|
| `handoffmd init` | Create `HANDOFF.md`, `.handoff/config.json` and the agent skill |
| `handoffmd save` | Capture a session + git evidence into `HANDOFF.md` |
| `handoffmd check` | Validate structure, freshness, secrets, links and budget (CI gate) |
| `handoffmd load` | Print a compact brief for the next agent |
| `handoffmd show` | Show the current handoff and its evidence |
| `handoffmd diff` | Show what changed since the handoff was saved |
| `handoffmd list` | List current and archived handoffs |
| `handoffmd prune` | Delete old archived handoffs (`--keep`, `--yes`) |
| `handoffmd doctor` | Diagnose setup, sessions and configuration |
| `handoffmd skill` | Print, locate or install the agent skill |

Run `handoffmd help <command>` for every option.

### `save` options that matter

```bash
# the normal flow: create or refresh a handoff from the current agent
npx @hamzaabili/handoffmd save --from claude
npx @hamzaabili/handoffmd save --from codex
npx @hamzaabili/handoffmd save --from opencode

# no transcript available? build from git evidence only
npx @hamzaabili/handoffmd save --manual

# run a test command and record fresh evidence
npx @hamzaabili/handoffmd save --test "bun test"

# after editing the narrative, refresh the evidence hash without touching the text
npx @hamzaabili/handoffmd save --lock

# start a new task, archive the old handoff
npx @hamzaabili/handoffmd save --new

# inspect without writing
npx @hamzaabili/handoffmd save --from claude --dry-run --json
```

`save` preserves the narrative sections you edited. It only refreshes the evidence and frontmatter unless you pass `--rewrite`.

### How it compares

| | handoffmd | manual `HANDOFF.md` | native handoff | memory tools |
|---|---|---|---|---|
| Works across agents | Yes | Yes | No | Varies |
| Repo evidence and file hashes | Yes | No | Partial | No |
| Freshness gate in CI | Yes | No | No | No |
| Secret scan and redaction | Yes | No | No | No |
| Token budget for the next agent | Yes | No | No | No |
| No lock-in | Yes | Yes | Yes | Varies |

The file remains useful if you uninstall the CLI. The CLI adds capture, verification and a compact loader.

## Supported agents

| Agent | Session source | Skill location |
|---|---|---|
| Claude Code | `~/.claude/projects/**/*.jsonl` | `.claude/skills/handoffmd/SKILL.md` |
| Codex | `$CODEX_HOME/sessions/**/*.jsonl` | `.codex/skills/handoffmd/SKILL.md` |
| OpenCode | `$XDG_DATA_HOME/opencode/opencode.db` | `.opencode/skills/handoffmd/SKILL.md` |
| Any other agent | `--transcript <file.jsonl or .json>` | `.agents/skills/handoffmd/SKILL.md` |

Any agent that can read `HANDOFF.md` can consume a handoff. The adapters only automate the capture step.

## Why handoffmd

- **Evidence, not vibes.** Branch, commit, changed files with hashes, commits since the save, and test results. The narrative is still yours; the facts are checked.
- **Freshness gate.** `check` fails when the repository moved, a recorded file changed, new work appeared, or the handoff was edited after the evidence was recorded.
- **Cross-agent by design.** One Markdown file, no vendor API. Switch Claude Code → Codex → OpenCode without re-explaining the task.
- **Secret redaction.** Provider keys, JWTs, authorization headers, URL passwords, private keys and secret-looking `KEY=value` assignments are redacted before writing. `check` scans again.
- **Token budget.** `load` compacts to a configurable budget and keeps the next steps. `check` fails when `HANDOFF.md` grows past `maxTokens`.
- **No daemon, no network, no telemetry.** It reads local transcripts, git and one SQLite database read-only.

## Use it in CI

`check` is designed to fail a pull request when a committed handoff is stale or unsafe:

```yaml
- uses: actions/checkout@v4
- uses: Hamza-Abili/handoffmd@v0.1.1
  with:
    path: .
```

Or run the CLI directly with any Node setup:

```yaml
- uses: actions/checkout@v4
- uses: actions/setup-node@v4
  with:
    node-version: 22
- run: npx @hamzaabili/handoffmd@0.1.1 check --strict
```

`check` exits `0` when clean, `1` on findings, and `2` on usage or internal errors.

## The format

`HANDOFF.md` is plain Markdown with a small frontmatter and five required sections:

```markdown
---
handoff: 1
title: "Fix the OAuth callback"
status: in-progress
updated: 2026-11-25T10:00:00.000Z
branch: "main"
commit: a1b2c3d...
---

# Fix the OAuth callback

## Goal
...

## State
...

## Next steps
- [ ] ...

## Open questions
...

## Evidence
...
```

Optional sections: `Decisions`, `What changed`, `What didn't work`, `Constraints`.
Read the full [format specification](docs/spec.md).

## Recipes

- [Switch from Claude Code to Codex mid-task](docs/recipes.md#switch-agents-mid-task)
- [Hand off before context compaction](docs/recipes.md#before-context-compaction)
- [Continue on another machine](docs/recipes.md#another-machine)
- [Hand off to a human reviewer](docs/recipes.md#hand-off-to-a-human)
- [Gate a pull request in CI](docs/recipes.md#ci-gate)
- [Run parallel worktrees](docs/recipes.md#parallel-worktrees)
- [Orchestrate multiple agents](docs/orchestration.md)

## Security

- Transcripts are read locally and are never uploaded.
- `HANDOFF.md` and `.handoff/state.json` are scanned for secrets; `save` redacts by default.
- `--test <command>` executes a command you explicitly provide, in the repository root. Do not pass untrusted input.
- Redaction is a safety net, not a guarantee. Review the file before committing.
- Read [SECURITY.md](SECURITY.md) for the threat model and reporting process.

## FAQ

**Does it replace agent memory?**
No. Memory stores everything; `handoffmd` captures the current task, the decisions and the next step. Use both.

**Does it work with Cursor, Gemini CLI or a custom agent?**
Yes. Any agent can read `HANDOFF.md` and the output of `handoffmd load`. For automatic capture, pass its transcript with `--transcript`.

**Why not just ask the agent to write a handoff?**
You can. `handoffmd` adds what the agent cannot: a stable format, git evidence, freshness checks, secret scanning, a token budget, and a compact loader for the next agent.

**Does it move my whole session to another agent?**
No. Session-transfer tools replay the transcript; `handoffmd` writes a small, verified brief that any agent can read. Use a transfer tool when you need the full conversation, and `handoffmd` when you need to know what is true now and what to do next. The two are complementary.

**Does it modify my repository?**
It writes `HANDOFF.md`, `.handoff/config.json`, `.handoff/state.json` and the skill file. `init` never overwrites an existing `HANDOFF.md` unless you pass `--force`.

**Is it free?**
MIT. No account, no cloud, no upsell.

## Development

```bash
bun install
bun run ci
```

See [CONTRIBUTING.md](CONTRIBUTING.md). The adapter contract and the file format are documented in [docs/spec.md](docs/spec.md).

## License

MIT © Hamza Abili
