import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { boolFlag, intFlag, stringFlag } from "../core/args.ts";
import { archiveDir } from "../core/config.ts";
import { assertSafeRead, assertSafeWrite, isInside, readTextIfExists } from "../core/fs.ts";
import {
  localLinks,
  parseHandoff,
  placeholderLines,
  REQUIRED_SECTIONS,
  sectionBody,
  uncheckedSteps,
} from "../core/markdown.ts";
import { color, printJson, printLine, symbol } from "../core/output.ts";
import { redactAll, redactValue, scanSecrets } from "../core/redact.ts";
import { checkFreshness, readState } from "../core/state.ts";
import { ageDays as ageInDays, asDate, formatAge } from "../core/time.ts";
import { estimateTokens } from "../core/tokens.ts";
import type { CheckFinding, CheckResult, Config, ParsedHandoff } from "../core/types.ts";
import { commandContext, requireHandoff } from "./shared.ts";

export interface RunCheckOptions {
  strict?: boolean;
  maxAgeDays?: number;
  noSecrets?: boolean;
  allowStale?: boolean;
}

const FRESHNESS_CODES = new Set([
  "HANDOFF_CHANGED",
  "HEAD_MOVED",
  "HEAD_CREATED",
  "HISTORY_REWRITTEN",
  "CHANGES_CLEANED",
  "FILE_DRIFT",
  "NEW_CHANGES",
]);

