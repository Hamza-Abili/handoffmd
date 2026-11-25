import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

const cli = path.resolve("dist/cli.js");
const dir = mkdtempSync(path.join(tmpdir(), "handoffmd-smoke-"));

function run(args, options = {}) {
  return execFileSync(process.execPath, [cli, ...args], {
    cwd: dir,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    ...options,
  });
}

try {
  execFileSync("git", ["init", "-q", "-b", "main"], { cwd: dir });
  execFileSync("git", ["config", "user.email", "smoke@example.com"], { cwd: dir });
  execFileSync("git", ["config", "user.name", "Smoke"], { cwd: dir });
  writeFileSync(path.join(dir, "app.txt"), "hello\n");
  execFileSync("git", ["add", "."], { cwd: dir });
  execFileSync("git", ["commit", "-qm", "init"], { cwd: dir });

  run(["init", "--agents", "agents", "--quiet"]);
  const handoff = path.join(dir, "HANDOFF.md");
  let text = readFileSync(handoff, "utf8");
  text = text
    .replace(
      "_TODO: describe the concrete outcome this work must achieve, including user-visible behaviour._",
      "Smoke-test the handoff flow."
    )
    .replace(
      "_TODO: summarise what is true now — implemented, broken, unverified._",
      "The CLI works under Node."
    );
  writeFileSync(handoff, text);

  run(["save", "--lock", "--quiet"]);
  run(["check", "--strict", "--quiet"]);
  const loaded = JSON.parse(run(["load", "--for", "codex", "--json", "--quiet"]));
  if (!loaded.brief.includes("Handoff brief")) throw new Error("load did not produce a brief");

  run(["save", "--manual", "--test", "echo 2 passed", "--quiet"]);
  const result = JSON.parse(run(["check", "--strict", "--json", "--quiet"]));
  if (!result.ok) throw new Error(`check failed: ${JSON.stringify(result.findings)}`);
  if (!result.findings.some((finding) => finding.code === "HEAD_ADVANCED")) {
    // A fresh repo has no extra commits; this is informational only.
  }

  console.log("smoke ok");
} finally {
  rmSync(dir, { recursive: true, force: true });
}
