import { existsSync, unlinkSync } from "node:fs";
import path from "node:path";
import { boolFlag, stringFlag } from "../core/args.ts";
import {
  archiveDir,
  configPath,
  DEFAULT_CONFIG,
  handoffPath,
  isExcluded,
  isHandoffPath,
  writeConfig,
} from "../core/config.ts";
import { assertSafeWrite, ensureDir, writeFileInside } from "../core/fs.ts";
import { repoSnapshot } from "../core/git.ts";
import { buildDraft, renderDraft } from "../core/handoff.ts";
import { printJson, printLine, symbol } from "../core/output.ts";
import { redactAll } from "../core/redact.ts";
import {
  assertOverwritableHandoff,
  commandContext,
  installSkills,
  parseAgents,
  type SkillInstallResult,
  skillPath,
} from "./shared.ts";

export function initCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): number {
  const force = boolFlag(flags, "force");
  const noSkill = boolFlag(flags, "no-skill");
  const global = boolFlag(flags, "global");
  const file = handoffPath(context.root, context.config);
  const created: string[] = [];
  const warnings: string[] = [];

  if (!existsSync(configPath(context.root))) {
    writeConfig(context.root, DEFAULT_CONFIG);
    created.push(path.relative(context.root, configPath(context.root)));
  }
  assertSafeWrite(context.root, configPath(context.root));
  assertSafeWrite(context.root, path.join(archiveDir(context.root), ".keep"));
  assertSafeWrite(context.root, path.join(context.root, ".handoff", "tmp", ".keep"));
  ensureDir(archiveDir(context.root));
  ensureDir(path.join(context.root, ".handoff", "tmp"));
  const gitignore = path.join(context.root, ".handoff", ".gitignore");
  if (!existsSync(gitignore)) writeFileInside(context.root, gitignore, "tmp/\n", 0o644);

  if (force) assertOverwritableHandoff(context.root, file);
  if (force && existsSync(path.join(context.root, ".handoff", "state.json"))) {
    unlinkSync(path.join(context.root, ".handoff", "state.json"));
    warnings.push("removed the old evidence state because the handoff was reset");
  }
  if (!existsSync(file) || force) {
    const snapshot = repoSnapshot(context.root, {
      exclude: [context.config.file, ".handoff/**"],
    });
    snapshot.changes = snapshot.changes.filter(
      (change) =>
        !isHandoffPath(context.config, change.path) && !isExcluded(context.config, change.path)
    );
    snapshot.dirty = snapshot.changes.length > 0;
    const draft = buildDraft(null, snapshot, {
      status: "in-progress",
      generated: "manual",
    });
    writeFileInside(context.root, file, renderDraft(draft), 0o644);
    created.push(path.relative(context.root, file));
  } else {
    warnings.push(`${path.basename(file)} already exists; left unchanged (use --force to reset)`);
  }

  let skills: SkillInstallResult[] = [];
  if (!noSkill) {
    const agents = parseAgents(stringFlag(flags, "agents"), context.root, global);
    skills = installSkills(context.root, agents, global);
    if (skills.length === 0) {
      warnings.push(
        "no agent directory detected; run `handoffmd skill install --agents claude,codex,opencode`"
      );
    }
  }

  if (context.json) {
    printJson({
      ok: true,
      root: redactAll(context.root),
      file: redactAll(path.relative(context.root, file)),
      created: created.map((entry) => redactAll(entry)),
      skills: skills.map((skill) => ({ ...skill, file: redactAll(skill.file) })),
      warnings: warnings.map((warning) => redactAll(warning)),
    });
    return 0;
  }

  if (!context.quiet) {
    for (const entry of created) {
      printLine(`${symbol("ok", context.color)} created ${redactAll(entry)}`);
    }
    for (const skill of skills) {
      printLine(
        `${symbol(skill.changed ? "ok" : "info", context.color)} ${skill.changed ? "installed" : "unchanged"} skill for ${skill.agent}: ${redactAll(path.relative(context.root, skill.file))}`
      );
    }
    for (const warning of warnings) {
      printLine(`${symbol("warn", context.color)} ${redactAll(warning)}`);
    }
    printLine("");
    printLine("Next:");
    printLine("  1. Edit HANDOFF.md with the real goal, state and next steps.");
    printLine("  2. Run `handoffmd check --strict`.");
    printLine("  3. Commit HANDOFF.md and .handoff/ with the work.");
    printLine("");
    printLine("The skill tells your agent how to save, verify and resume handoffs.");
    if (skills.length === 0) {
      printLine(
        `Skill path (manual install): ${redactAll(path.relative(context.root, skillPath("agents", context.root, false)))}`
      );
    }
  }
  return 0;
}
