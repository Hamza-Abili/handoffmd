import { existsSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { handoffPath, readConfig } from "../core/config.ts";
import { CliError } from "../core/errors.ts";
import {
  assertSafeRead,
  assertSafeWrite,
  ensureDir,
  readTextIfExists,
  writeFileInside,
} from "../core/fs.ts";
import { findRepoRoot } from "../core/git.ts";
import { parseHandoff } from "../core/markdown.ts";
import type { Config } from "../core/types.ts";
import { skillTemplate } from "../templates/skill.ts";

export type SkillAgent = "claude" | "codex" | "opencode" | "agents";

export interface CommandContext {
  root: string;
  config: Config;
  file: string;
  color: boolean;
  json: boolean;
  quiet: boolean;
}

export function commandContext(
  cwdFlag: string | undefined,
  options: { json?: boolean; quiet?: boolean; noColor?: boolean } = {},
  allowNonGit = false
): CommandContext {
  const cwd = path.resolve(cwdFlag ?? process.cwd());
  let root: string;
  try {
    root = findRepoRoot(cwd);
  } catch (error) {
    if (!allowNonGit) throw error;
    root = cwd;
  }
  const config = readConfig(root);
  return {
    root,
    config,
    file: handoffPath(root, config),
    color: !options.noColor && !process.env.NO_COLOR && Boolean(process.stdout.isTTY),
    json: Boolean(options.json),
    quiet: Boolean(options.quiet),
  };
}

export function assertOverwritableHandoff(root: string, file: string): void {
  assertSafeWrite(root, file);
  if (!existsSync(file)) return;
  const raw = readTextIfExists(file, 2 * 1024 * 1024) ?? "";
  try {
    parseHandoff(raw);
  } catch {
    throw new CliError(
      `refusing to overwrite ${path.basename(file)}: it is not a valid handoff`,
      2,
      "move the file or choose a different config.file"
    );
  }
}

export function requireHandoff(root: string, file: string): string {
  assertSafeRead(root, file);
  if (!existsSync(file)) {
    throw new CliError(
      `${path.basename(file)} does not exist`,
      1,
      "run `handoffmd init` to create one, or `handoffmd save --manual`"
    );
  }
  return file;
}

function agentBaseDir(agent: SkillAgent, root: string, global: boolean): string {
  if (!global) return path.join(root, `.${agent}`);
  if (agent === "claude") return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
  if (agent === "codex") return process.env.CODEX_HOME || path.join(homedir(), ".codex");
  if (agent === "opencode") {
    return path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), ".config"), "opencode");
  }
  return path.join(homedir(), ".agents");
}

export function parseAgents(raw: string | undefined, root: string, global = false): SkillAgent[] {
  const all: SkillAgent[] = ["claude", "codex", "opencode", "agents"];
  if (!raw || raw === "auto") {
    return all.filter((agent) => existsSync(agentBaseDir(agent, root, global)));
  }
  if (raw === "all") return all;
  const values = raw
    .split(",")
    .map((value) => value.trim().toLowerCase())
    .filter(Boolean);
  for (const value of values) {
    if (!all.includes(value as SkillAgent)) {
      throw new CliError(`unknown agent: ${value}`, 2, `use one of: ${all.join(", ")}`);
    }
  }
  return [...new Set(values)] as SkillAgent[];
}

export function skillPath(agent: SkillAgent, root: string, global: boolean): string {
  if (global) {
    return path.join(agentBaseDir(agent, root, true), "skills", "handoffmd", "SKILL.md");
  }
  return path.join(root, `.${agent}`, "skills", "handoffmd", "SKILL.md");
}

export interface SkillInstallResult {
  agent: SkillAgent;
  file: string;
  changed: boolean;
}

export function installSkills(
  root: string,
  agents: SkillAgent[],
  global: boolean
): SkillInstallResult[] {
  const results: SkillInstallResult[] = [];
  const content = skillTemplate();
  for (const agent of agents) {
    const file = skillPath(agent, root, global);
    const base = global ? agentBaseDir(agent, root, true) : root;
    assertSafeWrite(base, file);
    const previous = existsSync(file) ? requireText(file) : "";
    if (previous !== content) {
      ensureDir(path.dirname(file));
      writeFileInside(base, file, content, 0o644);
      results.push({ agent, file, changed: true });
    } else {
      results.push({ agent, file, changed: false });
    }
  }
  return results;
}

function requireText(file: string): string {
  return readTextIfExists(file, 1024 * 1024) ?? "";
}
