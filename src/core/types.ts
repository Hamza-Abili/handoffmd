export type AgentName = "claude" | "codex" | "opencode" | "generic";

export type HandoffStatus = "in-progress" | "blocked" | "review" | "done";

export interface Config {
  version: 1;
  file: string;
  maxTokens: number;
  loadMaxTokens: number;
  warnAgeDays: number;
  maxAgeDays: number;
  redact: boolean;
  include: string[];
  exclude: string[];
}

export interface SessionMessage {
  role: "user" | "assistant" | "system";
  text: string;
  at?: string;
}

export interface ToolCall {
  id?: string;
  name: string;
  input?: unknown;
  output?: string;
  status?: "running" | "completed" | "failed" | "unknown";
  at?: string;
}

export interface TestEvidence {
  command: string;
  status: "passed" | "failed" | "unknown";
  summary?: string;
}

export interface Session {
  agent: AgentName;
  id?: string;
  title?: string;
  model?: string;
  cwd?: string;
  startedAt?: string;
  updatedAt?: string;
  messages: SessionMessage[];
  toolCalls: ToolCall[];
  tests: TestEvidence[];
  compactions: number;
  source: string;
}

export interface FileChange {
  path: string;
  status: string;
  sha256?: string;
}

export interface RepoSnapshot {
  root: string;
  branch: string;
  head: string;
  headShort: string;
  dirty: boolean;
  changes: FileChange[];
  commits: Array<{ sha: string; short: string; subject: string }>;
}

export interface HandoffState {
  version: 1;
  savedAt: string;
  handoffSha256: string;
  repo: {
    branch: string;
    head: string;
    headShort: string;
    dirty: boolean;
  };
  changes: FileChange[];
  session?: {
    agent: AgentName;
    id?: string;
    model?: string;
    source: string;
    updatedAt?: string;
    compactions: number;
  };
}

export interface HandoffFrontmatter {
  handoff: number;
  title: string;
  status: HandoffStatus;
  updated: string;
  agent?: string;
  session?: string;
  branch?: string;
  commit?: string;
  generated?: "auto" | "manual";
}

export interface ParsedHandoff {
  frontmatter: HandoffFrontmatter;
  preamble: string;
  sections: Array<{ heading: string; key: string; body: string }>;
}

export type FindingLevel = "error" | "warning" | "info";

export interface CheckFinding {
  level: FindingLevel;
  code: string;
  message: string;
  hint?: string;
}

export interface CheckResult {
  ok: boolean;
  file: string;
  findings: CheckFinding[];
  tokens: number;
  ageDays: number;
  stale: boolean;
  status?: HandoffStatus;
  state?: HandoffState;
}
