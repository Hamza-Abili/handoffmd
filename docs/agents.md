# Agent setup

`handoffmd` works without any agent integration: `HANDOFF.md` is a Markdown file and `handoffmd load` prints a prompt. The skill automates the two workflows — save and resume — so the agent does the right thing without being told every time.

## Install the skill

```bash
npx @hamzaabili/handoffmd init
# or, later:
npx @hamzaabili/handoffmd skill install --agents claude,codex,opencode,agents
```

Project-local paths:

| Agent | Skill |
|---|---|
| Claude Code | `.claude/skills/handoffmd/SKILL.md` |
| Codex | `.codex/skills/handoffmd/SKILL.md` |
| OpenCode | `.opencode/skills/handoffmd/SKILL.md` |
| Portable | `.agents/skills/handoffmd/SKILL.md` |

`--global` writes to the home directory instead. `CLAUDE_CONFIG_DIR`, `CODEX_HOME` and `XDG_CONFIG_HOME` are honored when set:

| Agent | Global skill |
|---|---|
| Claude Code | `~/.claude/skills/handoffmd/SKILL.md` |
| Codex | `~/.codex/skills/handoffmd/SKILL.md` |
| OpenCode | `~/.config/opencode/skills/handoffmd/SKILL.md` |
| Portable | `~/.agents/skills/handoffmd/SKILL.md` |

`npx @hamzaabili/handoffmd skill path --agents all` prints the resolved paths.

## Claude Code

- Transcripts: `~/.claude/projects/<encoded-cwd>/*.jsonl`
- If `CLAUDE_CONFIG_DIR` is set, it is used instead of `~/.claude`.
- Sidechains are skipped by default; `--include-sidechains` includes them.
- Session id: `--session <id>` or the file name.

## Codex

- Transcripts: `$CODEX_HOME/sessions/**/rollout-*.jsonl`
- Archived sessions: `$CODEX_HOME/archived_sessions/**/*.jsonl`
- If `CODEX_HOME` is unset, `~/.codex` is used.
- Session id: `--session <id>` or `session_meta.payload.id`.

## OpenCode

- Database: `$OPENCODE_DB` or `$XDG_DATA_HOME/opencode/opencode.db`
- If `$XDG_DATA_HOME` is unset, `~/.local/share/opencode/opencode.db`.
- The database is opened read-only.
- Requires Node 22.5+ (for `node:sqlite`) or Bun.
- Session id: `--session ses_...`.

OpenCode stores sessions in SQLite. The adapter reads `session_v2`, `session_message` and `session_part`; it never writes.

## Any other agent

Use a transcript file:

```bash
npx @hamzaabili/handoffmd save --from generic --transcript ./session.jsonl
```

Accepted shapes:

- Claude/Codex JSONL (auto-detected by `--from claude|codex`).
- Generic JSONL: `{"role":"user","content":"..."}` per line.
- JSON export: `{"messages":[{"role":"user","content":"..."}]}`.

If there is no transcript, use `--manual`. The handoff is built from git evidence and a narrative template.

## AGENTS.md snippet

If you prefer not to install a skill, add this to `AGENTS.md` or `CLAUDE.md`:

```markdown
## Session handoffs

This repository uses `HANDOFF.md` for session handoffs. When starting work, run
`npx @hamzaabili/handoffmd check` and `npx @hamzaabili/handoffmd load`. When finishing or switching
agents, run `npx @hamzaabili/handoffmd save --from <agent>`, edit the narrative, then run
`npx @hamzaabili/handoffmd save --lock && npx @hamzaabili/handoffmd check --strict`.
```

## What the skill tells the agent

- On handoff: collect evidence, rewrite the narrative around intent/decisions/dead ends/next step, run `save --lock`, then `check --strict`.
- On resume: run `check`; refuse a stale handoff; run `load`; verify the repository; continue from the first unchecked step.
- Never put secrets in the file; never overwrite a manual narrative with generated text unless asked.
