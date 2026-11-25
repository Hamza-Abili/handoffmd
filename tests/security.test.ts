import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { main } from "../src/cli.ts";

const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

import { runCheck } from "../src/commands/check.ts";
import { initCommand } from "../src/commands/init.ts";
import { listCommand, pruneCommand } from "../src/commands/list.ts";
import { loadCommand } from "../src/commands/load.ts";
import { saveCommand } from "../src/commands/save.ts";
import { showCommand } from "../src/commands/show.ts";
import { skillCommand } from "../src/commands/skill.ts";
import { DEFAULT_CONFIG, isExcluded, readConfig } from "../src/core/config.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-security-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

function writeConfig(dir: string, file: string): void {
  mkdirSync(path.join(dir, ".handoff"), { recursive: true });
  writeFileSync(
    path.join(dir, ".handoff", "config.json"),
    `${JSON.stringify({ version: 1, file }, null, 2)}\n`
  );
}

describe("write safety", () => {
  test("rejects a source file as the handoff target", () => {
    const dir = repo();
    writeConfig(dir, "src/index.ts");
    expect(() => readConfig(dir)).toThrow("must point to a .md file");
    expect(() => initCommand({ cwd: dir, quiet: true })).toThrow();
  });

  test("rejects a Markdown file that is not a handoff", () => {
    const dir = repo();
    writeConfig(dir, "README.md");
    expect(() => readConfig(dir)).toThrow("basename must contain");
  });

  test("rejects drive-relative and .git targets", () => {
    const dir = repo();
    writeConfig(dir, "C:handoff.md");
    expect(() => readConfig(dir)).toThrow("drive or UNC");
    writeConfig(dir, ".git/handoff.md");
    expect(() => readConfig(dir)).toThrow(".git");
    writeConfig(dir, "sub/.git/handoff.md");
    expect(() => readConfig(dir)).toThrow(".git");
  });

  test("refuses to overwrite a non-handoff Markdown file", () => {
    const dir = repo();
    writeConfig(dir, "src/handoff-notes.md");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    const target = path.join(dir, "src", "handoff-notes.md");
    writeFileSync(target, "# Real source notes\n");
    expect(() => initCommand({ cwd: dir, force: true, quiet: true })).toThrow(
      "not a valid handoff"
    );
    expect(readFileSync(target, "utf8")).toBe("# Real source notes\n");
  });

  test.skipIf(process.platform === "win32")("refuses a symlinked .handoff directory", () => {
    const dir = repo();
    const outside = mkdtempSync(path.join(tmpdir(), "handoffmd-outside-"));
    symlinkSync(outside, path.join(dir, ".handoff"), "dir");
    expect(() => initCommand({ cwd: dir, quiet: true })).toThrow("symlink");
    expect(existsSync(path.join(outside, "config.json"))).toBe(false);
  });
});

describe("secret path exclusions", () => {
  test("matches secret basenames in nested directories", () => {
    expect(isExcluded(DEFAULT_CONFIG, "sub/.env")).toBe(true);
    expect(isExcluded(DEFAULT_CONFIG, "sub/.env.local")).toBe(true);
    expect(isExcluded(DEFAULT_CONFIG, "certs/server.pem")).toBe(true);
    expect(isExcluded(DEFAULT_CONFIG, "certs/server.key")).toBe(true);
    expect(isExcluded(DEFAULT_CONFIG, "src/index.ts")).toBe(false);
  });
});

describe("archive safety", () => {
  test.skipIf(process.platform === "win32")("refuses a symlinked archive directory", () => {
    const dir = repo();
    const outside = mkdtempSync(path.join(tmpdir(), "handoffmd-archive-outside-"));
    const victim = path.join(outside, "victim.md");
    writeFileSync(victim, "# victim\n");
    mkdirSync(path.join(dir, ".handoff"), { recursive: true });
    symlinkSync(outside, path.join(dir, ".handoff", "archive"), "dir");
    expect(() => pruneCommand({ cwd: dir, keep: "0", yes: true, quiet: true })).toThrow("symlink");
    expect(existsSync(victim)).toBe(true);
    expect(() => listCommand({ cwd: dir, quiet: true })).toThrow("symlink");
  });
});

