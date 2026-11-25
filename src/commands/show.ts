import path from "node:path";
import { boolFlag, stringFlag } from "../core/args.ts";
import { assertSafeRead, readTextIfExists } from "../core/fs.ts";
import { parseHandoff, sectionBody, uncheckedSteps } from "../core/markdown.ts";
import { printJson, printLine, symbol } from "../core/output.ts";
import { redactAll, redactValue } from "../core/redact.ts";
import { readState } from "../core/state.ts";
import { ageDays, formatAge } from "../core/time.ts";
import { estimateTokens } from "../core/tokens.ts";
import { commandContext, requireHandoff } from "./shared.ts";

export function showCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const file = requireHandoff(context.root, context.file);
  assertSafeRead(context.root, file);
  const raw = readTextIfExists(file) ?? "";
  const parsed = parseHandoff(raw);
  const state = readState(context.root);
  const tokens = estimateTokens(raw);
  const age = parsed.frontmatter.updated ? ageDays(parsed.frontmatter.updated) : Infinity;
  const steps = uncheckedSteps(sectionBody(parsed, "next-steps"));

  if (context.json) {
    printJson({
      ok: true,
      file: redactAll(file),
      frontmatter: redactValue(parsed.frontmatter),
      ageDays: Number.isFinite(age) ? age : null,
      tokens,
      sections: parsed.sections.map((section) => ({
        key: section.key,
        heading: redactAll(section.heading),
        chars: section.body.length,
      })),
      nextSteps: redactValue(steps),
      state: state ? redactValue(state) : null,
    });
    return 0;
  }

  if (!context.quiet) {
    printLine(
      `${redactAll(path.basename(file))} · ${parsed.frontmatter.status} · ${
        Number.isFinite(age) ? formatAge(age) : "unknown age"
      } · ~${tokens.toLocaleString()} tokens`
    );
    printLine(`Title: ${redactAll(parsed.frontmatter.title) || "(untitled)"}`);
    if (state) {
      printLine(
        `State: ${redactAll(state.repo.branch)}@${state.repo.headShort || "unborn"} · ${
          state.changes.length
        } changed file(s) · saved ${formatAge(ageDays(state.savedAt))}`
      );
      if (state.session) {
        printLine(
          `Session: ${state.session.agent}${state.session.id ? ` ${redactAll(state.session.id)}` : ""}${
            state.session.model ? ` · ${redactAll(state.session.model)}` : ""
          }`
        );
      }
    } else {
      printLine(`${symbol("warn", context.color)} no .handoff/state.json (run "handoffmd save")`);
    }
    printLine(
      `Sections: ${parsed.sections.map((section) => redactAll(section.heading)).join(", ")}`
    );
    printLine(`Next steps: ${steps.length} unchecked`);
    for (const step of steps.slice(0, 5)) printLine(`  - [ ] ${redactAll(step)}`);
    if (steps.length > 5) printLine(`  ... and ${steps.length - 5} more`);
  }
  return 0;
}
