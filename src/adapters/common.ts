import { closeSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { CliError } from "../core/errors.ts";

export const MAX_TRANSCRIPT_BYTES = 64 * 1024 * 1024;
export const MAX_LINES = 60_000;

export function readJsonl(file: string, maxBytes = MAX_TRANSCRIPT_BYTES): string[] {
  const stat = statSync(file);
  if (stat.size > maxBytes) {
    throw new CliError(
      `transcript is too large (${stat.size} bytes, limit ${maxBytes})`,
      2,
      "pass a smaller file with --transcript"
    );
  }
  const text = readFileSync(file, "utf8");
  const lines = text.split(/\r?\n/).filter((line) => line.trim().length > 0);
  if (lines.length <= MAX_LINES) return lines;
  return [...lines.slice(0, 200), ...lines.slice(-(MAX_LINES - 200))];
}

export function readPrefix(file: string, maxBytes = 64 * 1024): string {
  const fd = openSync(file, "r");
  try {
    const buffer = Buffer.alloc(maxBytes);
    const read = readSync(fd, buffer, 0, maxBytes, 0);
    return buffer.subarray(0, read).toString("utf8");
  } finally {
    closeSync(fd);
  }
}

export function parseJsonLine(line: string): unknown {
  try {
    return JSON.parse(line) as unknown;
  } catch {
    return null;
  }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

export function textFromContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      if (typeof item === "string") return item;
      const record = asRecord(item);
      if (!record) return "";
      if (typeof record.text === "string") return record.text;
      if (typeof record.content === "string") return record.content;
      if (Array.isArray(record.content)) return textFromContent(record.content);
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function toolOutput(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (Array.isArray(value)) {
    return value
      .map((item) => toolOutput(item))
      .filter(Boolean)
      .join("\n");
  }
  const record = asRecord(value);
  if (!record) return String(value);
  for (const key of ["stdout", "stderr", "output", "text", "content", "result"]) {
    const candidate = record[key];
    if (typeof candidate === "string" && candidate.trim()) return candidate;
    if (Array.isArray(candidate)) {
      const text = textFromContent(candidate);
      if (text) return text;
    }
  }
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

export {
  classifyTest,
  isTestCommand,
  testCommandKey,
  testCommandLabel,
  uniqueTests,
} from "../core/test-evidence.ts";

export function iso(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value)) {
    return new Date(value).toISOString();
  }
  if (typeof value === "string") {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return new Date(parsed).toISOString();
  }
  return undefined;
}

export function shortTitle(text: string, fallback = "Untitled handoff"): string {
  const clean = text
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  if (!clean) return fallback;
  const firstLine = clean.split(/[.!?]\s/)[0] ?? clean;
  return firstLine.length > 80 ? `${firstLine.slice(0, 77)}...` : firstLine;
}
