import { existsSync } from "node:fs";
import path from "node:path";
import { type AgentSelection, loadSession } from "../adapters/index.ts";
import { boolFlag, stringFlag } from "../core/args.ts";
import { archiveDir, handoffPath, isExcluded, isHandoffPath } from "../core/config.ts";
import { CliError } from "../core/errors.ts";
import { runTestCommand } from "../core/execute.ts";
import {
  assertSafeWrite,
  ensureDir,
  readTextIfExists,
  slugify,
  writeFileInside,
} from "../core/fs.ts";
import { repoSnapshot } from "../core/git.ts";
import { buildDraft, isTemplateHandoff, mergeHandoff, renderDraft } from "../core/handoff.ts";
import { parseHandoff, updateFrontmatter } from "../core/markdown.ts";
import { printJson, printLine, symbol } from "../core/output.ts";
import { redactAll, redactSecrets, redactValue } from "../core/redact.ts";
import { createState, readState, writeState } from "../core/state.ts";
import { estimateTokens } from "../core/tokens.ts";
import type { HandoffStatus, Session, TestEvidence } from "../core/types.ts";
import { assertOverwritableHandoff, commandContext, requireHandoff } from "./shared.ts";

const STATUSES: HandoffStatus[] = ["in-progress", "blocked", "review", "done"];
const FROM_VALUES = ["auto", "claude", "codex", "opencode", "generic", "manual"];

function parseStatus(raw: string | undefined): HandoffStatus | undefined {
  if (raw === undefined) return undefined;
  if (!STATUSES.includes(raw as HandoffStatus)) {
    throw new CliError(`invalid status: ${raw}`, 2, `use one of: ${STATUSES.join(", ")}`);
  }
  return raw as HandoffStatus;
}

