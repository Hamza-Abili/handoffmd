import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "../core/errors.ts";
import { realpathSafe } from "../core/fs.ts";
import type { Session, SessionMessage, ToolCall } from "../core/types.ts";
import {
  asArray,
  asRecord,
  asString,
  classifyTest,
  iso,
  isTestCommand,
  parseJsonLine,
  readJsonl,
  shortTitle,
  textFromContent,
  toolOutput,
  uniqueTests,
} from "./common.ts";

export interface AdapterOptions {
  cwd: string;
  session?: string;
  transcript?: string;
  includeSidechains?: boolean;
}

interface Candidate {
  file: string;
  mtime: number;
}

function claudeDir(): string {
  return process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), ".claude");
}

function listSessionFiles(dir: string): Candidate[] {
  if (!existsSync(dir)) return [];
  const files: Candidate[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 2) return;
    let entries: Dirent[];
    try {
      entries = readdirSync(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        walk(full, depth + 1);
      } else if (entry.isFile() && entry.name.endsWith(".jsonl")) {
        try {
          files.push({ file: full, mtime: statSync(full).mtimeMs });
        } catch {
          // ignore
        }
      }
    }
  };
  walk(dir, 0);
  return files.sort((a, b) => b.mtime - a.mtime);
}

function lineCwd(line: string): string | undefined {
  const record = asRecord(parseJsonLine(line));
  const cwd = asString(record?.cwd);
  return cwd;
}

function matchesCwd(sessionCwd: string | undefined, cwd: string): boolean {
  if (!sessionCwd) return false;
  const session = realpathSafe(sessionCwd);
  const root = realpathSafe(cwd);
  return (
    session === root ||
    session.startsWith(`${root}${path.sep}`) ||
    root.startsWith(`${session}${path.sep}`)
  );
}

export function findClaudeFile(options: AdapterOptions): string {
  if (options.transcript) return options.transcript;
  const projects = path.join(claudeDir(), "projects");
  if (!existsSync(projects)) {
    throw new CliError(
      `Claude Code transcripts not found at ${projects}`,
      2,
      "pass --transcript <file> or run handoffmd save --manual"
    );
  }
  const candidates = listSessionFiles(projects);
  if (candidates.length === 0) {
    throw new CliError(
      `no Claude Code sessions found in ${projects}`,
      2,
      "pass --transcript <file> or run handoffmd save --manual"
    );
  }
  const wanted = options.session;
  if (wanted) {
    const byFile = candidates.find((candidate) =>
      candidate.file.toLowerCase().includes(wanted.toLowerCase())
    );
    if (byFile) return byFile.file;
    for (const candidate of candidates.slice(0, 300)) {
      let lines: string[] = [];
      try {
        lines = readJsonl(candidate.file);
      } catch {
        continue;
      }
      for (const line of lines.slice(0, 500)) {
        const record = asRecord(parseJsonLine(line));
        if (asString(record?.sessionId) === wanted) return candidate.file;
      }
    }
    throw new CliError(
      `Claude session '${wanted}' not found`,
      2,
      "pass a session id that exists, or use --transcript <file>"
    );
  }
  for (const candidate of candidates.slice(0, 300)) {
    let lines: string[] = [];
    try {
      lines = readJsonl(candidate.file);
    } catch {
      continue;
    }
    let cwd: string | undefined;
    for (const line of lines.slice(0, 200)) {
      cwd = lineCwd(line);
      if (cwd) break;
    }
    if (matchesCwd(cwd, options.cwd)) return candidate.file;
  }
  throw new CliError(
    `no Claude session matches ${options.cwd}`,
    2,
    "pass --session <id> or --transcript <file>"
  );
}

