import path from "node:path";
import { boolFlag, intFlag, stringFlag } from "../core/args.ts";
import { CliError } from "../core/errors.ts";
import { readTextIfExists } from "../core/fs.ts";
import { parseHandoff, sectionBody } from "../core/markdown.ts";
import { errorLine, printJson, printLine } from "../core/output.ts";
import { redactAll } from "../core/redact.ts";
import { ageDays, formatAge } from "../core/time.ts";
import { estimateTokens, truncateToTokens } from "../core/tokens.ts";
import type { ParsedHandoff } from "../core/types.ts";
import { runCheck } from "./check.ts";
import { commandContext, requireHandoff } from "./shared.ts";

const SECTION_PRIORITY = [
  "goal",
  "next-steps",
  "state",
  "open-questions",
  "decisions",
  "didnt-work",
  "constraints",
  "what-changed",
  "evidence",
];

const HEADINGS: Record<string, string> = {
  goal: "Goal",
  state: "State",
  "next-steps": "Next steps",
  "open-questions": "Open questions",
  decisions: "Decisions",
  "didnt-work": "What didn't work",
  constraints: "Constraints",
  "what-changed": "What changed",
  evidence: "Evidence",
};

function briefHeader(file: string, root: string, parsed: ParsedHandoff, forAgent: string): string {
  const fm = parsed.frontmatter;
  const age = fm.updated ? formatAge(ageDays(fm.updated)) : "unknown age";
  const commit = fm.commit ? fm.commit.slice(0, 7) : "unborn";
  return [
    "# Handoff brief",
    "",
    `Repository: \`${redactAll(root)}\``,
    `Branch: \`${fm.branch ?? "unknown"}\` at \`${commit}\``,
    `Status: **${fm.status}** · updated ${age}`,
    `Target agent: ${forAgent}`,
    `Full handoff: \`${redactAll(path.basename(file))}\``,
  ].join("\n");
}

function instructions(forAgent: string): string {
  const saveFrom = forAgent === "generic" ? "<agent>" : forAgent;
  return [
    "## How to continue",
    "",
    "You are taking over work from another agent.",
    "",
    "1. Verify the current repository state first: `git status`, the branch, and the tests or commands named under Evidence.",
    "2. Continue from the first unchecked next step. Do not redo completed work.",
    '3. Do not retry approaches listed under "What didn\'t work" unless new evidence changes the conclusion.',
    "4. Ask before destructive, irreversible, or out-of-scope actions.",
    "",
    `When you finish or switch again, run \`handoffmd save --from ${saveFrom}\`, review the narrative, then \`handoffmd check --strict && handoffmd save --lock\`.`,
  ].join("\n");
}

export function loadCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const file = requireHandoff(context.root, context.file);
  const raw = readTextIfExists(file) ?? "";
  const parsed = parseHandoff(raw);
  const full = boolFlag(flags, "full");
  const forAgent = stringFlag(flags, "for", "generic") ?? "generic";
  if (!["claude", "codex", "opencode", "generic"].includes(forAgent)) {
    throw new CliError(
      `unknown agent: ${forAgent}`,
      2,
      "use one of: claude, codex, opencode, generic"
    );
  }
  const maxTokens = full
    ? Number.POSITIVE_INFINITY
    : intFlag(flags, "max-tokens", context.config.loadMaxTokens);

  let checkResult = null;
  if (boolFlag(flags, "check")) {
    checkResult = runCheck(context.root, file, context.config);
    if (!checkResult.ok) {
      if (context.json) {
        printJson({ ok: false, check: checkResult });
      } else {
        printLine("refusing to load a stale or invalid handoff:");
        for (const finding of checkResult.findings) {
          printLine(`  - ${finding.message}`);
        }
      }
      return 1;
    }
  } else {
    checkResult = runCheck(context.root, file, context.config);
    const problems = checkResult.findings.filter(
      (finding) => finding.level === "error" || finding.code === "HANDOFF_CHANGED"
    );
    if (problems.length > 0 && !context.quiet) {
      errorLine(
        `handoffmd: warning: the handoff has ${problems.length} problem(s); run \`handoffmd check\``
      );
    }
  }

  const head = briefHeader(file, context.root, parsed, forAgent);
  const footer = boolFlag(flags, "no-instructions") ? "" : instructions(forAgent);
  const selected = SECTION_PRIORITY.map((key) => {
    const section = parsed.sections.find((entry) => entry.key === key);
    if (!section) return null;
    const body = sectionBody(parsed, key);
    if (!body || /^_None\.?_$/i.test(body.trim())) return null;
    return { key, heading: HEADINGS[key] ?? section.heading, body };
  }).filter(
    (section): section is { key: string; heading: string; body: string } => section !== null
  );

  const fixed = `${head}\n\n${footer}`.trim();
  let budget = maxTokens - estimateTokens(fixed);
  const parts: string[] = [];
  const included: string[] = [];
  for (const section of selected) {
    const block = `## ${section.heading}\n\n${section.body}`;
    const cost = estimateTokens(block);
    if (budget <= 0) break;
    if (cost <= budget) {
      parts.push(block);
      included.push(section.key);
      budget -= cost;
    } else {
      const truncated = truncateToTokens(block, budget);
      if (truncated.trim()) {
        parts.push(truncated);
        included.push(section.key);
      }
      budget = 0;
      break;
    }
  }

  let brief = `${[head, ...parts, footer].filter(Boolean).join("\n\n").trimEnd()}\n`;
  if (checkResult?.findings.some((finding) => finding.code.startsWith("SECRET_"))) {
    brief = redactAll(brief);
  }
  if (context.json) {
    printJson({
      ok: true,
      file: redactAll(file),
      for: forAgent,
      brief,
      tokens: estimateTokens(brief),
      maxTokens: Number.isFinite(maxTokens) ? maxTokens : null,
      sections: included,
      stale: checkResult?.stale ?? null,
      warnings: checkResult?.findings.filter((finding) => finding.level !== "info") ?? [],
      check: checkResult ?? undefined,
    });
    return 0;
  }
  process.stdout.write(brief);
  return 0;
}
