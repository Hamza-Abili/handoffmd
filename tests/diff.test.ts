import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { diffCommand } from "../src/commands/diff.ts";
import { initCommand } from "../src/commands/init.ts";
import { saveCommand } from "../src/commands/save.ts";

const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

async function repo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-diff-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  execFileSync("git", ["checkout", "-b", token], { cwd: dir });
  expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
  const file = path.join(dir, "HANDOFF.md");
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace(
        "_TODO: describe the concrete outcome this work must achieve, including user-visible behaviour._",
        "Ship it."
      )
      .replace("_TODO: summarise what is true now — implemented, broken, unverified._", "Works.")
  );
  expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
  return dir;
}

async function captured(cwd: string, json: boolean): Promise<string> {
  const writes: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    diffCommand({ cwd, json, quiet: false });
  } finally {
    spy.mockRestore();
  }
  return writes.join("");
}

describe("diff redaction", () => {
  test("does not print a token-like branch name", async () => {
    const dir = await repo();
    const text = await captured(dir, false);
    expect(text).not.toContain(token);
    expect(text).toContain("[REDACTED:github_token]");
    const json = await captured(dir, true);
    expect(json).not.toContain(token);
  });
});
