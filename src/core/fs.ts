import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import path from "node:path";
import { CliError } from "./errors.ts";

export function ensureDir(dir: string): void {
  mkdirSync(dir, { recursive: true });
}

export function readTextIfExists(file: string, maxBytes = 2 * 1024 * 1024): string | null {
  if (!existsSync(file)) return null;
  const stat = statSync(file);
  if (!stat.isFile()) return null;
  if (stat.size > maxBytes) {
    throw new CliError(
      `${file} is too large (${stat.size} bytes, limit ${maxBytes})`,
      2,
      "reduce the file size"
    );
  }
  return readFileSync(file, "utf8");
}

export function readJsonIfExists<T>(file: string): T | null {
  const text = readTextIfExists(file, 4 * 1024 * 1024);
  if (text === null) return null;
  try {
    return JSON.parse(text) as T;
  } catch (error) {
    throw new CliError(
      `cannot parse ${file}: ${(error as Error).message}`,
      2,
      "fix the JSON or delete the file and run handoffmd init"
    );
  }
}

function symlinkComponent(root: string, file: string): string | null {
  const rootRaw = path.resolve(root);
  const target = path.resolve(file);
  if (existsSync(target) && lstatSync(target).isSymbolicLink()) return target;
  let current = path.dirname(target);
  while (current !== rootRaw && current !== path.dirname(current)) {
    if (existsSync(current) && lstatSync(current).isSymbolicLink()) return current;
    current = path.dirname(current);
  }
  return null;
}

function realTarget(file: string): string {
  let current = path.resolve(file);
  const tail: string[] = [];
  while (!existsSync(current)) {
    const parent = path.dirname(current);
    if (parent === current) break;
    tail.unshift(path.basename(current));
    current = parent;
  }
  return path.join(realpathSafe(current), ...tail);
}

export function assertSafeRead(root: string, file: string): void {
  const rootReal = realTarget(root);
  const target = realTarget(file);
  if (!isInside(rootReal, target)) {
    const link = symlinkComponent(root, file);
    throw new CliError(
      link
        ? `refusing to read through a symlink outside the repository: ${file}`
        : `refusing to read outside the repository: ${file}`,
      2
    );
  }
}

export function assertSafeWrite(root: string, file: string): void {
  const rootReal = realTarget(root);
  const rawTarget = path.resolve(file);
  const target = realTarget(file);
  if (!isInside(rootReal, target)) {
    const link = symlinkComponent(root, file);
    throw new CliError(
      link
        ? `refusing to write through a symlink outside the repository: ${file}`
        : `refusing to write outside the repository: ${file}`,
      2
    );
  }
  const innerLink = symlinkComponent(root, file);
  if (innerLink) {
    throw new CliError(`refusing to write through a symlink: ${innerLink}`, 2);
  }
  if (existsSync(rawTarget) && lstatSync(rawTarget).isSymbolicLink()) {
    throw new CliError(`refusing to overwrite a symlink: ${rawTarget}`, 2);
  }
}

export function writeFileInside(root: string, file: string, content: string, mode?: number): void {
  assertSafeWrite(root, file);
  writeFileAtomic(file, content, mode);
}

export function writeFileAtomic(file: string, content: string, mode?: number): void {
  ensureDir(path.dirname(file));
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    writeFileSync(tmp, content, { encoding: "utf8", mode: mode ?? 0o644 });
    renameSync(tmp, file);
  } catch (error) {
    try {
      unlinkSync(tmp);
    } catch {
      // best effort
    }
    throw new CliError(`cannot write ${file}: ${(error as Error).message}`, 2);
  }
}

export function sha256(input: string | Buffer): string {
  return createHash("sha256").update(input).digest("hex");
}

export function fileSha256(file: string): string {
  const buffer = readFileSync(file);
  if (isProbablyBinary(buffer)) return sha256(buffer);
  return sha256(buffer.toString("utf8").replace(/\r\n/g, "\n"));
}

export function isProbablyBinary(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 8192));
  for (const byte of sample) {
    if (byte === 0) return true;
  }
  return false;
}

export function slugify(input: string): string {
  const slug = input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug || "handoff";
}

export function realpathSafe(input: string): string {
  try {
    return realpathSync(input);
  } catch {
    return path.resolve(input);
  }
}

export function isInside(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

export function normalizeRelative(input: string): string | null {
  const normalized = input.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalized === "" || normalized === ".") return null;
  if (normalized.startsWith("/") || /^[A-Za-z]:\//.test(normalized)) return null;
  const parts = normalized.split("/");
  if (parts.some((part) => part === ".." || part === "")) return null;
  return parts.join("/");
}

/**
 * Small glob matcher for the config's include/exclude lists. Supports `*`,
 * `**`, and `?`. It intentionally does not implement brace expansion.
 */
export function matchesGlob(pattern: string, value: string): boolean {
  const normalizedPattern = pattern.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const normalizedValue = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  if (normalizedPattern === normalizedValue) return true;

  let regex = "";
  for (let i = 0; i < normalizedPattern.length; i++) {
    const char = normalizedPattern[i];
    if (char === "*") {
      if (normalizedPattern[i + 1] === "*") {
        regex += ".*";
        i++;
        if (normalizedPattern[i + 1] === "/") i++;
      } else {
        regex += "[^/]*";
      }
    } else if (char === "?") {
      regex += "[^/]";
    } else {
      regex += char.replace(/[.+^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${regex}$`).test(normalizedValue);
}

export function matchesAny(patterns: string[], value: string): boolean {
  return patterns.some((pattern) => matchesGlob(pattern, value));
}