function validHandoff(title: string): string {
  return `---
handoff: 1
title: "${title}"
status: in-progress
updated: 2026-11-25T10:00:00.000Z
---

# ${title}

## Goal

Do the thing.

## State

In progress.

## Next steps

- [ ] Finish it.

## Open questions

_None._

## Evidence

- Branch: main.
`;
}

describe("handoff read safety", () => {
  test.skipIf(process.platform === "win32")(
    "refuses a handoff symlink outside the repo",
    async () => {
      const dir = repo();
      const outside = mkdtempSync(path.join(tmpdir(), "handoffmd-read-outside-"));
      const target = path.join(outside, "outside.md");
      writeFileSync(target, validHandoff("Outside"));
      mkdirSync(path.join(dir, "src"), { recursive: true });
      symlinkSync(target, path.join(dir, "src", "handoff.md"));
      writeConfig(dir, "src/handoff.md");

      expect(() => showCommand({ cwd: dir, quiet: true })).toThrow("symlink");
      const result = runCheck(dir, path.join(dir, "src", "handoff.md"), readConfig(dir));
      expect(result.findings.some((finding) => finding.code === "HANDOFF_UNSAFE")).toBe(true);

      const archive = path.join(dir, ".handoff", "archive");
      await expect(saveCommand({ cwd: dir, new: true, manual: true, quiet: true })).rejects.toThrow(
        "symlink"
      );
      expect(existsSync(archive) ? readdirSync(archive).length : 0).toBe(0);
      expect(readFileSync(target, "utf8")).toBe(validHandoff("Outside"));
    }
  );

  test("refuses an oversized handoff target before reading it", async () => {
    const dir = repo();
    mkdirSync(path.join(dir, "src"), { recursive: true });
    writeConfig(dir, "src/handoff.md");
    writeFileSync(path.join(dir, "src", "handoff.md"), Buffer.alloc(3 * 1024 * 1024, 97));
    await expect(saveCommand({ cwd: dir, new: true, manual: true, quiet: true })).rejects.toThrow(
      "too large"
    );
  });
});

describe("state read safety", () => {
  test.skipIf(process.platform === "win32")(
    "reports a symlinked state file instead of following it",
    () => {
      const dir = repo();
      expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
      const outside = mkdtempSync(path.join(tmpdir(), "handoffmd-state-outside-"));
      const state = path.join(outside, "state.json");
      writeFileSync(state, JSON.stringify({ token: "SECRETVALUE12345" }));
      symlinkSync(state, path.join(dir, ".handoff", "state.json"));
      const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
      expect(result.findings.some((finding) => finding.code === "STATE_UNSAFE")).toBe(true);
    }
  );
});

describe("public output redaction", () => {
  test("redacts token-like paths in init/load/skill JSON", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), `${token}-`));
    execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
    writeFileSync(path.join(dir, "app.txt"), "hello\n");
    execFileSync("git", ["add", "."], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });

    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      initCommand({ cwd: dir, json: true, agents: "agents", quiet: true });
      loadCommand({ cwd: dir, json: true, quiet: true });
      skillCommand({ cwd: dir, json: true, quiet: true }, ["install", "--agents", "agents"]);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).not.toContain(token);
  });

  test("redacts the existing-handoff warning in init output", () => {
    const dir = repo();
    const file = `${token}-handoff.md`;
    writeConfig(dir, file);
    writeFileSync(path.join(dir, file), "# existing\n");
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      initCommand({ cwd: dir, json: true, quiet: true });
      initCommand({ cwd: dir, json: false, quiet: false });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).not.toContain(token);
  });

  test("redacts a token in the unknown-command error", async () => {
    const writes: string[] = [];
    const spy = spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await main([token]);
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).not.toContain(token);
  });
});
