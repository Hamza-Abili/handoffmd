import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { doctorCommand } from "../src/commands/doctor.ts";
import { initCommand } from "../src/commands/init.ts";

function repo(): string {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-doctor-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  return dir;
}

async function capturedDoctor(cwd: string): Promise<string> {
  const writes: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  try {
    await doctorCommand({ cwd, json: true });
  } finally {
    spy.mockRestore();
  }
  return writes.join("");
}

const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";

describe("doctor redaction", () => {
  test("does not print a token from invalid frontmatter", async () => {
    const dir = repo();
    expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
    const file = path.join(dir, "HANDOFF.md");
    writeFileSync(
      file,
      readFileSync(file, "utf8").replace("status: in-progress", `status: ${token}`)
    );
    const output = await capturedDoctor(dir);
    expect(output).not.toContain(token);
    expect(output).toContain("invalid handoff status");
  });

  test("does not read a symlinked outside handoff", async () => {
    const dir = repo();
    const outside = mkdtempSync(path.join(tmpdir(), "handoffmd-doctor-outside-"));
    const target = path.join(outside, "outside.md");
    writeFileSync(target, "SECRETVALUE12345");
    mkdirSync(path.join(dir, "src"), { recursive: true });
    symlinkSync(target, path.join(dir, "src", "handoff.md"));
    mkdirSync(path.join(dir, ".handoff"), { recursive: true });
    writeFileSync(
      path.join(dir, ".handoff", "config.json"),
      JSON.stringify({ version: 1, file: "src/handoff.md" })
    );
    const output = await capturedDoctor(dir);
    expect(output).not.toContain("SECRETVALUE12345");
    expect(output).toContain("symlink");
  });

  test("does not print a token used as a session id", async () => {
    const dir = repo();
    expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
    const home = mkdtempSync(path.join(tmpdir(), "handoffmd-doctor-claude-"));
    const project = path.join(home, "projects", "p");
    mkdirSync(project, { recursive: true });
    writeFileSync(
      path.join(project, "s.jsonl"),
      [
        JSON.stringify({
          type: "user",
          sessionId: token,
          cwd: dir,
          message: { role: "user", content: "Fix it" },
          timestamp: "2026-11-25T10:00:00.000Z",
        }),
        JSON.stringify({
          type: "assistant",
          sessionId: token,
          cwd: dir,
          message: {
            model: "claude-opus-5",
            role: "assistant",
            content: [{ type: "text", text: "Done" }],
          },
          timestamp: "2026-11-25T10:00:01.000Z",
        }),
      ].join("\n")
    );
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      const output = await capturedDoctor(dir);
      expect(output).not.toContain(token);
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });
});
