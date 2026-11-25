import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { CliError } from "../core/errors.ts";
import { realpathSafe } from "../core/fs.ts";
import type { Session, SessionMessage, ToolCall } from "../core/types.ts";
import type { AdapterOptions } from "./claude.ts";
import {
  asArray,
  asRecord,
  asString,
  classifyTest,
  iso,
  isTestCommand,
  parseJsonLine,
  shortTitle,
  textFromContent,
  toolOutput,
  uniqueTests,
} from "./common.ts";

interface Database {
  all(sql: string, ...params: unknown[]): Record<string, unknown>[];
  close(): void;
}

async function openDatabase(file: string): Promise<Database> {
  if (typeof Bun !== "undefined") {
    const { Database } = await import("bun:sqlite");
    const db = new Database(file, { readonly: true });
    return {
      all: (sql, ...params) => db.query(sql).all(...(params as never[])) as never,
      close: () => db.close(),
    };
  }

  const originalEmit = process.emitWarning;
  process.emitWarning = ((warning: string | Error, ...args: unknown[]) => {
    const text = typeof warning === "string" ? warning : warning.message;
    if (text.includes("SQLite is an experimental feature")) return;
    return (originalEmit as (...inner: unknown[]) => void).call(process, warning, ...args);
  }) as typeof process.emitWarning;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(file, { readOnly: true });
    return {
      all: (sql, ...params) => db.prepare(sql).all(...(params as never[])) as never,
      close: () => db.close(),
    };
  } catch (error) {
    throw new CliError(
      `cannot open the OpenCode database: ${(error as Error).message}`,
      2,
      "use Node 22.5+ or Bun, or pass --transcript with an OpenCode export"
    );
  } finally {
    process.emitWarning = originalEmit;
  }
}

function opencodeDataDir(): string {
  return path.join(
    process.env.XDG_DATA_HOME || path.join(homedir(), ".local", "share"),
    "opencode"
  );
}

function findDatabase(): string {
  if (process.env.OPENCODE_DB) return process.env.OPENCODE_DB;
  const dir = opencodeDataDir();
  const defaultFile = path.join(dir, "opencode.db");
  if (existsSync(defaultFile)) return defaultFile;
  if (existsSync(dir)) {
    const candidates = readdirSync(dir)
      .filter((name) => /^opencode.*\.db$/.test(name))
      .map((name) => {
        const file = path.join(dir, name);
        return { file, mtime: statSync(file).mtimeMs };
      })
      .sort((a, b) => b.mtime - a.mtime);
    if (candidates[0]) return candidates[0].file;
  }
  throw new CliError(
    `OpenCode database not found in ${dir}`,
    2,
    "pass --transcript <file> or run handoffmd save --manual"
  );
}

function displayModel(raw: unknown): string | undefined {
  if (typeof raw === "string") {
    try {
      return displayModel(JSON.parse(raw) as unknown);
    } catch {
      return raw;
    }
  }
  const record = asRecord(raw);
  if (!record) return undefined;
  const id = asString(record.id) ?? asString(record.modelID);
  const provider = asString(record.providerID);
  if (!id) return undefined;
  return provider ? `${provider}/${id}` : id;
}