export function runCheck(
  root: string,
  file: string,
  config: Config,
  options: RunCheckOptions = {}
): CheckResult {
  const findings: CheckFinding[] = [];
  const result: CheckResult = {
    ok: false,
    file: redactAll(file),
    findings,
    tokens: 0,
    ageDays: Number.POSITIVE_INFINITY,
    stale: false,
  };

  const finish = (): CheckResult => {
    for (const finding of findings) {
      finding.message = redactAll(finding.message);
      if (finding.hint) finding.hint = redactAll(finding.hint);
    }
    findings.sort((a, b) => {
      const order = { error: 0, warning: 1, info: 2 } as const;
      return order[a.level] - order[b.level];
    });
    const hasError = findings.some((finding) => finding.level === "error");
    const hasWarning = findings.some((finding) => finding.level === "warning");
    result.ok = !hasError && !(options.strict && hasWarning);
    return result;
  };

  if (!existsSync(file)) {
    findings.push({
      level: "error",
      code: "HANDOFF_MISSING",
      message: "HANDOFF.md does not exist.",
      hint: "run `handoffmd init` or `handoffmd save --manual`",
    });
    return finish();
  }

  try {
    assertSafeRead(root, file);
  } catch (error) {
    findings.push({
      level: "error",
      code: "HANDOFF_UNSAFE",
      message: (error as Error).message,
      hint: "replace the symlink with a real file inside the repository",
    });
    return finish();
  }
  let raw = "";
  try {
    raw = readTextIfExists(file) ?? "";
  } catch (error) {
    const message = (error as Error).message;
    const tooLarge = message.includes("is too large");
    findings.push({
      level: "error",
      code: tooLarge ? "HANDOFF_TOO_LARGE" : "HANDOFF_UNREADABLE",
      message,
      hint: tooLarge
        ? "reduce HANDOFF.md or move detail into linked documents"
        : "check file permissions and re-save the handoff",
    });
    return finish();
  }
  result.tokens = estimateTokens(raw);
  let parsed: ParsedHandoff;
  try {
    parsed = parseHandoff(raw);
  } catch (error) {
    findings.push({
      level: "error",
      code: "STRUCTURE_INVALID",
      message: (error as Error).message,
      hint: "fix the frontmatter or run `handoffmd init --force`",
    });
    return finish();
  }

  result.status = parsed.frontmatter.status;
  const updated = asDate(parsed.frontmatter.updated);
  if (!updated) {
    findings.push({
      level: "error",
      code: "UPDATED_MISSING",
      message: "The frontmatter is missing a valid `updated` timestamp.",
      hint: "run `handoffmd save --lock` or set `updated:` to an ISO timestamp",
    });
  } else {
    result.ageDays = ageInDays(parsed.frontmatter.updated);
  }

  const maxAge = options.maxAgeDays ?? config.maxAgeDays;
  const warnAge =
    options.maxAgeDays !== undefined
      ? maxAge > 0
        ? Math.min(config.warnAgeDays, maxAge)
        : 0
      : config.maxAgeDays === 0
        ? 0
        : config.warnAgeDays;
  if (result.ageDays !== Number.POSITIVE_INFINITY && maxAge > 0 && result.ageDays > maxAge) {
    findings.push({
      level: "error",
      code: "HANDOFF_TOO_OLD",
      message: `HANDOFF.md is ${formatAge(result.ageDays)} old (limit ${maxAge} days).`,
      hint: "re-verify the state and run `handoffmd save`",
    });
  } else if (
    result.ageDays !== Number.POSITIVE_INFINITY &&
    warnAge > 0 &&
    result.ageDays > warnAge
  ) {
    findings.push({
      level: "warning",
      code: "HANDOFF_OLD",
      message: `HANDOFF.md is ${formatAge(result.ageDays)} old.`,
      hint: "confirm the state is still true, then re-save",
    });
  }

  for (const key of REQUIRED_SECTIONS) {
    const body = sectionBody(parsed, key);
    if (!parsed.sections.some((section) => section.key === key)) {
      findings.push({
        level: "error",
        code: `SECTION_MISSING_${key.toUpperCase()}`,
        message: `Missing required section "${headingFor(key)}".`,
        hint: `add a "## ${headingFor(key)}" section`,
      });
      continue;
    }
    if (!body.trim()) {
      findings.push({
        level: "error",
        code: `SECTION_EMPTY_${key.toUpperCase()}`,
        message: `Section "${headingFor(key)}" is empty.`,
      });
    }
    const placeholders = placeholderLines(body);
    if (placeholders.length > 0) {
      findings.push({
        level: "error",
        code: `SECTION_PLACEHOLDER_${key.toUpperCase()}`,
        message: `Section "${headingFor(key)}" still contains a placeholder.`,
        hint: placeholders[0],
      });
    }
  }

  if (parsed.frontmatter.status !== "done") {
    const steps = uncheckedSteps(sectionBody(parsed, "next-steps"));
    if (steps.length === 0) {
      findings.push({
        level: "warning",
        code: "NEXT_STEPS_EMPTY",
        message: "There is no unchecked next step.",
        hint: "add `- [ ] ...` items, or set `status: done`",
      });
    }
  }

  if (parsed.frontmatter.generated === "auto") {
    findings.push({
      level: "warning",
      code: "NARRATIVE_AUTO",
      message: "The narrative was auto-extracted and has not been reviewed.",
      hint: "edit HANDOFF.md, then run `handoffmd save --lock`",
    });
  }

  let state: ReturnType<typeof readState> = null;
  let stateUnsafe = false;
  try {
    state = readState(root);
  } catch (error) {
    stateUnsafe = true;
    findings.push({
      level: "error",
      code: "STATE_UNSAFE",
      message: (error as Error).message,
      hint: "replace the symlink with a real state file inside the repository",
    });
  }
  result.state = state ? redactValue(state) : undefined;
  if (!state && !stateUnsafe) {
    findings.push({
      level: "error",
      code: "STATE_MISSING",
      message: "The evidence state is missing, so freshness cannot be checked.",
      hint: "run `handoffmd save` to create `.handoff/state.json`",
    });
  } else if (state) {
    const freshness = checkFreshness(root, state, raw, config);
    result.stale = freshness.stale;
    for (const finding of freshness.findings) {
      if (options.allowStale && FRESHNESS_CODES.has(finding.code) && finding.level === "error") {
        findings.push({ ...finding, level: "warning" });
      } else {
        findings.push(finding);
      }
    }
    const evidence = sectionBody(parsed, "evidence");
    if (state.session && /no test command detected/i.test(evidence)) {
      findings.push({
        level: "warning",
        code: "TEST_EVIDENCE_MISSING",
        message: "The session has no test evidence in the handoff.",
        hint: 'run the relevant tests and re-save with `--test "<command>"`',
      });
    }
    if (/\*\*failed\*\*/i.test(evidence)) {
      findings.push({
        level: "warning",
        code: "TEST_FAILED",
        message: "The handoff records a failing test command.",
        hint: "fix the failure, or keep status blocked and explain it under State",
      });
    }
  }

  if (!options.noSecrets) {
    const secrets = scanSecrets(raw);
    for (const secret of secrets) {
      findings.push({
        level: "error",
        code: `SECRET_${secret.kind.toUpperCase()}`,
        message: `Possible secret in HANDOFF.md at line ${secret.line}: ${secret.context}`,
        hint: "remove the value or run `handoffmd save` to redact it",
      });
    }
    const archives = archiveDir(root);
    let archiveSafe = true;
    if (existsSync(archives)) {
      try {
        assertSafeWrite(root, path.join(archives, ".keep"));
      } catch {
        archiveSafe = false;
        findings.push({
          level: "error",
          code: "ARCHIVE_UNSAFE",
          message: "The archive directory is a symlink or outside the repository.",
          hint: "replace it with a real directory or remove it",
        });
      }
    }
    if (existsSync(archives) && archiveSafe) {
      for (const name of readdirSync(archives).filter((entry) => entry.endsWith(".md"))) {
        const file = path.join(archives, name);
        try {
          assertSafeWrite(root, file);
        } catch {
          findings.push({
            level: "error",
            code: "ARCHIVE_UNSAFE",
            message: `Archived handoff is a symlink: ${path.relative(root, file)}`,
            hint: "replace it with a real file or remove it",
          });
          continue;
        }
        let raw = "";
        try {
          raw = readTextIfExists(file) ?? "";
        } catch {
          findings.push({
            level: "error",
            code: "ARCHIVE_UNSAFE",
            message: `Archived handoff cannot be read: ${path.relative(root, file)}`,
            hint: "replace it with a smaller real file or remove it",
          });
          continue;
        }
        for (const secret of scanSecrets(raw)) {
          findings.push({
            level: "error",
            code: "SECRET_ARCHIVE",
            message: `Possible secret in archived handoff ${path.relative(root, file)} at line ${secret.line}: ${secret.context}`,
            hint: "delete or redact the archive, or run `handoffmd prune`",
          });
        }
      }
    }
    if (state) {
      const stateSecrets = scanSecrets(JSON.stringify(state));
      if (stateSecrets.length > 0) {
        findings.push({
          level: "error",
          code: "SECRET_STATE",
          message: `Possible secret in .handoff/state.json (${stateSecrets.length} match(es)).`,
          hint: "delete .handoff/state.json and run `handoffmd save`",
        });
      }
    }
  }

  for (const link of localLinks(raw)) {
    const target = link.target.split("#")[0].split("?")[0];
    if (!target) continue;
    const absolute = path.resolve(root, target);
    if (!isInside(root, absolute) || !existsSync(absolute)) {
      findings.push({
        level: "error",
        code: "LINK_BROKEN",
        message: `Local link target does not exist: ${link.target} (line ${link.line}).`,
        hint: "fix the path or remove the link",
      });
    }
  }

  if (result.tokens > config.maxTokens) {
    findings.push({
      level: "error",
      code: "TOKEN_BUDGET",
      message: `HANDOFF.md is ~${result.tokens} tokens (limit ${config.maxTokens}).`,
      hint: "move detail into linked documents, or raise maxTokens in .handoff/config.json",
    });
  }

  return finish();
}

