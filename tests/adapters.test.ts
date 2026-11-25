import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";
import { copyFileSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { findClaudeFile, parseClaudeTranscript } from "../src/adapters/claude.ts";
import { findCodexFile, parseCodexTranscript } from "../src/adapters/codex.ts";
import { parseGenericTranscript } from "../src/adapters/generic.ts";
import { loadOpenCodeSession } from "../src/adapters/opencode.ts";

const fixture = (name: string) => path.join(import.meta.dir, "fixtures", name);

describe("claude adapter", () => {
  test("normalizes messages, tools, tests and compactions", () => {
    const session = parseClaudeTranscript(fixture("claude.jsonl"), { cwd: "/repo" });
    expect(session.agent).toBe("claude");
    expect(session.id).toBe("sess-claude-1");
    expect(session.title).toBe("Fix auth redirect");
    expect(session.model).toBe("claude-opus-5");
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(session.toolCalls).toHaveLength(1);
    expect(session.toolCalls[0].output).toContain("2 passed");
    expect(session.toolCalls[0].status).toBe("completed");
    expect(session.tests[0].status).toBe("passed");
    expect(session.compactions).toBe(1);
  });
});

describe("claude real-shape fixture", () => {
  test("skips meta and sidechains, keeps compact summary, reads tools", () => {
    const session = parseClaudeTranscript(fixture("claude-real.jsonl"), { cwd: "/repo" });
    expect(session.id).toBe("claude-real-1");
    expect(session.title).toBe("Fix OAuth callback redirect");
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(session.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(session.messages.some((m) => m.text.includes("Subagent sidechain"))).toBe(false);
    expect(session.toolCalls[0].output).toContain("2 passed");
    expect(session.tests[0].status).toBe("passed");
    expect(session.compactions).toBe(1);
  });
});

describe("codex adapter", () => {
  test("parses rollout items and shell command arrays", () => {
    const session = parseCodexTranscript(fixture("codex.jsonl"), { cwd: "/repo" });
    expect(session.agent).toBe("codex");
    expect(session.id).toBe("codex-session-1");
    expect(session.model).toBe("gpt-5.5");
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(1);
    expect(session.toolCalls[0].name).toBe("shell");
    expect(session.toolCalls[0].output).toContain("2 passed");
    expect(session.tests[0].command).toBe("bun test");
    expect(session.tests[0].status).toBe("passed");
    expect(session.compactions).toBe(1);
  });
});

describe("codex real-shape fixture", () => {
  test("supports old untagged messages and new tool items", () => {
    const session = parseCodexTranscript(fixture("codex-real.jsonl"), { cwd: "/repo" });
    expect(session.id).toBe("codex-real-1");
    expect(session.model).toBe("gpt-5.5");
    expect(session.title).toBe("Fix the OAuth callback redirect");
    expect(session.messages.filter((m) => m.role === "user")).toHaveLength(2);
    expect(session.messages.filter((m) => m.role === "assistant")).toHaveLength(2);
    expect(session.messages.filter((m) => m.role === "system")).toHaveLength(1);
    expect(session.toolCalls).toHaveLength(2);
    expect(session.toolCalls[0].output).toContain("2 passed");
    expect(session.tests[0].command).toBe("bun test");
    expect(session.tests[0].status).toBe("passed");
    expect(session.compactions).toBe(1);
  });
});

describe("generic adapter", () => {
  test("reads role/content JSONL", () => {
    const session = parseGenericTranscript(fixture("generic.jsonl"));
    expect(session.agent).toBe("generic");
    expect(session.messages).toHaveLength(2);
    expect(session.messages[0].role).toBe("user");
  });
});

describe("opencode adapter", () => {
  test("reads sessions, parts and tool output from sqlite", async () => {
    const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-opencode-"));
    const dbFile = path.join(dir, "opencode.db");
    const db = new Database(dbFile);
    db.run(
      "CREATE TABLE session_v2 (id TEXT, title TEXT, directory TEXT, path TEXT, model TEXT, time_created INTEGER, time_updated INTEGER)"
    );
    db.run(
      "CREATE TABLE session_message (id TEXT, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT)"
    );
    db.run(
      "CREATE TABLE session_part (message_id TEXT, session_id TEXT, ordinal INTEGER, type TEXT, call_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT)"
    );
    const now = Date.now();
    db.run("INSERT INTO session_v2 VALUES (?,?,?,?,?,?,?)", [
      "ses_test",
      "Fix auth redirect",
      dir,
      dir,
      JSON.stringify({ providerID: "opencode", id: "deepseek-v4" }),
      now - 1000,
      now,
    ]);
    db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
      "m1",
      "ses_test",
      "user",
      1,
      now - 900,
      now - 900,
      JSON.stringify({ text: "Fix the login redirect bug" }),
    ]);
    db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
      "m2",
      "ses_test",
      "assistant",
      2,
      now - 800,
      now - 800,
      JSON.stringify({ model: { providerID: "opencode", id: "deepseek-v4" }, content: [] }),
    ]);
    db.run("INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)", [
      "m2",
      "ses_test",
      1,
      "text",
      null,
      now - 800,
      now - 800,
      JSON.stringify({ type: "text", text: "Tests pass.\n\nNext steps:\n- [ ] Add a test" }),
    ]);
    db.run("INSERT INTO session_part VALUES (?,?,?,?,?,?,?,?)", [
      "m2",
      "ses_test",
      2,
      "tool",
      "call-1",
      now - 700,
      now - 700,
      JSON.stringify({
        type: "tool",
        name: "shell",
        state: {
          status: "completed",
          input: { command: "bun test" },
          content: [{ type: "text", text: "2 passed" }],
        },
      }),
    ]);
    db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
      "m3",
      "ses_test",
      "assistant",
      3,
      now - 650,
      now - 650,
      JSON.stringify({
        model: { providerID: "opencode", id: "deepseek-v4" },
        content: [
          { type: "text", text: "Inline content from session_message." },
          {
            type: "tool",
            id: "call-2",
            name: "shell",
            state: {
              status: "completed",
              input: { command: "bun run typecheck" },
              content: [{ type: "text", text: "no errors" }],
            },
          },
        ],
      }),
    ]);
    db.run("INSERT INTO session_message VALUES (?,?,?,?,?,?,?)", [
      "m4",
      "ses_test",
      "compaction",
      4,
      now - 600,
      now - 600,
      JSON.stringify({ summary: "Compacted summary of the session." }),
    ]);
    db.close();

    const session = await loadOpenCodeSession({ cwd: dir, transcript: dbFile });
    expect(session.agent).toBe("opencode");
    expect(session.id).toBe("ses_test");
    expect(session.model).toBe("opencode/deepseek-v4");
    expect(session.messages.some((m) => m.text.includes("Fix the login"))).toBe(true);
    expect(session.toolCalls[0].output).toContain("2 passed");
    expect(session.toolCalls.some((call) => call.id === "call-2")).toBe(true);
    expect(session.messages.some((message) => message.text.includes("Inline content"))).toBe(true);
    expect(session.messages.some((message) => message.text.includes("Compacted summary"))).toBe(
      true
    );
    expect(session.tests[0].command).toBe("bun test");
    expect(session.compactions).toBe(1);

    const other = mkdtempSync(path.join(tmpdir(), "handoffmd-opencode-other-"));
    await expect(loadOpenCodeSession({ cwd: other, transcript: dbFile })).rejects.toThrow(
      "no OpenCode session matches"
    );
  });
});