export async function loadOpenCodeSession(options: AdapterOptions): Promise<Session> {
  const file = options.transcript ?? findDatabase();
  const db = await openDatabase(file);
  try {
    let session: Record<string, unknown> | null = null;
    if (options.session) {
      session = db.all("SELECT * FROM session_v2 WHERE id = ? LIMIT 1", options.session)[0] ?? null;
      if (!session) {
        throw new CliError(
          `OpenCode session '${options.session}' not found`,
          2,
          "pass a session id that exists, or use --transcript <file>"
        );
      }
    } else {
      const cwd = realpathSafe(options.cwd);
      session =
        db.all(
          `SELECT * FROM session_v2
           WHERE directory = ? OR directory = ? OR path = ? OR directory LIKE ?
           ORDER BY time_updated DESC LIMIT 20`,
          cwd,
          `${cwd}${path.sep}`,
          cwd,
          `${cwd}%`
        )[0] ?? null;
      if (!session) {
        throw new CliError(
          `no OpenCode session matches ${cwd}`,
          2,
          "pass --session <id>, --transcript <file>, or use --manual"
        );
      }
    }
    if (!session) {
      throw new CliError(
        "no OpenCode sessions found",
        2,
        "pass --session <id> or run handoffmd save --manual"
      );
    }

    const sessionId = asString(session.id) ?? "";
    const rows = db.all(
      `SELECT id, type, seq, time_created, data FROM session_message
       WHERE session_id = ? AND type IN ('user','assistant','compaction','system')
       ORDER BY seq`,
      sessionId
    );

    const messages: SessionMessage[] = [];
    const toolCalls: ToolCall[] = [];
    let compactions = 0;
    let model = displayModel(session.model);
    const partsByMessage = new Map<string, Record<string, unknown>[]>();
    for (const part of db.all(
      "SELECT message_id, type, data FROM session_part WHERE session_id = ? ORDER BY message_id, ordinal",
      sessionId
    )) {
      const messageId = asString(part.message_id);
      if (!messageId) continue;
      const list = partsByMessage.get(messageId) ?? [];
      list.push(part);
      partsByMessage.set(messageId, list);
    }

    for (const row of rows) {
      const type = asString(row.type);
      const at = iso(row.time_created);
      const data = asRecord(parseJsonLine(asString(row.data) ?? ""));
      if (!data) continue;
      if (type === "compaction") {
        compactions++;
        const summary = asString(data.summary);
        if (summary) messages.push({ role: "system", text: summary, at });
        continue;
      }
      if (type === "user") {
        const text = asString(data.text);
        if (text) messages.push({ role: "user", text, at });
        continue;
      }
      if (type === "system") {
        const text = asString(data.text);
        if (text) messages.push({ role: "system", text, at });
        continue;
      }
      if (type !== "assistant") continue;
      model = displayModel(data.model) ?? model;

      const stored = partsByMessage.get(asString(row.id) ?? "") ?? [];
      const inline = asArray(data.content);
      const seenText = new Set<string>();
      const seenTools = new Set<string>();
      let text = "";

      const handlePart = (partType: string | undefined, partData: Record<string, unknown>) => {
        if (partType === "text") {
          const value = asString(partData.text) ?? "";
          if (value && !seenText.has(value)) {
            seenText.add(value);
            text += `${value}\n`;
          }
          return;
        }
        if (partType !== "tool") return;
        const state = asRecord(partData.state);
        const name = asString(partData.name) ?? "unknown";
        const key = `${asString(partData.id) ?? ""}:${name}:${JSON.stringify(state?.input ?? "")}`;
        if (seenTools.has(key)) return;
        seenTools.add(key);
        const output = textFromContent(state?.content) || toolOutput(state?.output);
        const rawStatus = asString(state?.status);
        const exit = Number(asRecord(state?.metadata)?.exit);
        const failed =
          rawStatus === "error" ||
          rawStatus === "failed" ||
          (rawStatus === "completed" && Number.isFinite(exit) && exit !== 0);
        toolCalls.push({
          id: asString(partData.id),
          name,
          input: state?.input,
          output: output || undefined,
          status: failed
            ? "failed"
            : rawStatus === "completed"
              ? "completed"
              : rawStatus === "running"
                ? "running"
                : "unknown",
          at,
        });
      };

      for (const part of inline) {
        const partData = asRecord(part);
        if (partData) handlePart(asString(partData.type), partData);
      }
      for (const part of stored) {
        const partData = asRecord(parseJsonLine(asString(part.data) ?? ""));
        if (partData) handlePart(asString(part.type) ?? asString(partData.type), partData);
      }

      if (text.trim()) messages.push({ role: "assistant", text: text.trim(), at });
    }

    const tests = [];
    for (const call of toolCalls.slice(-50)) {
      const input = asRecord(call.input);
      const command = asString(input?.command) ?? asString(input?.cmd) ?? asString(call.input);
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
      agent: "opencode",
      id: sessionId,
      title: asString(session.title) ?? shortTitle(firstUser),
      model,
      cwd: asString(session.directory),
      startedAt: iso(session.time_created),
      updatedAt: iso(session.time_updated),
      messages: messages.slice(-300),
      toolCalls: toolCalls.slice(-300),
      tests: dedupedTests,
      compactions,
      source: file,
    };
  } catch (error) {
    if (error instanceof CliError) throw error;
    throw new CliError(
      `cannot read the OpenCode session: ${(error as Error).message}`,
      2,
      "this adapter expects the OpenCode v2 SQLite schema; use --transcript for older versions"
    );
  } finally {
    db.close();
  }
}

export function opencodeDatabasePath(): string | null {
  try {
    return findDatabase();
  } catch {
    return null;
  }
}
