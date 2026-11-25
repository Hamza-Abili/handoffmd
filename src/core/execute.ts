import { spawnSync } from "node:child_process";
import { classifyTest } from "./test-evidence.ts";
import type { TestEvidence } from "./types.ts";

export interface RunTestOptions {
  cwd: string;
  command: string;
  timeoutMs?: number;
  maxBuffer?: number;
}

export function runTestCommand(options: RunTestOptions): TestEvidence {
  const timeout = options.timeoutMs ?? 120_000;
  const shell =
    process.platform === "win32"
      ? { file: "cmd.exe", args: ["/d", "/s", "/c", options.command] }
      : { file: "bash", args: ["-c", options.command] };
  const result = spawnSync(shell.file, shell.args, {
    cwd: options.cwd,
    encoding: "utf8",
    timeout,
    maxBuffer: options.maxBuffer ?? 2 * 1024 * 1024,
    env: { ...process.env, CI: process.env.CI ?? "1" },
  });
  const output = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim();
  const timedOut = result.error && (result.error as NodeJS.ErrnoException).code === "ETIMEDOUT";
  const failed = timedOut || result.status !== 0 || Boolean(result.error);
  const evidence = classifyTest(options.command, output, failed, !failed);
  if (timedOut) {
    return {
      ...evidence,
      status: "failed",
      summary: `timed out after ${Math.round(timeout / 1000)}s`,
    };
  }
  return evidence;
}
