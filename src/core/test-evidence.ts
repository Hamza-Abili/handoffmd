import type { TestEvidence } from "./types.ts";

const TEST_PATTERNS = [
  /(?:^|&&|;|\|\|)\s*(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:test|tests|lint|typecheck|type-check|check|build|ci)\b/i,
  /(?:^|&&|;|\|\|)\s*(?:npx|bunx)\s+(?:vitest|jest|tsc|biome|eslint|playwright|prettier)\b/i,
  /(?:^|&&|;|\|\|)\s*(?:vitest|jest|pytest|playwright|tsc|biome|eslint|cargo\s+test|go\s+test|make\s+test)\b/i,
  /(?:^|&&|;|\|\|)\s*python3?\s+-m\s+(?:pytest|unittest)\b/i,
];

export function testCommandLabel(command: string): string {
  const first = command.split("\n")[0]?.trim() ?? "";
  const segments = first
    .split(/&&|;|\|\|/)
    .map((segment) => segment.trim())
    .filter(Boolean);
  const match = segments.find((segment) => TEST_PATTERNS.some((pattern) => pattern.test(segment)));
  return (match ?? first).split("|")[0]?.trim().slice(0, 160) ?? "";
}

export function isTestCommand(command: string): boolean {
  const first = command.split("\n")[0]?.trim() ?? "";
  if (!first || first.length > 220) return false;
  if (first.includes("<<")) return false;
  return TEST_PATTERNS.some((pattern) => pattern.test(first));
}

export function classifyTest(
  command: string,
  output: string,
  failed: boolean,
  completed = false
): TestEvidence {
  const lower = output.toLowerCase();
  let status: TestEvidence["status"] = "unknown";
  if (failed) {
    status = "failed";
  } else if (/\b0\s+(?:failed|failures?)\b/.test(lower) || /\bno errors?\b/.test(lower)) {
    status = "passed";
  } else if (
    /\b[1-9]\d*\s+(?:failed|failures?)\b/.test(lower) ||
    /\b(?:exit code|exit)\s*[1-9]\d*\b/.test(lower) ||
    /\b(?:error|fatal|failed)\b/.test(lower)
  ) {
    status = "failed";
  } else if (/\b(?:passed|success|green|ok)\b/.test(lower)) {
    status = "passed";
  } else if (completed && !output.trim()) {
    status = "passed";
  }
  const summaryLine = output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .find((line) => /\b(?:passed|failed|error|ok|success)\b/i.test(line));
  return {
    command: testCommandLabel(command),
    status,
    summary: summaryLine?.slice(0, 200),
  };
}

export function testCommandKey(command: string): string {
  return testCommandLabel(command)
    .replace(/\s+2>&1.*$/, "")
    .split(/\s+/)
    .slice(0, 3)
    .join(" ");
}

export function uniqueTests(tests: TestEvidence[]): TestEvidence[] {
  const byCommand = new Map<string, TestEvidence>();
  for (const test of tests) byCommand.set(testCommandKey(test.command), test);
  return [...byCommand.values()].slice(-5);
}
