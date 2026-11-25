export interface SecretFinding {
  kind: string;
  line: number;
  context: string;
}

interface SecretPattern {
  kind: string;
  regex: RegExp;
  replacement: string | ((match: string, ...groups: string[]) => string);
}

const SECRET_KEY =
  /(?:^|[_.-])(?:api[_-]?key|secret|token|password|passwd|pwd|private[_-]?key|access[_-]?key|client[_-]?secret|auth[_-]?token|credential)(?:$|[_.-])/i;

const PLACEHOLDER =
  /^(?:your[_-]|example|sample|placeholder|changeme|xxx+|<.*>|\$\{.*\}|\[REDACTED.*\])/i;

const PATTERNS: SecretPattern[] = [
  {
    kind: "private_key",
    regex: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
    replacement: "[REDACTED:private_key]",
  },
  {
    kind: "github_token",
    regex: /\b(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})\b/g,
    replacement: "[REDACTED:github_token]",
  },
  {
    kind: "aws_access_key",
    regex: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    replacement: "[REDACTED:aws_access_key]",
  },
  {
    kind: "anthropic_key",
    regex: /\bsk-ant-[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:anthropic_key]",
  },
  {
    kind: "openai_key",
    regex: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}\b/g,
    replacement: "[REDACTED:openai_key]",
  },
  {
    kind: "stripe_key",
    regex: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{16,}\b/g,
    replacement: "[REDACTED:stripe_key]",
  },
  {
    kind: "slack_token",
    regex: /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g,
    replacement: "[REDACTED:slack_token]",
  },
  {
    kind: "google_api_key",
    regex: /\bAIza[0-9A-Za-z_-]{35}\b/g,
    replacement: "[REDACTED:google_api_key]",
  },
  {
    kind: "npm_token",
    regex: /\bnpm_[A-Za-z0-9]{36}\b/g,
    replacement: "[REDACTED:npm_token]",
  },
  {
    kind: "jwt",
    regex: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/g,
    replacement: "[REDACTED:jwt]",
  },
  {
    kind: "authorization_header",
    regex: /\b(Authorization:\s*(?:Bearer|Basic)\s+)[A-Za-z0-9._~+/=-]{10,}/gi,
    replacement: (_match, prefix) => `${prefix}[REDACTED:authorization]`,
  },
  {
    kind: "url_credentials",
    regex: /\b([a-z][a-z0-9+.-]*:\/\/)([^/\s:@]+):([^@\s/]+)@/gi,
    replacement: (_match, scheme, user) => `${scheme}${user}:[REDACTED:url_password]@`,
  },
];

function lineOf(text: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) {
    if (text[i] === "\n") line++;
  }
  return line;
}

function lineContext(text: string, index: number): string {
  const start = text.lastIndexOf("\n", index - 1) + 1;
  const end = text.indexOf("\n", index);
  const line = redactAll(text.slice(start, end === -1 ? text.length : end).trim());
  if (line.length <= 100) return line;
  return `${line.slice(0, 97)}...`;
}

function redactEnvLine(line: string): string {
  return line.replace(
    /([A-Za-z_][A-Za-z0-9_.-]{0,80})\s*[:=]\s*("([^"]*)"|'([^']*)'|([^\s#]+))/g,
    (
      match,
      key: string,
      full: string,
      doubleQuoted?: string,
      singleQuoted?: string,
      bare?: string
    ) => {
      if (!SECRET_KEY.test(key)) return match;
      const value = doubleQuoted ?? singleQuoted ?? bare ?? "";
      if (PLACEHOLDER.test(value) || value.startsWith("[REDACTED")) return match;
      const prefix = match.slice(0, match.length - full.length);
      const quote = doubleQuoted !== undefined ? '"' : singleQuoted !== undefined ? "'" : "";
      return `${prefix}${quote}[REDACTED:env_assignment]${quote}`;
    }
  );
}

export function redactAll(text: string): string {
  let output = text;
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    output = output.replace(pattern.regex, pattern.replacement as never);
  }
  return output
    .split("\n")
    .map((line) => redactEnvLine(line))
    .join("\n");
}

function envAssignments(text: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const pattern = /([A-Za-z_][A-Za-z0-9_.-]{0,80})\s*[:=]\s*("([^"]*)"|'([^']*)'|([^\s#]+))/g;
    for (const match of lines[i].matchAll(pattern)) {
      const key = match[1];
      const value = match[3] ?? match[4] ?? match[5] ?? "";
      if (!SECRET_KEY.test(key)) continue;
      if (PLACEHOLDER.test(value)) continue;
      if (value.startsWith("[REDACTED")) continue;
      findings.push({
        kind: "env_assignment",
        line: i + 1,
        context: `${key}=[REDACTED]`,
      });
    }
  }
  return findings;
}

export function scanSecrets(text: string): SecretFinding[] {
  const findings: SecretFinding[] = envAssignments(text);
  for (const pattern of PATTERNS) {
    pattern.regex.lastIndex = 0;
    for (const match of text.matchAll(pattern.regex)) {
      const index = match.index ?? 0;
      findings.push({
        kind: pattern.kind,
        line: lineOf(text, index),
        context: lineContext(text, index).replace(match[0], `[REDACTED:${pattern.kind}]`),
      });
    }
  }
  const seen = new Set<string>();
  return findings
    .filter((finding) => {
      const key =
        finding.kind === "env_assignment"
          ? `${finding.kind}:${finding.line}:${finding.context}`
          : `${finding.kind}:${finding.line}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    })
    .sort((a, b) => a.line - b.line);
}

export function redactValue<T>(value: T): T {
  if (typeof value === "string") return redactAll(value) as T;
  if (Array.isArray(value)) return value.map((item) => redactValue(item)) as T;
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        redactValue(item),
      ])
    ) as T;
  }
  return value;
}

export function redactSecrets(text: string): { text: string; findings: SecretFinding[] } {
  const findings = scanSecrets(text);
  return { text: redactAll(text), findings };
}
