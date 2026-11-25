# Security

## Reporting a vulnerability

Open a private security advisory on GitHub:
https://github.com/Hamza-Abili/handoffmd/security/advisories/new

Do not open a public issue for a vulnerability. Include the version, a minimal reproduction, and the impact. You will get an acknowledgement and a remediation timeline.

## Threat model

`handoffmd` runs locally with the permissions of the user who invokes it. It reads:

- git metadata and worktree files;
- Claude Code / Codex transcripts;
- the OpenCode SQLite database, read-only;
- `HANDOFF.md`, `.handoff/config.json` and `.handoff/state.json`.

It writes only the handoff, config, state, archive and skill files.

### What it defends against

- **Accidental secret commits.** `save` redacts common provider keys, private keys, JWTs, authorization headers, URL passwords and secret-looking `KEY=value` assignments. `check` scans the handoff and state again.
- **Stale context.** `check` fails when the repository moved, a recorded file changed, new work appeared, or the handoff changed after the evidence was recorded.
- **Untrusted transcript content.** Transcripts are parsed as data. The CLI never executes commands found in a transcript. `--test <command>` executes only a command you explicitly pass on the command line.
- **Path traversal.** File hashes and link checks are restricted to the repository root. `config.file` must be a relative path inside the repository.

### What it does not defend against

- A malicious transcript that causes a misleading narrative. Review `HANDOFF.md` before committing.
- Secrets that do not match a known pattern. Redaction is a safety net, not a guarantee.
- A compromised local account, shell, git binary or Node installation.
- `--test` commands with side effects. They run with your permissions in the repository root.

## Secret handling

- Redacted values are replaced with `[REDACTED:<kind>]`.
- `check` reports the kind, line and a redacted context; it never prints the secret value.
- `.env` files, private keys and common secret paths are excluded from evidence hashing by default.
- `.handoff/state.json` stores relative file paths and the branch name so freshness can be checked; do not put secrets in branch names or filenames. Public command output redacts these fields.
- No network calls and no telemetry.

## Supported versions

Security fixes are provided for the latest minor release.
