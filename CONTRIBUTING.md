# Contributing

Thanks for helping. This project is intentionally small: one CLI, one file format, no runtime dependencies.

## Setup

- Node 22 or newer
- Bun 1.4 or newer

```bash
bun install
bun run ci
```

`bun run ci` runs lint, typecheck, tests and a production build.

## Tests

```bash
bun test
bun test tests/adapters.test.ts
```

Fixtures live in `tests/fixtures/`. Add a fixture for every new transcript shape. The OpenCode test creates a temporary SQLite database; it does not touch a real one.

## Adding an adapter

1. Add `src/adapters/<agent>.ts` exporting `load<Agent>Session(options): Session | Promise<Session>`.
2. Normalize messages, tool calls, test evidence and compactions to `Session` in `src/core/types.ts`.
3. Be read-only, tolerate malformed lines, cap file size and line count, and never execute transcript content.
4. Add a fixture and a test.
5. Document the paths in `docs/agents.md`.

## Changing the format

`HANDOFF.md` version 1 is a contract. A breaking change needs:

- a new `handoff` version;
- a migration path for existing files;
- an update to `docs/spec.md` and `CHANGELOG.md`;
- tests for old and new files.

## Code style

- TypeScript strict mode.
- Biome formatting and lint.
- Zero runtime dependencies. A dependency needs a strong justification.
- Prefer deletion over abstraction.
- Errors: exit `0` success, `1` findings, `2` usage/internal.
- Never print secrets.

## Pull requests

- Keep the change focused.
- Add or update tests.
- Update docs when behaviour changes.
- Run `bun run ci`.
- Describe the user-visible effect and the rollback path.

## Security

Do not open a public issue for a vulnerability. See [SECURITY.md](SECURITY.md).
