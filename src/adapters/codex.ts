import { type Dirent, existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "../core/errors.ts";
import { realpathSafe } from "../core/fs.ts";
import type { Session, SessionMessage, ToolCall } from "../core/types.ts";
import type { AdapterOptions } from "./claude.ts";
import {
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

function codexDir(): string {
  return process.env.CODEX_HOME || path.join(homedir(), ".codex");
}

interface Candidate {
  file: string;
  mtime: number;
}

function listRollouts(dir: string): Candidate[] {
  if (!existsSync(dir)) return [];
  const files: Candidate[] = [];
  const walk = (current: string, depth: number) => {
    if (depth > 5) return;
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

function matchCwd(sessionCwd: string | undefined, cwd: string): boolean {
  if (!sessionCwd) return false;
  const session = realpathSafe(sessionCwd);
  const root = realpathSafe(cwd);
  return (
    session === root ||
    session.startsWith(`${root}${path.sep}`) ||
    root.startsWith(`${session}${path.sep}`)
  );
}

export function findCodexFile(options: AdapterOptions): string {
  if (options.transcript) return options.transcript;
  const home = codexDir();
  const candidates = [
    ...listRollouts(path.join(home, "sessions")),
    ...listRollouts(path.join(home, "archived_sessions")),
  ].sort((a, b) => b.mtime - a.mtime);
  if (candidates.length === 0) {
    throw new CliError(
      `no Codex sessions found in ${path.join(home, "sessions")}`,
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
      for (const line of lines.slice(0, 20)) {
        const record = asRecord(parseJsonLine(line));
        if (record?.type !== "session_meta") continue;
        const payload = asRecord(record.payload);
        if (asString(payload?.id) === wanted || asString(payload?.session_id) === wanted) {
          return candidate.file;
        }
      }
    }
    throw new CliError(
      `Codex session '${wanted}' not found`,
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
    for (const line of lines.slice(0, 20)) {
      const record = asRecord(parseJsonLine(line));
      if (record?.type !== "session_meta") continue;
      const payload = asRecord(record.payload);
      if (matchCwd(asString(payload?.cwd), options.cwd)) return candidate.file;
    }
  }
  throw new CliError(
    `no Codex session matches ${options.cwd}`,
    2,
    "pass --session <id> or --transcript <file>"
  );
}

function codexCommand(input: unknown): string | undefined {
  const record = asRecord(input);
  if (!record) return undefined;
  const command = record.command ?? record.cmd ?? record.arguments;
  if (typeof command === "string") {
    try {
      const parsed = JSON.parse(command) as unknown;
      if (parsed !== command) return codexCommand(parsed);
    } catch {
      // plain string
    }
    return command;
  }
  if (Array.isArray(command)) {
    const parts = command.filter((part): part is string => typeof part === "string");
    if (parts.length >= 3 && /(?:^|[/\\])(?:ba|z|fi|k|da)?sh$/.test(parts[0])) {
      return parts.slice(2).join(" ");
    }
    return parts.join(" ");
  }
  return undefined;
}

export function parseCodexTranscript(file: string, _options: AdapterOptions): Session {
  const lines = readJsonl(file);
  const messages: SessionMessage[] = [];
  const toolCalls: ToolCall[] = [];
  const toolsById = new Map<string, ToolCall>();
  let id: string | undefined;
  let model: string | undefined;
  let cwd: string | undefined;
  let startedAt: string | undefined;
  let updatedAt: string | undefined;
  let compactedRecords = 0;
  let compactedEvents = 0;

  const seenMessages = new Set<string>();
  const pushMessage = (message: SessionMessage) => {
    const key = `${message.role}:${message.text.slice(0, 240)}`;
    if (seenMessages.has(key)) return;
    seenMessages.add(key);
    messages.push(message);
    if (!startedAt) startedAt = message.at;
    if (message.at) updatedAt = message.at;
  };

  for (const line of lines) {
    const record = asRecord(parseJsonLine(line));
    if (!record) continue;
    const at = iso(record.timestamp);
    if (at) updatedAt = at;
    const type = asString(record.type);
    const payload = asRecord(record.payload);

    if (type === "session_meta") {
      id = id ?? asString(payload?.id) ?? asString(payload?.session_id);
      cwd = cwd ?? asString(payload?.cwd);
      model = model ?? asString(payload?.model) ?? asString(payload?.model_name);
      startedAt = startedAt ?? iso(payload?.timestamp) ?? at;
      continue;
    }

    if (type === "compacted" || type === "compaction") {
      compactedRecords++;
      const summary = asString(payload?.message);
      if (summary) pushMessage({ role: "system", text: summary, at });
      continue;
    }

    if (type === "turn_context") {
      model = asString(payload?.model) ?? model;
      continue;
    }

    if (type === "event_msg") {
      const kind = asString(payload?.type);
      if (kind === "user_message") {
        const text = asString(payload?.message) ?? asString(payload?.text);
        if (text) pushMessage({ role: "user", text, at });
      } else if (kind === "agent_message") {
        const text = asString(payload?.message) ?? asString(payload?.text);
        if (text) pushMessage({ role: "assistant", text, at });
      } else if (kind === "error" || kind === "turn_aborted") {
        const text = asString(payload?.message) ?? kind;
        pushMessage({ role: "system", text, at });
      } else if (kind === "context_compacted" || kind === "compaction") {
        compactedEvents++;
      }
      continue;
    }

    if (type !== "response_item" || !payload) continue;
    const kind = asString(payload.type);
    if (!kind && asString(payload.role)) {
      const role = asString(payload.role);
      const text = textFromContent(payload.content);
      if (text && (role === "user" || role === "assistant")) {
        pushMessage({ role, text, at });
      }
      continue;
    }
    if (kind === "message") {
      const role = asString(payload.role);
      const text = textFromContent(payload.content);
      if (text && (role === "user" || role === "assistant")) {
        pushMessage({ role, text, at });
      }
      continue;
    }
    if (kind === "function_call" || kind === "custom_tool_call") {
      const name = asString(payload.name) ?? asString(payload.tool) ?? "unknown";
      const rawInput = payload.arguments ?? payload.input;
      let input: unknown = rawInput;
      if (typeof rawInput === "string") {
        try {
          input = JSON.parse(rawInput) as unknown;
        } catch {
          input = { command: rawInput };
        }
      }
      const call: ToolCall = {
        id: asString(payload.call_id) ?? asString(payload.id),
        name,
        input,
        status: "unknown",
        at,
      };
      toolCalls.push(call);
      if (call.id) toolsById.set(call.id, call);
      continue;
    }
    if (kind === "function_call_output" || kind === "custom_tool_call_output") {
      const callId = asString(payload.call_id) ?? asString(payload.id);
      if (!callId) continue;
      const call = toolsById.get(callId);
      if (!call) continue;
      const output = toolOutput(payload.output ?? payload.result);
      call.output = output;
      call.status = /\b(?:exit code [1-9]|error:|failed)\b/i.test(output) ? "failed" : "completed";
    }
  }

  if (!messages.some((message) => message.role === "user" || message.role === "assistant")) {
    throw new CliError(
      "no user or assistant messages found in the Codex transcript",
      2,
      "pass --session <id>, --transcript <file>, or use --manual"
    );
  }

  const tests = [];
  for (const call of toolCalls.slice(-50)) {
    const command = codexCommand(call.input);
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
  const dedupedTests = uniqueTests(tests);

  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  return {
    agent: "codex",
    id: id ?? path.basename(file, ".jsonl"),
    title: shortTitle(firstUser),
    model,
    cwd,
    startedAt,
    updatedAt,
    messages: messages.slice(-300),
    toolCalls: toolCalls.slice(-300),
    tests: dedupedTests,
    compactions: compactedRecords > 0 ? compactedRecords : compactedEvents,
    source: file,
  };
}

export function loadCodexSession(options: AdapterOptions): Session {
  const file = findCodexFile(options);
  return parseCodexTranscript(file, options);
}
