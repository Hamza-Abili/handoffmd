import { readFileSync, statSync } from "node:fs";
import { CliError } from "../core/errors.ts";
import type { Session, SessionMessage, ToolCall } from "../core/types.ts";
import {
  asArray,
  asRecord,
  asString,
  classifyTest,
  iso,
  isTestCommand,
  MAX_TRANSCRIPT_BYTES,
  parseJsonLine,
  shortTitle,
  textFromContent,
  toolOutput,
} from "./common.ts";

function parseMessages(value: unknown): SessionMessage[] {
  return asArray(value)
    .map((item) => {
      const record = asRecord(item);
      if (!record) return null;
      const role = asString(record.role);
      if (role !== "user" && role !== "assistant" && role !== "system") return null;
      const text = asString(record.text) ?? textFromContent(record.content);
      if (!text) return null;
      return { role, text, at: iso(record.timestamp ?? record.time) } as SessionMessage;
    })
    .filter((message): message is SessionMessage => message !== null);
}

export function parseGenericTranscript(file: string): Session {
  const size = statSync(file).size;
  if (size > MAX_TRANSCRIPT_BYTES) {
    throw new CliError(
      `transcript is too large (${size} bytes, limit ${MAX_TRANSCRIPT_BYTES})`,
      2,
      "pass a smaller file with --transcript"
    );
  }
  const raw = readFileSync(file, "utf8").trim();
  if (!raw) throw new CliError(`transcript is empty: ${file}`, 2);
  const messages: SessionMessage[] = [];
  const toolCalls: ToolCall[] = [];
  let title: string | undefined;
  let id: string | undefined;
  let model: string | undefined;
  let cwd: string | undefined;

  let parsed: unknown = null;
  let parsedOk = false;
  if (raw.startsWith("[") || raw.startsWith("{")) {
    try {
      parsed = JSON.parse(raw) as unknown;
      parsedOk = true;
    } catch {
      parsed = null;
    }
  }
  const record = asRecord(parsed);
  const isExport =
    Array.isArray(parsed) ||
    Boolean(
      record &&
        (Array.isArray(record.messages) ||
          Array.isArray(record.toolCalls) ||
          Array.isArray(record.tools))
    );
  if (parsedOk && isExport) {
    if (record) {
      id = asString(record.id) ?? asString(record.sessionId);
      title = asString(record.title);
      model = asString(record.model);
      cwd = asString(record.cwd) ?? asString(record.directory);
      messages.push(...parseMessages(record.messages));
      for (const item of asArray(record.toolCalls ?? record.tools)) {
        const call = asRecord(item);
        if (!call) continue;
        toolCalls.push({
          id: asString(call.id),
          name: asString(call.name) ?? "unknown",
          input: call.input,
          output: toolOutput(call.output),
          status: "unknown",
          at: iso(call.at),
        });
      }
    } else if (Array.isArray(parsed)) {
      messages.push(...parseMessages(parsed));
    }
  } else {
    for (const line of raw.split(/\r?\n/)) {
      const record = asRecord(parseJsonLine(line));
      if (!record) continue;
      const role = asString(record.role);
      if (role === "user" || role === "assistant" || role === "system") {
        const text = asString(record.text) ?? asString(record.content);
        if (text) messages.push({ role, text, at: iso(record.timestamp) });
        continue;
      }
      const type = asString(record.type);
      if (type === "user" || type === "assistant") {
        const message = asRecord(record.message);
        const text = textFromContent(message?.content ?? record.content);
        if (text) messages.push({ role: type, text, at: iso(record.timestamp) });
      }
    }
  }

  if (messages.length === 0) {
    throw new CliError(
      `no user or assistant messages found in ${file}`,
      2,
      "expected JSONL with role/content or a JSON export with a messages array"
    );
  }

  const tests = [];
  for (const call of toolCalls) {
    const input = asRecord(call.input);
    const command = asString(input?.command) ?? asString(call.input);
    if (!command || !isTestCommand(command)) continue;
    tests.push(classifyTest(command, call.output ?? "", call.status === "failed"));
  }

  const firstUser = messages.find((message) => message.role === "user")?.text ?? "";
  return {
    agent: "generic",
    id,
    title: title ?? shortTitle(firstUser),
    model,
    cwd,
    startedAt: messages[0]?.at,
    updatedAt: messages.at(-1)?.at,
    messages: messages.slice(-300),
    toolCalls: toolCalls.slice(-300),
    tests: tests.slice(-8),
    compactions: 0,
    source: file,
  };
}
