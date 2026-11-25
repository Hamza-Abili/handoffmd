import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCheck } from "../src/commands/check.ts";
import { initCommand } from "../src/commands/init.ts";
import { saveCommand } from "../src/commands/save.ts";
import { readConfig } from "../src/core/config.ts";
import { readTextIfExists } from "../src/core/fs.ts";
import { repoSnapshot } from "../src/core/git.ts";

function makeRepo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-test-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function fillHandoff(dir: string): void {
  const file = path.join(dir, "HANDOFF.md");
  let text = readTextIfExists(file) ?? "";
  text = text.replace(
    "_TODO: describe the concrete outcome this work must achieve, including user-visible behaviour._",
    "Ship a verified handoff."
  );
  text = text.replace(
    "_TODO: summarise what is true now — implemented, broken, unverified._",
    "The flow works; tests pass."
  );
  writeFileSync(file, text);
}

describe("git integration", () => {
  test("snapshot records branch, changes and commits", () => {
    const dir = makeRepo();
    writeFileSync(path.join(dir, "app.txt"), "changed\n");
    const snapshot = repoSnapshot(dir);
    expect(snapshot.branch).toBe("main");
    expect(snapshot.dirty).toBe(true);
    expect(snapshot.changes.map((change) => change.path)).toContain("app.txt");
    expect(snapshot.commits[0].subject).toBe("init");
  });

  test("init, lock, check and stale detection", async () => {
    const dir = makeRepo();
    const initFlags = { cwd: dir, agents: "agents", quiet: true };
    expect(initCommand(initFlags)).toBe(0);
    fillHandoff(dir);
    expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);

    const config = readConfig(dir);
    let result = runCheck(dir, path.join(dir, "HANDOFF.md"), config, { strict: true });
    expect(result.findings.filter((finding) => finding.level === "error")).toHaveLength(0);
    expect(result.ok).toBe(true);

    writeFileSync(path.join(dir, "app.txt"), "changed\n");
    result = runCheck(dir, path.join(dir, "HANDOFF.md"), config);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === "NEW_CHANGES")).toBe(true);

    expect(await saveCommand({ cwd: dir, manual: true, quiet: true })).toBe(0);
    result = runCheck(dir, path.join(dir, "HANDOFF.md"), config);
    expect(result.ok).toBe(true);

    execFileSync("git", ["add", "HANDOFF.md", ".handoff", ".agents"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "docs: handoff"], { cwd: dir });
    result = runCheck(dir, path.join(dir, "HANDOFF.md"), config);
    expect(result.ok).toBe(true);
    expect(result.findings.some((finding) => finding.code === "HEAD_ADVANCED")).toBe(true);
  });

  test("committing source changes after save makes the handoff stale", async () => {
    const dir = makeRepo();
    expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
    fillHandoff(dir);
    expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
    writeFileSync(path.join(dir, "app.txt"), "changed\n");
    expect(await saveCommand({ cwd: dir, manual: true, quiet: true })).toBe(0);
    execFileSync("git", ["add", "app.txt", "HANDOFF.md", ".handoff", ".agents"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "feat: change"], { cwd: dir });
    const config = readConfig(dir);
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), config);
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === "HEAD_MOVED")).toBe(true);
  });
});

describe("unborn HEAD", () => {
  test("detects staged work committed after the handoff", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-unborn-"));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(path.join(dir, "a.txt"), "hello\n");
    execFileSync("git", ["add", "a.txt"], { cwd: dir });
    expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
    fillHandoff(dir);
    expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code === "HEAD_CREATED")).toBe(true);
    const allowed = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir), {
      allowStale: true,
    });
    expect(allowed.ok).toBe(true);
  });
});