export function parseClaudeTranscript(file: string, options: AdapterOptions): Session {
  const lines = readJsonl(file);
  const messages: SessionMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const toolsById = new Map<string, ToolCall>();
  let title: string | undefined;
  let model: string | undefined;
  let sessionId: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let compactions = 0;

  const pushMessage = (message: SessionMessage) => {
    messages.push(message);
    if (!startedAt) startedAt = message.at;
    if (message.at) updatedAt = message.at;
  };

  for (const line of lines) {
    const record = asRecord(parseJsonLine(line));
    if (!record) continue;
    if (record.isSidechain === true && !options.includeSidechains) continue;

    sessionId = sessionId ?? asString(record.sessionId);
    cwd = cwd ?? asString(record.cwd);
    const at = iso(record.timestamp);
    if (at) updatedAt = at;

    const type = asString(record.type);
    if (type === "summary") {
      title = asString(record.summary) ?? title;
      continue;
    }
    if (type === "system") {
      const subtype = asString(record.subtype);
      if (
        subtype === "compact_boundary" ||
        asString(record.content)?.toLowerCase().includes("compact")
      ) {
        compactions++;
      }
      continue;
    }
    if (type !== "user" && type !== "assistant") continue;

    const message = asRecord(record.message);
    if (!message) continue;
    const content = message.content;

    if (type === "user") {
      if (record.isMeta === true) continue;
      const text = userText(content);
      if (
        text &&
        !text.startsWith("<local-command-caveat>") &&
        !text.startsWith("<command-name>")
      ) {
        pushMessage({
          role: record.isCompactSummary === true ? "system" : "user",
          text,
          at,
        });
      }
      for (const item of asArray(content)) {
        const part = asRecord(item);
        if (!part) continue;
        if (part.type !== "tool_result") continue;
        const id = asString(part.tool_use_id);
        if (!id) continue;
        const call = toolsById.get(id);
        if (!call) continue;
        const result = record.toolUseResult;
        call.output = toolOutput(result) || textFromContent(part.content);
        call.status = part.is_error === true ? "failed" : "completed";
      }
      continue;
    }

    if (asString(message.model)) model = asString(message.model);
    const parts = asArray(content);
    let text = "";
    for (const item of parts) {
      const part = asRecord(item);
      if (!part) continue;
      if (part.type === "text") {
        text += `${asString(part.text) ?? ""}\n`;
      } else if (part.type === "tool_use") {
        const id = asString(part.id);
        const name = asString(part.name) ?? "unknown";
        const call: ToolCall = { id, name, input: part.input, status: "unknown", at };
        toolCalls.push(call);
        if (id) toolsById.set(id, call);
      }
    }
    if (text.trim()) {
      pushMessage({ role: "assistant", text: text.trim(), at });
    }
  }

  if (!messages.some((message) => message.role === "user" || message.role === "assistant")) {
    throw new CliError(
      "no user or assistant messages found in the Claude transcript",
      2,
      "pass --session <id>, --transcript <file>, or use --manual"
    );
  }

  const tests = collectTests(toolCalls.slice(-50));
  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  return {
    agent: "claude",
    id: sessionId ?? path.basename(file, ".jsonl"),
    title: title ?? shortTitle(firstUser),
    model,
    cwd,
    startedAt,
    updatedAt,
    messages: messages.slice(-300),
    toolCalls: toolCalls.slice(-300),
    tests,
    compactions,
    source: file,
  };
}

function userText(content: unknown): string {
  if (typeof content === "string") return content.trim();
  if (!Array.isArray(content)) return "";
  return content
    .map((item) => {
      const part = asRecord(item);
      if (!part) return "";
      if (part.type === "text") return asString(part.text) ?? "";
      return "";
    })
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function collectTests(toolCalls: ToolCall[]) {
  const tests = [];
  for (const call of toolCalls) {
    if (call.name.toLowerCase() !== "bash") continue;
    const input = asRecord(call.input);
    const command = asString(input?.command);
    if (!command || !isTestCommand(command)) continue;
    tests.push(
      classifyTest(
        command,
        call.output ?? "",
        call.status === "failed",
        call.status === "completed"
      )
    );
  }
  return uniqueTests(tests);
}

export function loadClaudeSession(options: AdapterOptions): Session {
  const file = findClaudeFile(options);
  return parseClaudeTranscript(file, options);
}
