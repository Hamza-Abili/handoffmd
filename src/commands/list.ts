import { existsSync, readdirSync, statSync, unlinkSync } from "node:fs";
import path from "node:path";
import { boolFlag, intFlag, stringFlag } from "../core/args.ts";
import { archiveDir } from "../core/config.ts";
import { assertSafeRead, assertSafeWrite, readTextIfExists } from "../core/fs.ts";
import { parseHandoff } from "../core/markdown.ts";
import { printJson, printLine, table } from "../core/output.ts";
import { redactAll } from "../core/redact.ts";
import { ageDays, formatAge } from "../core/time.ts";
import { commandContext } from "./shared.ts";

interface Entry {
  file: string;
  title: string;
  status: string;
  updated: string;
  current: boolean;
}

function archiveFiles(root: string): string[] {
  const dir = archiveDir(root);
  assertSafeWrite(root, path.join(dir, ".keep"));
  if (!existsSync(dir)) return [];
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".md"))
    .map((name) => path.join(dir, name))
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  for (const file of files) assertSafeWrite(root, file);
  return files;
}

export function listCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const entries: Entry[] = [];
  if (existsSync(context.file)) {
    try {
      assertSafeRead(context.root, context.file);
      const parsed = parseHandoff(readTextIfExists(context.file) ?? "");
      entries.push({
        file: context.file,
        title: redactAll(parsed.frontmatter.title),
        status: parsed.frontmatter.status,
        updated: parsed.frontmatter.updated,
        current: true,
      });
    } catch {
      // ignore invalid current file
    }
  }
  for (const file of archiveFiles(context.root)) {
    try {
      const parsed = parseHandoff(readTextIfExists(file) ?? "");
      entries.push({
        file,
        title: redactAll(parsed.frontmatter.title),
        status: parsed.frontmatter.status,
        updated: parsed.frontmatter.updated,
        current: false,
      });
    } catch {
      // ignore invalid archive
    }
  }
  entries.sort((a, b) => Date.parse(b.updated) - Date.parse(a.updated));

  if (context.json) {
    printJson({
      ok: true,
      entries: entries.map((entry) => ({
        ...entry,
        file: redactAll(path.relative(context.root, entry.file)),
        ageDays: Number.isFinite(ageDays(entry.updated)) ? ageDays(entry.updated) : null,
      })),
    });
    return 0;
  }
  if (!context.quiet) {
    if (entries.length === 0) {
      printLine("No handoffs found. Run `handoffmd init`.");
      return 0;
    }
    printLine(
      table([
        ["", "updated", "status", "title", "file"],
        ...entries.map((entry) => [
          entry.current ? "*" : " ",
          Number.isFinite(ageDays(entry.updated)) ? formatAge(ageDays(entry.updated)) : "unknown",
          entry.status,
          entry.title.slice(0, 50),
          redactAll(path.relative(context.root, entry.file)),
        ]),
      ])
    );
  }
  return 0;
}

export function pruneCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const keep = intFlag(flags, "keep", 10);
  const yes = boolFlag(flags, "yes");
  const files = archiveFiles(context.root);
  const remove = files.slice(keep);
  if (context.json) {
    printJson({
      ok: true,
      keep,
      removed: yes ? remove.map((file) => redactAll(path.relative(context.root, file))) : [],
      wouldRemove: yes ? [] : remove.map((file) => redactAll(path.relative(context.root, file))),
    });
    return 0;
  }
  if (remove.length === 0) {
    if (!context.quiet)
      printLine(`Nothing to prune (${files.length} archived handoff(s), keep ${keep}).`);
    return 0;
  }
  if (!yes) {
    printLine(`Would remove ${remove.length} archived handoff(s) (keep ${keep}):`);
    for (const file of remove) printLine(`  ${redactAll(path.relative(context.root, file))}`);
    printLine("Re-run with --yes to delete them.");
    return 0;
  }
  for (const file of remove) {
    try {
      unlinkSync(file);
      if (!context.quiet) printLine(`removed ${redactAll(path.relative(context.root, file))}`);
    } catch (error) {
      process.stderr.write(
        `${redactAll(`handoffmd: cannot remove ${file}: ${(error as Error).message}`)}\n`
      );
      return 1;
    }
  }
  return 0;
}
