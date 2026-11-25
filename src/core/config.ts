import path from "node:path";
import { assertSafeRead, isInside, matchesGlob, readJsonIfExists, writeFileInside } from "./fs.ts";
import type { Config } from "./types.ts";

export const DEFAULT_CONFIG: Config = {
  version: 1,
  file: "HANDOFF.md",
  maxTokens: 4000,
  loadMaxTokens: 1500,
  warnAgeDays: 7,
  maxAgeDays: 30,
  redact: true,
  include: [],
  exclude: [
    ".env",
    ".env.*",
    "*.pem",
    "*.key",
    "*.p12",
    "*.pfx",
    "id_rsa*",
    "id_ed25519*",
    ".ssh/**",
    "secrets/**",
    "**/secrets/**",
  ],
};

export const HANDOFF_DIR = ".handoff";

export function configPath(root: string): string {
  return path.join(root, HANDOFF_DIR, "config.json");
}

export function statePath(root: string): string {
  return path.join(root, HANDOFF_DIR, "state.json");
}

export function archiveDir(root: string): string {
  return path.join(root, HANDOFF_DIR, "archive");
}

export function handoffPath(root: string, config: Config = DEFAULT_CONFIG): string {
  const file = path.resolve(root, config.file);
  if (!isInside(root, file)) {
    throw new Error("config.file must stay inside the repository");
  }
  return file;
}

function unsafeHandoffFile(file: string): string | null {
  const normalized = file.replaceAll("\\", "/");
  if (!normalized) return "config.file must not be empty";
  if (normalized.startsWith("/") || normalized.startsWith("~") || normalized.startsWith("//")) {
    return "config.file must be a relative path";
  }
  if (/^[A-Za-z]:/.test(normalized)) return "config.file must not use a drive or UNC path";
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) {
    return "config.file must not contain '..' or empty segments";
  }
  if (!/\.md$/i.test(normalized)) return "config.file must point to a .md file";
  const base = parts.at(-1) ?? "";
  if (!/handoff/i.test(base)) return "config.file basename must contain 'handoff'";
  if (parts.some((part) => part.toLowerCase() === ".git")) {
    return "config.file must not point into .git";
  }
  if (parts.some((part) => part.toLowerCase() === HANDOFF_DIR)) {
    return "config.file must not point into .handoff";
  }
  return null;
}

export function readConfig(root: string): Config {
  assertSafeRead(root, configPath(root));
  const raw = readJsonIfExists<Partial<Config>>(configPath(root));
  if (!raw) return { ...DEFAULT_CONFIG };
  const config: Config = { ...DEFAULT_CONFIG, ...raw };
  if (config.version !== 1) {
    throw new Error(`unsupported config version: ${String(config.version)}`);
  }
  if (!config.file || typeof config.file !== "string") {
    throw new Error("config.file must be a string");
  }
  const unsafe = unsafeHandoffFile(config.file);
  if (unsafe) throw new Error(unsafe);
  if (!Array.isArray(config.exclude)) config.exclude = [...DEFAULT_CONFIG.exclude];
  if (!Array.isArray(config.include)) config.include = [];
  for (const key of ["maxTokens", "loadMaxTokens", "warnAgeDays", "maxAgeDays"] as const) {
    if (!Number.isFinite(config[key]) || config[key] < 0) {
      throw new Error(`config.${key} must be a non-negative number`);
    }
  }
  return config;
}

export function writeConfig(root: string, config: Config): void {
  writeFileInside(root, configPath(root), `${JSON.stringify(config, null, 2)}\n`, 0o644);
}

export function isExcluded(config: Config, relative: string): boolean {
  const normalized = relative.replaceAll("\\", "/");
  const base = normalized.split("/").pop() ?? normalized;
  const value = process.platform === "win32" ? normalized.toLowerCase() : normalized;
  const basename = process.platform === "win32" ? base.toLowerCase() : base;
  const patterns =
    process.platform === "win32"
      ? config.exclude.map((pattern) => pattern.toLowerCase())
      : config.exclude;
  if (patterns.some((pattern) => pattern.includes("/") && matchesGlob(pattern, value))) {
    return true;
  }
  if (patterns.some((pattern) => !pattern.includes("/") && matchesGlob(pattern, basename))) {
    return true;
  }
  if (config.include.length > 0) {
    return !config.include.some(
      (pattern) => matchesGlob(pattern, relative) || matchesGlob(`${pattern}/**`, relative)
    );
  }
  return false;
}

export function isHandoffPath(config: Config, relative: string): boolean {
  const normalized = relative.replaceAll("\\", "/");
  return (
    normalized === config.file ||
    normalized.startsWith(`${HANDOFF_DIR}/`) ||
    normalized === HANDOFF_DIR ||
    normalized.startsWith(".claude/skills/handoffmd/") ||
    normalized.startsWith(".codex/skills/handoffmd/") ||
    normalized.startsWith(".opencode/skills/handoffmd/") ||
    normalized.startsWith(".agents/skills/handoffmd/")
  );
}
