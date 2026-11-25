# Changelog

All notable changes to this project are documented here. The format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [0.1.1] — 2026-11-25

### Added

- Integration tests for `list`, `show`, `prune` and `load`, including stale-handoff refusal, token budgeting and redaction.

### Fixed

- Numeric flags now reject trailing text, fractions and unsafe values instead of silently truncating.

### Changed

- Package metadata declares public npm access and a normalized `bin` path.

## [0.1.0] — 2026-11-25

First release.

### Added

- `handoffmd init`: `HANDOFF.md`, `.handoff/config.json`, archive directory and agent skills.
- `handoffmd save`: capture Claude Code, Codex, OpenCode or generic transcripts plus git evidence.
- `handoffmd save --test <command>`: fresh test evidence with a timeout.
- `handoffmd save --lock`: refresh evidence after a narrative review.
- `handoffmd save --new`: archive the previous handoff and start a new one.
- `handoffmd check`: structure, placeholders, age, freshness, secrets, links and token budget; CI-friendly exit codes.
- `handoffmd load`: token-budgeted brief for Claude Code, Codex, OpenCode or any agent.
- `handoffmd show`, `diff`, `list`, `prune`, `doctor`, `skill`.
- Secret redaction for provider keys, JWTs, authorization headers, URL passwords, private keys and secret-looking assignments.
- Claude Code, Codex and OpenCode adapters; generic JSONL/JSON fallback.
- Zero runtime dependencies; local-only; no telemetry.
- Tests for adapters, redaction, Markdown, tokens and git freshness.
