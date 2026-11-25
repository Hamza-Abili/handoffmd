import { boolFlag, stringFlag } from "../core/args.ts";
import { printJson, printLine, symbol } from "../core/output.ts";
import { redactAll, redactValue } from "../core/redact.ts";
import { diffState, readState } from "../core/state.ts";
import { commandContext } from "./shared.ts";

export function diffCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const state = readState(context.root);
  if (!state) {
    process.stderr.write(
      "handoffmd: no .handoff/state.json; run `handoffmd save` or `handoffmd save --lock` first\n"
    );
    return 1;
  }
  const diff = diffState(context.root, state, context.config);
  if (context.json) {
    printJson({
      ok: true,
      ...redactValue(diff),
      savedAt: state.savedAt,
      savedHead: state.repo.head,
    });
    return 0;
  }
  if (context.quiet) return 0;

  const branch = redactAll(state.repo.branch);
  printLine(`Saved: ${branch}@${state.repo.headShort} (${state.savedAt})`);
  printLine(
    `Now:   ${diff.branchChanged ? "different branch" : branch}@${
      diff.headMoved ? "moved" : state.repo.headShort
    }`
  );
  if (!diff.headMoved && diff.commitsSince.length === 0 && !diff.branchChanged) {
    printLine(`${symbol("ok", context.color)} HEAD has not moved`);
  }
  if (diff.commitsSince.length > 0) {
    printLine("Commits since save:");
    for (const commit of diff.commitsSince.slice(0, 10)) {
      printLine(`  ${commit.sha.slice(0, 7)} ${redactAll(commit.subject)}`);
    }
  }
  if (diff.changedSince.length > 0) {
    printLine("Files changed in those commits:");
    for (const file of diff.changedSince.slice(0, 15)) printLine(`  - ${redactAll(file)}`);
  }
  if (diff.drifted.length > 0) {
    printLine("Files changed since the handoff:");
    for (const file of diff.drifted.slice(0, 15)) printLine(`  - ${redactAll(file)}`);
  }
  if (diff.newChanges.length > 0) {
    printLine("New uncommitted changes:");
    for (const file of diff.newChanges.slice(0, 15)) printLine(`  - ${redactAll(file)}`);
  }
  if (diff.missingChanges.length > 0) {
    printLine("Recorded changes no longer present:");
    for (const file of diff.missingChanges.slice(0, 15)) printLine(`  - ${redactAll(file)}`);
  }
  if (diff.branchChanged) {
    printLine(`${symbol("warn", context.color)} the current branch differs from the saved branch`);
  }
  if (
    diff.commitsSince.length === 0 &&
    diff.changedSince.length === 0 &&
    diff.drifted.length === 0 &&
    diff.newChanges.length === 0 &&
    diff.missingChanges.length === 0 &&
    !diff.branchChanged
  ) {
    printLine(`${symbol("ok", context.color)} no drift`);
  }
  return 0;
}
