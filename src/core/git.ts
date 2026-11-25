import { execFileSync } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import path from "node:path";
import { CliError } from "./errors.ts";
import { fileSha256, isInside, normalizeRelative, realpathSafe } from "./fs.ts";
import type { FileChange, RepoSnapshot } from "./types.ts";

export function git(cwd: string, args: string[]): string {
  try {
    return execFileSync("git", args, {
      cwd,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      maxBuffer: 32 * 1024 * 1024,
    }).trimEnd();
  } catch (error) {
    const err = error as { stderr?: Buffer | string; message?: string };
    const stderr = err.stderr ? String(err.stderr).trim() : "";
    throw new CliError(
      `git ${args.join(" ")} failed: ${stderr || err.message || "unknown error"}`,
      2,
      "is this a git repository?"
    );
  }
}

export function findRepoRoot(cwd: string): string {
  try {
    const root = git(cwd, ["rev-parse", "--show-toplevel"]);
    return realpathSafe(root);
  } catch {
    throw new CliError(
      "not a git repository",
      2,
      "run handoffmd inside a git repository, or run git init first"
    );
  }
}

export function currentBranch(cwd: string): string {
  try {
    return git(cwd, ["symbolic-ref", "--short", "-q", "HEAD"]);
  } catch {
    return "HEAD";
  }
}

export function currentHead(cwd: string): string {
  try {
    return git(cwd, ["rev-parse", "HEAD"]);
  } catch {
    return "";
  }
}

export function shortSha(sha: string): string {
  return sha.slice(0, 7);
}

function parseNameStatus(output: string): FileChange[] {
  if (!output) return [];
  const fields = output.split("\0").filter(Boolean);
  const changes: FileChange[] = [];
  for (let i = 0; i < fields.length; i++) {
    const status = fields[i];
    if (status.length === 1 && i + 1 < fields.length) {
      const relative = normalizeRelative(fields[++i]);
      if (relative) changes.push({ path: relative, status });
      continue;
    }
    const code = status[0];
    if (code === "R" || code === "C") {
      const from = normalizeRelative(fields[++i] ?? "");
      const to = normalizeRelative(fields[++i] ?? "");
      if (from) changes.push({ path: from, status: `${code} (from)` });
      if (to) changes.push({ path: to, status: code });
      continue;
    }
    const relative = normalizeRelative(fields[++i] ?? "");
    if (relative) changes.push({ path: relative, status: code });
  }
  return changes;
}

function parseUntracked(output: string): FileChange[] {
  return output
    .split("\0")
    .map((entry) => normalizeRelative(entry))
    .filter((entry): entry is string => entry !== null)
    .map((entry) => ({ path: entry, status: "??" }));
}

export interface SnapshotOptions {
  exclude?: string[];
  maxCommits?: number;
}

export function repoSnapshot(cwd: string, options: SnapshotOptions = {}): RepoSnapshot {
  const root = findRepoRoot(cwd);
  const branch = currentBranch(root);
  const head = currentHead(root);
  const commits = head
    ? git(root, ["log", `-n`, String(options.maxCommits ?? 5), "--format=%H%x09%h%x09%s"])
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [sha, short, ...subject] = line.split("\t");
          return { sha, short, subject: subject.join("\t") };
        })
    : [];

  let tracked: FileChange[] = [];
  if (head) {
    tracked = parseNameStatus(git(root, ["diff", "--name-status", "-z", "HEAD"]));
  } else {
    tracked = [
      ...parseNameStatus(git(root, ["diff", "--cached", "--name-status", "-z"])),
      ...parseNameStatus(git(root, ["diff", "--name-status", "-z"])),
    ];
  }
  const untracked = parseUntracked(git(root, ["ls-files", "--others", "--exclude-standard", "-z"]));
  const all = [...tracked, ...untracked];
  const seen = new Set<string>();
  const changes = all.filter((change) => {
    if (seen.has(change.path)) return false;
    seen.add(change.path);
    if (options.exclude?.some((pattern) => matchesPath(pattern, change.path))) return false;
    return true;
  });

  return {
    root,
    branch,
    head,
    headShort: shortSha(head),
    dirty: changes.length > 0,
    changes,
    commits,
  };
}

function matchesPath(pattern: string, value: string): boolean {
  if (pattern === value) return true;
  if (pattern.endsWith("/**")) {
    return value.startsWith(`${pattern.slice(0, -3)}/`);
  }
  if (pattern.startsWith("**/")) {
    return value.endsWith(pattern.slice(3)) || value.includes(`/${pattern.slice(3)}`);
  }
  return false;
}

export function hashChanges(root: string, changes: FileChange[]): FileChange[] {
  return changes.map((change) => {
    const absolute = path.resolve(root, change.path);
    if (!isInside(root, absolute)) return change;
    if (!existsSync(absolute)) return change;
    const stat = lstatSync(absolute);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1024 * 1024) return change;
    try {
      return { ...change, sha256: fileSha256(absolute) };
    } catch {
      return change;
    }
  });
}

export function commitsBetween(cwd: string, from: string, to: string): string[] {
  if (!from || !to || from === to) return [];
  try {
    const output = git(cwd, ["log", "--format=%H", `${from}..${to}`]);
    return output ? output.split("\n") : [];
  } catch {
    return [];
  }
}

export function isAncestor(cwd: string, ancestor: string, descendant: string): boolean {
  if (!ancestor || !descendant) return false;
  try {
    execFileSync("git", ["merge-base", "--is-ancestor", ancestor, descendant], {
      cwd,
      stdio: ["ignore", "ignore", "ignore"],
    });
    return true;
  } catch {
    return false;
  }
}

export function filesAtCommit(cwd: string, sha: string): string[] {
  if (!sha) return [];
  try {
    return git(cwd, ["ls-tree", "-r", "--name-only", "-z", sha])
      .split("\0")
      .map((entry) => normalizeRelative(entry))
      .filter((entry): entry is string => entry !== null);
  } catch {
    return [];
  }
}

export function changedFilesBetween(cwd: string, from: string, to: string): string[] {
  if (!from || !to || from === to) return [];
  try {
    return git(cwd, ["diff", "--name-only", "-z", from, to])
      .split("\0")
      .map((entry) => normalizeRelative(entry))
      .filter((entry): entry is string => entry !== null);
  } catch {
    return [];
  }
}