function archiveCurrent(root: string, file: string): string | null {
  if (!existsSync(file)) return null;
  assertSafeWrite(root, file);
  const raw = readTextIfExists(file, 2 * 1024 * 1024) ?? "";
  let title = "handoff";
  try {
    title = parseHandoff(raw).frontmatter.title || title;
  } catch {
    // keep default
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const dir = archiveDir(root);
  assertSafeWrite(root, path.join(dir, ".keep"));
  ensureDir(dir);
  let target = path.join(dir, `${stamp}-${slugify(redactAll(title))}.md`);
  if (existsSync(target))
    target = path.join(dir, `${stamp}-${slugify(redactAll(title))}-${Date.now()}.md`);
  writeFileInside(root, target, redactAll(raw), 0o644);
  return target;
}

export async function saveCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): Promise<number> {
  const file = handoffPath(context.root, context.config);
  const lock = boolFlag(flags, "lock");
  const dryRun = boolFlag(flags, "dry-run");
  const noRedact = boolFlag(flags, "no-redact");
  const rewrite = boolFlag(flags, "rewrite") || boolFlag(flags, "new");
  const status = parseStatus(stringFlag(flags, "status"));
  const title = stringFlag(flags, "title");
  const warnings: string[] = [];
  const testCommand = stringFlag(flags, "test");
  const fromRaw = stringFlag(flags, "from", "auto") ?? "auto";
  if (!FROM_VALUES.includes(fromRaw)) {
    throw new CliError(
      `invalid --from value: ${fromRaw}`,
      2,
      `use one of: ${FROM_VALUES.join(", ")}`
    );
  }
  if (lock && testCommand) {
    throw new CliError("--test cannot be combined with --lock", 2);
  }
  if (lock && boolFlag(flags, "new")) {
    throw new CliError("--new cannot be combined with --lock", 2);
  }
  const testTimeout = Number.parseInt(stringFlag(flags, "test-timeout", "120") ?? "120", 10);
  const extraTests: TestEvidence[] = [];
  if (testCommand) {
    if (!Number.isFinite(testTimeout) || testTimeout <= 0) {
      throw new CliError("--test-timeout must be a positive number of seconds", 2);
    }
    if (dryRun) {
      warnings.push("dry-run: test command was not executed");
    } else {
      const evidence = runTestCommand({
        cwd: context.root,
        command: testCommand,
        timeoutMs: testTimeout * 1000,
      });
      extraTests.push(evidence);
      if (evidence.status === "failed") {
        warnings.push(`test command failed: ${testCommand}`);
      } else if (evidence.status === "passed") {
        warnings.push(`test command passed: ${testCommand}`);
      }
    }
  }
  const snapshot = repoSnapshot(context.root, {
    exclude: [context.config.file, ".handoff/**"],
  });
  snapshot.changes = snapshot.changes.filter(
    (change) =>
      !isHandoffPath(context.config, change.path) && !isExcluded(context.config, change.path)
  );
  snapshot.dirty = snapshot.changes.length > 0;
  assertOverwritableHandoff(context.root, file);
  let archived: string | null = null;
  if (boolFlag(flags, "new") && !dryRun) {
    archived = archiveCurrent(context.root, file);
  }

  if (lock) {
    requireHandoff(context.root, file);
    const raw = readTextIfExists(file) ?? "";
    parseHandoff(raw);
    const autoNote =
      "> Auto-extracted from the last agent session. Verify every claim against the repository before continuing.\n";
    const body = raw.replace(autoNote, "");
    const relocked = updateFrontmatter(body, {
      updated: JSON.stringify(new Date().toISOString()),
      branch: JSON.stringify(snapshot.branch),
      commit: snapshot.head,
      generated: "manual",
    });
    const existingState = readState(context.root);
    const state = createState(context.root, relocked, snapshot, null, context.config);
    if (existingState?.session) state.session = existingState.session;
    if (!dryRun) {
      writeFileInside(context.root, file, relocked, 0o644);
      writeState(context.root, state);
    }
    if (context.json) {
      printJson({
        ok: true,
        file,
        locked: !dryRun,
        dryRun,
        archived,
        state: state.repo,
        tokens: estimateTokens(relocked),
      });
      return 0;
    }
    if (!context.quiet) {
      printLine(
        `${symbol("ok", context.color)} ${dryRun ? "would lock" : "locked"} ${redactAll(path.basename(file))} to ${snapshot.branch}@${snapshot.headShort || "unborn"}`
      );
    }
    return 0;
  }

  let session: Session | null = null;
  const manual = boolFlag(flags, "manual") || fromRaw === "manual";
  const from = (fromRaw === "manual" ? "auto" : fromRaw) as AgentSelection;
  if (!manual) {
    try {
      session = await loadSession(from, {
        cwd: context.root,
        session: stringFlag(flags, "session"),
        transcript: stringFlag(flags, "transcript"),
        includeSidechains: boolFlag(flags, "include-sidechains"),
      });
    } catch (error) {
      if (from !== "auto") throw error;
      warnings.push((error as Error).message);
    }
  }

  let existing = existsSync(file) && !rewrite ? parseHandoff(readTextIfExists(file) ?? "") : null;
  if (existing && isTemplateHandoff(existing)) existing = null;
  const generated = session ? "auto" : "manual";
  const draft = buildDraft(session, snapshot, {
    status: status ?? existing?.frontmatter.status ?? "in-progress",
    generated,
    title: title ?? existing?.frontmatter.title,
    tests: extraTests,
  });
  const document = existing
    ? mergeHandoff(existing, draft, snapshot, {
        status,
        title,
        agent: session?.agent,
        session: session?.id,
        generated,
      })
    : draft;
  let rendered = renderDraft(document);
  let redactions = 0;
  if (!noRedact && context.config.redact) {
    const redacted = redactSecrets(rendered);
    rendered = redacted.text;
    redactions = redacted.findings.length;
    if (redactions > 0) {
      warnings.push(
        `redacted ${redactions} possible secret(s); review HANDOFF.md before committing`
      );
    }
  } else if (!noRedact) {
    warnings.push("secret redaction disabled in .handoff/config.json");
  } else {
    warnings.push("secret redaction disabled; `handoffmd check` will still flag secrets");
  }
  if (generated === "auto") {
    warnings.push("narrative is auto-extracted; review it before handing off");
  }
  if (!session && !existing) {
    warnings.push("no agent session found; HANDOFF.md is a manual template");
  }

  const tokens = estimateTokens(rendered);
  if (tokens > context.config.maxTokens) {
    warnings.push(
      `HANDOFF.md is ~${tokens} tokens (limit ${context.config.maxTokens}); shorten it or raise maxTokens`
    );
  }
  const state = createState(context.root, rendered, snapshot, session, context.config);
  if (!dryRun) {
    writeFileInside(context.root, file, rendered, 0o644);
    writeState(context.root, state);
  }

  if (context.json) {
    printJson({
      ok: true,
      file: redactAll(file),
      dryRun,
      archived: archived ? redactAll(archived) : null,
      session: session
        ? {
            agent: session.agent,
            id: session.id ? redactAll(session.id) : undefined,
            model: session.model ? redactAll(session.model) : undefined,
            source: redactAll(session.source),
            messages: session.messages.length,
            tests: session.tests.length,
            compactions: session.compactions,
          }
        : null,
      repo: redactValue(state.repo),
      changes: state.changes.map((change) => redactAll(change.path)),
      redactions,
      tests: extraTests.map((test) => ({
        ...test,
        command: redactAll(test.command),
        summary: test.summary ? redactAll(test.summary) : undefined,
      })),
      tokens,
      warnings: warnings.map((warning) => redactAll(warning)),
      content: dryRun ? rendered : undefined,
    });
    return 0;
  }

  if (!context.quiet) {
    if (archived) {
      printLine(
        `${symbol("ok", context.color)} archived previous handoff to ${redactAll(path.relative(context.root, archived))}`
      );
    }
    const safeId = session?.id ? redactAll(session.id).replace(/[\r\n]/g, " ") : undefined;
    const sessionLabel = session
      ? ` from ${session.agent}${safeId ? ` ${safeId}` : ""}`
      : " from git evidence";
    printLine(
      `${symbol("ok", context.color)} ${dryRun ? "would write" : "wrote"} ${redactAll(path.basename(file))}${sessionLabel}`
    );
    printLine(
      `  ${redactAll(snapshot.branch)}@${snapshot.headShort || "unborn"}, ${snapshot.changes.length} changed file(s), ~${tokens.toLocaleString()} tokens`
    );
    for (const warning of warnings) {
      printLine(`  ${symbol("warn", context.color)} ${redactAll(warning)}`);
    }
    if (!dryRun) {
      printLine("");
      printLine(
        "Next: review HANDOFF.md, then run `handoffmd save --lock` and `handoffmd check --strict`."
      );
    }
  }
  return 0;
}
