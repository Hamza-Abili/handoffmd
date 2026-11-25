export const SKILL_MARKER = "<!-- handoffmd:skill:v1 -->";

export function skillTemplate(): string {
  return `---
name: handoffmd
description: Create, verify, or resume a verified HANDOFF.md when switching coding agents, sessions, machines, or models. Use when context is running low, work is unfinished, a quota is about to run out, or another agent will continue the task.
---
${SKILL_MARKER}

# handoffmd

Use \`npx @hamzaabili/handoffmd\` (or the local \`handoffmd\` binary) to hand work to another agent without losing context.

## When you are handing work off

1. Run \`npx @hamzaabili/handoffmd save --from <claude|codex|opencode> --json\` to collect evidence from the current session and repository.
2. Read the generated \`HANDOFF.md\`. Rewrite the narrative sections so they capture **intent**, **decisions**, **dead ends**, and the **exact next step**. Do not invent facts: every claim must be supported by the session or the repository.
3. Remove anything the next agent can reconstruct from \`git log\` or the code. Keep what cannot be reconstructed.
4. Run \`npx @hamzaabili/handoffmd save --lock\` so the evidence matches the edited file.
5. Run \`npx @hamzaabili/handoffmd check --strict\`. Fix every error before finishing.
6. Tell the user the exact resume command: \`npx @hamzaabili/handoffmd load --for <agent>\`.

## When you are picking work up

1. Run \`npx @hamzaabili/handoffmd check\`. If it is stale, stop and ask the user before trusting it.
2. Run \`npx @hamzaabili/handoffmd load --for <claude|codex|opencode>\` to get the compact brief.
3. Verify the repository state yourself (\`git status\`, tests, the files named in the handoff).
4. Continue from the first unchecked next step. Do not redo completed work or retry approaches listed under "What didn't work".

## Rules

- Never put secrets, tokens, passwords, private keys, or customer data in \`HANDOFF.md\`. The CLI redacts common patterns, but you are responsible for the final file.
- Never overwrite a manual handoff with generated text unless the user asks for \`--rewrite\`.
- Keep \`HANDOFF.md\` under the configured token budget. Link to long evidence instead of pasting it.
- If the handoff is stale, say so explicitly. A stale handoff is worse than no handoff.
`;
}