function headingFor(key: string): string {
  return (
    {
      goal: "Goal",
      state: "State",
      "next-steps": "Next steps",
      "open-questions": "Open questions",
      evidence: "Evidence",
    }[key] ?? key
  );
}

export function checkCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const file = requireHandoff(context.root, context.file);
  const maxAge = flags["max-age"] !== undefined ? intFlag(flags, "max-age", 0) : undefined;
  const result = runCheck(context.root, file, context.config, {
    strict: boolFlag(flags, "strict"),
    maxAgeDays: maxAge,
    noSecrets: boolFlag(flags, "no-secrets"),
    allowStale: boolFlag(flags, "allow-stale"),
  });

  if (context.json) {
    printJson(result);
    return result.ok ? 0 : 1;
  }

  if (!context.quiet) {
    const status = result.status ? ` · ${result.status}` : "";
    const repo = result.state
      ? ` · ${redactAll(result.state.repo.branch)}@${result.state.repo.headShort}`
      : "";
    const age =
      result.ageDays === Number.POSITIVE_INFINITY ? "unknown age" : formatAge(result.ageDays);
    printLine(
      `${redactAll(path.basename(file))}${status}${repo} · ${age} · ~${result.tokens.toLocaleString()} tokens`
    );
    for (const finding of result.findings) {
      const level =
        finding.level === "error" ? "error" : finding.level === "warning" ? "warn" : "info";
      printLine(`${symbol(level, context.color)} ${finding.message}`);
      if (finding.hint) printLine(`  ${color(finding.hint, "gray", context.color)}`);
    }
    const errors = result.findings.filter((finding) => finding.level === "error").length;
    const warnings = result.findings.filter((finding) => finding.level === "warning").length;
    if (errors === 0 && warnings === 0) {
      printLine(`${symbol("ok", context.color)} handoff is clean and fresh`);
    } else {
      printLine(
        `${errors === 0 ? symbol("ok", context.color) : symbol("error", context.color)} ` +
          `${errors} error(s), ${warnings} warning(s)`
      );
    }
  }
  return result.ok ? 0 : 1;
}
