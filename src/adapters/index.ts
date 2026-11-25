import { CliError } from "../core/errors.ts";
import type { AgentName, Session } from "../core/types.ts";
import { type AdapterOptions, loadClaudeSession } from "./claude.ts";
import { loadCodexSession } from "./codex.ts";
import { readPrefix } from "./common.ts";
import { parseGenericTranscript } from "./generic.ts";
import { loadOpenCodeSession } from "./opencode.ts";

export type AgentSelection = AgentName | "auto";

function envAgent(): AgentName | null {
  if (process.env.CLAUDECODE || process.env.CLAUDE_CODE_ENTRYPOINT) return "claude";
  if (process.env.CODEX_HOME || process.env.CODEX_SANDBOX) return "codex";
  if (process.env.OPENCODE || process.env.OPENCODE_SERVER) return "opencode";
  return null;
}

function detectTranscriptAgent(file: string): AgentName {
  try {
    const text = readPrefix(file, 64 * 1024);
    if (/"session_meta"/.test(text)) return "codex";
    if (/"type"\s*:\s*"assistant"/.test(text) && /"message"\s*:/.test(text)) return "claude";
  } catch {
    // let the generic parser produce the error
  }
  return "generic";
}

export async function loadSession(
  agent: AgentSelection,
  options: AdapterOptions
): Promise<Session | null> {
  if (agent === "generic") {
    if (!options.transcript) {
      throw new CliError("--from generic requires --transcript <file>", 2);
    }
    return parseGenericTranscript(options.transcript);
  }

  if (options.transcript) {
    if (agent === "claude") return loadClaudeSession(options);
    if (agent === "codex") return loadCodexSession(options);
    if (agent === "opencode") return loadOpenCodeSession(options);
    if (agent === "auto") {
      const detected = detectTranscriptAgent(options.transcript);
      if (detected === "claude") return loadClaudeSession(options);
      if (detected === "codex") return loadCodexSession(options);
    }
    return parseGenericTranscript(options.transcript);
  }

  if (agent === "claude") return loadClaudeSession(options);
  if (agent === "codex") return loadCodexSession(options);
  if (agent === "opencode") return loadOpenCodeSession(options);

  const hinted = envAgent();
  if (hinted === "claude") return loadClaudeSession(options);
  if (hinted === "codex") return loadCodexSession(options);
  if (hinted === "opencode") return loadOpenCodeSession(options);

  const attempts: Array<Promise<Session> | Session> = [
    Promise.resolve().then(() => loadClaudeSession(options)),
    Promise.resolve().then(() => loadCodexSession(options)),
    loadOpenCodeSession(options),
  ];
  const results = await Promise.allSettled(attempts);
  const sessions = results
    .filter((result): result is PromiseFulfilledResult<Session> => result.status === "fulfilled")
    .map((result) => result.value)
    .sort((a, b) => (Date.parse(b.updatedAt ?? "") || 0) - (Date.parse(a.updatedAt ?? "") || 0));
  if (sessions.length > 0) return sessions[0];

  const reasons = results
    .filter((result): result is PromiseRejectedResult => result.status === "rejected")
    .map((result) => (result.reason as Error).message)
    .slice(0, 3);
  throw new CliError(
    `no agent session found for this repository${reasons.length ? ` (${reasons.join("; ")})` : ""}`,
    2,
    "use --manual to build the handoff from git evidence, or pass --transcript <file>"
  );
}
