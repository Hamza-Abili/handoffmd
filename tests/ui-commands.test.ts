import { describe, expect, spyOn, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { initCommand } from "../src/commands/init.ts";
import { listCommand, pruneCommand } from "../src/commands/list.ts";
import { loadCommand } from "../src/commands/load.ts";
import { saveCommand } from "../src/commands/save.ts";
import { showCommand } from "../src/commands/show.ts";

async function preparedRepo(): Promise<string> {
  const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-ui-"));
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });
  expect(initCommand({ cwd: dir, agents: "agents", quiet: true })).toBe(0);
  expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
  return dir;
}

async function preparedReviewedRepo(): Promise<string> {
  const dir = await preparedRepo();
  const file = path.join(dir, "HANDOFF.md");
  writeFileSync(
    file,
    readFileSync(file, "utf8")
      .replace(
        "_TODO: describe the concrete outcome this work must achieve, including user-visible behaviour._",
        "Ship the UI commands."
      )
      .replace(
        "_TODO: summarise what is true now — implemented, broken, unverified._",
        "The flow works."
      )
      .replace(
        "- [ ] Define the next concrete step and verify it against the current repository state.",
        "- [ ] Finish the work."
      )
  );
  expect(await saveCommand({ cwd: dir, lock: true, quiet: true })).toBe(0);
  return dir;
}

async function captureWithCode(
  run: () => number | Promise<number>
): Promise<{ output: string; code: number }> {
  const writes: string[] = [];
  const spy = spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    writes.push(String(chunk));
    return true;
  });
  let code = 0;
  try {
    code = await run();
  } finally {
    spy.mockRestore();
  }
  return { output: writes.join(""), code };
}

async function capture(run: () => number | Promise<number>): Promise<string> {
  return (await captureWithCode(run)).output;
}

describe("list command", () => {
  test("lists current and archived handoffs", async () => {
    const dir = await preparedRepo();
    expect(await saveCommand({ cwd: dir, new: true, manual: true, quiet: true })).toBe(0);
    expect(await saveCommand({ cwd: dir, new: true, manual: true, quiet: true })).toBe(0);

    const output = await capture(() => listCommand({ cwd: dir, json: true, quiet: true }));
    const entries = JSON.parse(output).entries as Array<{ current: boolean; title: string }>;
    expect(entries.length).toBe(3);
    expect(entries.filter((entry) => entry.current)).toHaveLength(1);
    expect(entries.every((entry) => entry.title.length > 0)).toBe(true);

    const human = await capture(() => listCommand({ cwd: dir, quiet: false }));
    expect(human).toContain("HANDOFF.md");
  });
});

describe("show command", () => {
  test("prints structured and human summaries", async () => {
    const dir = await preparedReviewedRepo();
    const output = await capture(() => showCommand({ cwd: dir, json: true, quiet: true }));
    const summary = JSON.parse(output);
    expect(summary.frontmatter.status).toBe("in-progress");
    expect(summary.nextSteps).toContain("Finish the work.");
    expect(summary.tokens).toBeGreaterThan(0);
    expect(summary.state.repo.branch).toBe("main");

    const human = await capture(() => showCommand({ cwd: dir, quiet: false }));
    expect(human).toContain("Next steps: 1 unchecked");
    expect(human).toContain("Finish the work.");
    expect(human).toContain("HANDOFF.md");
  });
});

describe("prune command", () => {
  test("keeps the newest archives and supports a dry run", async () => {
    const dir = await preparedRepo();
    expect(await saveCommand({ cwd: dir, new: true, manual: true, quiet: true })).toBe(0);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await saveCommand({ cwd: dir, new: true, manual: true, quiet: true })).toBe(0);
    const archive = path.join(dir, ".handoff", "archive");
    const before = readdirSync(archive)
      .map((name) => ({ name, mtime: statSync(path.join(archive, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);
    expect(before.length).toBe(2);

    await capture(() => pruneCommand({ cwd: dir, keep: "1", quiet: true }));
    expect(readdirSync(archive).length).toBe(2);

    await capture(() => pruneCommand({ cwd: dir, keep: "1", yes: true, quiet: true }));
    expect(readdirSync(archive)).toEqual([before[0].name]);
  });
});

describe("load command", () => {
  test("prints a compact, agent-targeted brief", async () => {
    const dir = await preparedReviewedRepo();
    const brief = await capture(() => loadCommand({ cwd: dir, for: "codex", quiet: true }));
    expect(brief).toContain("# Handoff brief");
    expect(brief).toContain("Target agent: codex");
    expect(brief).toContain("## Goal");
    expect(brief).toContain("## Next steps");
    expect(brief).toContain("## How to continue");
    expect(brief).toContain("handoffmd save --from codex");
    expect(brief).not.toContain("_TODO:");

    const bare = await capture(() =>
      loadCommand({ cwd: dir, for: "claude", "no-instructions": true, quiet: true })
    );
    expect(bare).not.toContain("## How to continue");
    expect(bare).toContain("Target agent: claude");
  });

  test("honors the token budget and --full", async () => {
    const dir = await preparedReviewedRepo();
    const small = await capture(() => loadCommand({ cwd: dir, "max-tokens": "40", quiet: true }));
    expect(small).toContain("# Handoff brief");
    expect(small).not.toContain("## Goal");

    const full = await capture(() => loadCommand({ cwd: dir, full: true, quiet: true }));
    expect(full).toContain("## Evidence");
  });

  test("refuses a stale handoff with --check but redacts secrets without it", async () => {
    const dir = await preparedReviewedRepo();
    writeFileSync(path.join(dir, "app.txt"), "changed after the handoff\n");
    const refused = await captureWithCode(() =>
      loadCommand({ cwd: dir, check: true, quiet: true })
    );
    expect(refused.code).toBe(1);
    expect(refused.output).toContain("refusing to load a stale or invalid handoff");

    const token = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
    const file = path.join(dir, "HANDOFF.md");
    writeFileSync(file, `${readFileSync(file, "utf8")}\n${token}\n`);
    const output = await capture(() => loadCommand({ cwd: dir, json: true, quiet: true }));
    expect(output).not.toContain(token);
  });

  test("rejects an unknown target agent", async () => {
    const dir = await preparedReviewedRepo();
    expect(() => loadCommand({ cwd: dir, for: "cursor", quiet: true })).toThrow(
      "unknown agent: cursor"
    );
  });
});
