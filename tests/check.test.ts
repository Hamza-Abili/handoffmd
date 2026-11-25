import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { runCheck } from "../src/commands/check.ts";
import { initCommand } from "../src/commands/init.ts";
import { saveCommand } from "../src/commands/save.ts";
import { readConfig } from "../src/core/config.ts";
import { runTestCommand } from "../src/core/execute.ts";
import { readTextIfExists } from "../src/core/fs.ts";

async function repo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-check-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
  const file = path.join(dir, "HANDOFF.md");
  const text = (readTextIfExists(file) ?? "")
    .replace(
      "_TODO: describe the concrete outcome this work must achieve, including user-visible behaviour._",
      "Verify the handoff."
    )
    .replace(
      "_TODO: summarise what is true now — implemented, broken, unverified._",
      "Checks work."
    );
  writeFileSync(file, text);
  expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
  return dir;
}

describe("check findings", () => {
  test("accepts CRLF line endings without a false freshness failure", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    const text = readTextIfExists(file) ?? "";
    writeFileSync(file, text.replace(/\n/g, "\r\n"));
    const result = runCheck(dir, file, readConfig(dir));
    expect(result.findings.some((finding) => finding.code === "HANDOFF_CHANGED")).toBe(false);
  });

  test("redacts early STRUCTURE_INVALID findings", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const text = (readTextIfExists(file) ?? "").replace("status: in-progress", `status: ${token}`);
    writeFileSync(file, text);
    const result = runCheck(dir, file, readConfig(dir));
    expect(JSON.stringify(result)).not.toContain(token);
  });

  test("never prints secret values in findings", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    const tokens =
      "ghp_abcdefghijklmnopqrstuvwxyz0123456789 ghp_zyxwvutsrqponmlkjihgfedcba9876543210";
    writeFileSync(file, `${readTextIfExists(file)}\n\n${tokens}\n`);
    const result = runCheck(dir, file, readConfig(dir));
    const output = JSON.stringify(result);
    expect(output).not.toContain("ghp_abcdefghijklmnopqrstuvwxyz0123456789");
    expect(output).not.toContain("ghp_zyxwvutsrqponmlkjihgfedcba9876543210");
  });

  test("detects a secret added after save", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    writeFileSync(file, `${readTextIfExists(file)}\n\nAPI_KEY=AKIAIOSFODNN7EXAMPLE\n`);
    const result = runCheck(dir, file, readConfig(dir));
    expect(result.ok).toBe(false);
    expect(result.findings.some((finding) => finding.code.startsWith("SECRET_"))).toBe(true);
  });

  test("scans archived handoffs for secrets", async () => {
    const dir = await repo();
    const archive = path.join(dir, ".handoff", "archive");
    writeFileSync(path.join(archive, "old.md"), "# old\n\nAPI_KEY=AKIAIOSFODNN7EXAMPLE\n");
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.findings.some((finding) => finding.code === "SECRET_ARCHIVE")).toBe(true);
  });

  test("detects a broken local link", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    writeFileSync(file, `${readTextIfExists(file)}\n\n[missing](does-not-exist.md)\n`);
    const result = runCheck(dir, file, readConfig(dir));
    expect(result.findings.some((finding) => finding.code === "LINK_BROKEN")).toBe(true);
  });

  test("enforces the token budget", async () => {
    const dir = await repo();
    writeFileSync(
      path.join(dir, ".handoff", "config.json"),
      `${JSON.stringify({ ...readConfig(dir), maxTokens: 10 }, null, 2)}\n`
    );
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.findings.some((finding) => finding.code === "TOKEN_BUDGET")).toBe(true);
  });

  test("records fresh test evidence with --test", async () => {
    const dir = await repo();
    expect(
      await saveCommand({
        cwd: dir,
        manual: true,
        test: "echo 2 passed",
        quiet: true,
      })
    ).toBe(0);
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.ok).toBe(true);
    const text = readTextIfExists(path.join(dir, "HANDOFF.md")) ?? "";
    expect(text).toContain("**passed**");
  });

  test("save --lock marks a reviewed auto narrative as manual", async () => {
    const dir = await repo();
    const transcript = path.join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", content: "Fix the redirect" }),
        JSON.stringify({ role: "assistant", content: "Tests pass. Next steps:\n- [ ] Add a test" }),
      ].join("\n")
    );
    expect(
      await saveCommand({
        cwd: dir,
        from: "generic",
        transcript,
        rewrite: true,
        quiet: true,
      })
    ).toBe(0);
    let result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.findings.some((finding) => finding.code === "NARRATIVE_AUTO")).toBe(true);
    expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
    result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.findings.some((finding) => finding.code === "NARRATIVE_AUTO")).toBe(false);
  });

  test("normal save preserves fenced blank lines", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    const marker = "```ts\nconst a = 1;\n\n\nconst b = 2;\n```";
    writeFileSync(file, `${readTextIfExists(file) ?? ""}\n## State\n\n${marker}\n`);
    expect(await saveCommand({ cwd: dir, manual: true, quiet: true })).toBe(0);
    expect(readTextIfExists(file) ?? "").toContain("const a = 1;\n\n\nconst b = 2;");
  });

  test("save --lock preserves the narrative bytes", async () => {
    const dir = await repo();
    const file = path.join(dir, "HANDOFF.md");
    const marker = "```ts\nconst a = 1;\n\n\nconst b = 2;\n```";
    const text = `${readTextIfExists(file) ?? ""}\n## State\n\n${marker}\n`;
    writeFileSync(file, text);
    expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
    const locked = readTextIfExists(file) ?? "";
    expect(locked).toContain("const a = 1;\n\n\nconst b = 2;");
    expect(locked).toContain("generated: manual");
  });

  test("rejects an invalid --from value", async () => {
    const dir = await repo();
    await expect(
      saveCommand({ cwd: dir, from: "cluade", manual: false, quiet: true })
    ).rejects.toThrow("invalid --from value");
  });

  test("--dry-run --new does not write an archive", async () => {
    const dir = await repo();
    const archive = path.join(dir, ".handoff", "archive");
    expect(existsSync(archive) ? readdirSync(archive).length : 0).toBe(0);
    await saveCommand({
      cwd: dir,
      new: true,
      manual: true,
      "dry-run": true,
      test: "echo changed >> app.txt",
      quiet: true,
    });
    expect(existsSync(archive) ? readdirSync(archive).length : 0).toBe(0);
    expect(readFileSync(path.join(dir, "app.txt"), "utf8")).toBe("hello\n");
  });

  test("runs --test before snapshotting the worktree", async () => {
    const dir = await repo();
    await saveCommand({
      cwd: dir,
      manual: true,
      test: "echo changed >> app.txt",
      quiet: true,
    });
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(result.ok).toBe(true);
    expect(readFileSync(path.join(dir, "app.txt"), "utf8")).toContain("changed");
  });

  test("redacts test evidence in save --json", async () => {
    const dir = await repo();
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await saveCommand({
        cwd: dir,
        manual: true,
        json: true,
        test: `echo '${token} 2 passed'`,
        quiet: true,
      });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).not.toContain(token);
  });

  test("does not print the raw session id in human output", async () => {
    const dir = await repo();
    const transcript = path.join(dir, "session.jsonl");
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(
      transcript,
      JSON.stringify({
        id: token,
        messages: [{ role: "user", content: "Fix the login bug" }],
      })
    );
    const writes: string[] = [];
    const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
      writes.push(String(chunk));
      return true;
    });
    try {
      await saveCommand({
        cwd: dir,
        from: "generic",
        transcript,
        rewrite: true,
        quiet: false,
      });
    } finally {
      spy.mockRestore();
    }
    expect(writes.join("")).not.toContain(token);
  });

  test("redacts session metadata in state and archived handoffs", async () => {
    const dir = await repo();
    const transcript = path.join(dir, "session.jsonl");
    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    writeFileSync(
      transcript,
      JSON.stringify({
        id: token,
        model: token,
        messages: [{ role: "user", content: "Fix the login bug" }],
      })
    );
    expect(
      await saveCommand({
        cwd: dir,
        from: "generic",
        transcript,
        rewrite: true,
        quiet: true,
      })
    ).toBe(0);
    const stateText = readTextIfExists(path.join(dir, ".handoff", "state.json")) ?? "";
    expect(stateText).not.toContain(token);
    const result = runCheck(dir, path.join(dir, "HANDOFF.md"), readConfig(dir));
    expect(JSON.stringify(result)).not.toContain(token);

    const handoff = path.join(dir, "HANDOFF.md");
    writeFileSync(handoff, `${readTextIfExists(handoff) ?? ""}\n${token}\n`);
    await saveCommand({ cwd: dir, new: true, manual: true, quiet: true });
    const archive = path.join(dir, ".handoff", "archive");
    for (const name of readdirSync(archive)) {
      expect(readFileSync(path.join(archive, name), "utf8")).not.toContain(token);
    }
  });

  test("redacts secrets from an imported transcript", async () => {
    const dir = await repo();
    const transcript = path.join(dir, "session.jsonl");
    writeFileSync(
      transcript,
      [
        JSON.stringify({ role: "user", content: "Rotate the key" }),
        JSON.stringify({
          role: "assistant",
          content: "Use API_KEY=AKIAIOSFODNN7EXAMPLE for the test.",
        }),
      ].join("\n")
    );
    expect(
      await saveCommand({
        cwd: dir,
        from: "generic",
        transcript,
        rewrite: true,
        quiet: true,
      })
    ).toBe(0);
    const text = readTextIfExists(path.join(dir, "HANDOFF.md")) ?? "";
    expect(text).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(text).toContain("[REDACTED:aws_access_key]");
  });
});

describe("runTestCommand", () => {
  test("captures pass and failure", () => {
    const passed = runTestCommand({ cwd: process.cwd(), command: "echo 2 passed" });
    expect(passed.status).toBe("passed");
    const failed = runTestCommand({ cwd: process.cwd(), command: "exit 1" });
    expect(failed.status).toBe("failed");
    const misleading = runTestCommand({
      cwd: process.cwd(),
      command:
        process.platform === "win32"
          ? "echo 0 failed, no errors & exit 1"
          : "echo '0 failed, no errors'; exit 1",
    });
    expect(misleading.status).toBe("failed");
  });
});