describe("session selection", () => {
  test("an explicit missing Claude session does not fall back to cwd", () => {
    const home = mkdtempSync(path.join(tmpdir(), "handoffmd-claude-home-"));
    mkdirSync(path.join(home, "projects", "p1"), { recursive: true });
    copyFileSync(fixture("claude.jsonl"), path.join(home, "projects", "p1", "real.jsonl"));
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      expect(() => findClaudeFile({ cwd: "/repo", session: "nope" })).toThrow(
        "Claude session 'nope' not found"
      );
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test("an explicit missing Codex session does not fall back to cwd", () => {
    const home = mkdtempSync(path.join(tmpdir(), "handoffmd-codex-home-"));
    mkdirSync(path.join(home, "sessions", "2026", "11", "25"), { recursive: true });
    copyFileSync(
      fixture("codex.jsonl"),
      path.join(home, "sessions", "2026", "11", "25", "rollout-real.jsonl")
    );
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = home;
    try {
      expect(() => findCodexFile({ cwd: "/repo", session: "nope" })).toThrow(
        "Codex session 'nope' not found"
      );
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});

describe("oversized transcripts", () => {
  test("discovery skips an oversized candidate and finds the next one", () => {
    const home = mkdtempSync(path.join(tmpdir(), "handoffmd-claude-big-"));
    const dir = path.join(home, "projects", "p1");
    mkdirSync(dir, { recursive: true });
    copyFileSync(fixture("claude.jsonl"), path.join(dir, "real.jsonl"));
    const big = path.join(dir, "big.jsonl");
    writeFileSync(big, "x");
    truncateSync(big, 70 * 1024 * 1024);
    const previous = process.env.CLAUDE_CONFIG_DIR;
    process.env.CLAUDE_CONFIG_DIR = home;
    try {
      expect(findClaudeFile({ cwd: "/repo" })).toContain("real.jsonl");
    } finally {
      if (previous === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previous;
    }
  });

  test("generic parser rejects an oversized file with a clear error", () => {
    const file = path.join(mkdtempSync(path.join(tmpdir(), "handoffmd-generic-big-")), "big.jsonl");
    writeFileSync(file, "x");
    truncateSync(file, 70 * 1024 * 1024);
    expect(() => parseGenericTranscript(file)).toThrow("too large");
  });
});

describe("generic one-line JSONL", () => {
  test("parses a single role/content record", () => {
    const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-generic-one-"));
    const file = path.join(dir, "session.jsonl");
    writeFileSync(file, JSON.stringify({ role: "user", content: "Fix the login bug" }));
    const session = parseGenericTranscript(file);
    expect(session.messages).toHaveLength(1);
    expect(session.messages[0].role).toBe("user");
  });
});
