import { describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { installSkills, skillPath } from "../src/commands/shared.ts";
import { SKILL_MARKER, skillTemplate } from "../src/templates/skill.ts";

describe("skill template", () => {
  test("starts with valid frontmatter and keeps the marker", () => {
    const text = skillTemplate();
    expect(text.startsWith("---\n")).toBe(true);
    const end = text.indexOf("\n---\n", 4);
    expect(end).toBeGreaterThan(0);
    const frontmatter = text.slice(4, end);
    expect(frontmatter).toContain("name: handoffmd");
    expect(frontmatter).toMatch(/description: .+/);
    expect(text).toContain(SKILL_MARKER);
  });
});

describe("global skill paths", () => {
  test("honors agent environment variables", () => {
    const base = mkdtempSync(path.join(tmpdir(), "handoffmd-skill-home-"));
    const previousClaude = process.env.CLAUDE_CONFIG_DIR;
    const previousCodex = process.env.CODEX_HOME;
    const previousXdg = process.env.XDG_CONFIG_HOME;
    process.env.CLAUDE_CONFIG_DIR = path.join(base, "claude");
    process.env.CODEX_HOME = path.join(base, "codex");
    process.env.XDG_CONFIG_HOME = path.join(base, "xdg");
    try {
      expect(skillPath("claude", "/repo", true)).toStartWith(path.join(base, "claude"));
      expect(skillPath("codex", "/repo", true)).toStartWith(path.join(base, "codex"));
      expect(skillPath("opencode", "/repo", true)).toStartWith(path.join(base, "xdg"));
      const installed = installSkills("/repo", ["claude"], true);
      expect(installed[0]?.file).toStartWith(path.join(base, "claude"));
      expect(existsSync(installed[0]?.file ?? "")).toBe(true);
    } finally {
      if (previousClaude === undefined) delete process.env.CLAUDE_CONFIG_DIR;
      else process.env.CLAUDE_CONFIG_DIR = previousClaude;
      if (previousCodex === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previousCodex;
      if (previousXdg === undefined) delete process.env.XDG_CONFIG_HOME;
      else process.env.XDG_CONFIG_HOME = previousXdg;
    }
  });
});

describe("skill install safety", () => {
  test("refuses to overwrite an oversized existing skill file", () => {
    const root = mkdtempSync(path.join(tmpdir(), "handoffmd-skill-big-"));
    const file = skillPath("agents", root, false);
    mkdirSync(path.dirname(file), { recursive: true });
    writeFileSync(file, "x".repeat(1024 * 1024 + 1));
    expect(() => installSkills(root, ["agents"], false)).toThrow("too large");
    expect(readFileSync(file, "utf8")).toHaveLength(1024 * 1024 + 1);
  });
});
