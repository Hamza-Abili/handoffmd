import { CliError } from "./errors.ts";
import type { HandoffFrontmatter, HandoffStatus, ParsedHandoff } from "./types.ts";

export const REQUIRED_SECTIONS = ["goal", "state", "next-steps", "open-questions", "evidence"];

const SECTION_ALIASES: Record<string, string> = {
  goal: "goal",
  objective: "goal",
  "the goal": "goal",
  state: "state",
  "current state": "state",
  "state of play": "state",
  "next steps": "next-steps",
  "next step": "next-steps",
  next: "next-steps",
  "open questions": "open-questions",
  questions: "open-questions",
  "unresolved questions": "open-questions",
  evidence: "evidence",
  verification: "evidence",
  "evidence and data": "evidence",
  decisions: "decisions",
  "key decisions": "decisions",
  "what changed": "what-changed",
  changes: "what-changed",
  "what didn't work": "didnt-work",
  "what did not work": "didnt-work",
  "failed attempts": "didnt-work",
  "ruled out": "didnt-work",
  constraints: "constraints",
  guardrails: "constraints",
  "session summary": "session-summary",
  summary: "session-summary",
};

const STATUSES: HandoffStatus[] = ["in-progress", "blocked", "review", "done"];

export function normalizeHeading(heading: string): string {
  const normalized = heading
    .toLowerCase()
    .replace(/[^a-z0-9\s']/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return SECTION_ALIASES[normalized] ?? normalized.replace(/\s+/g, "-");
}

function parseScalar(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      return JSON.parse(value) as string;
    } catch {
      return value.slice(1, -1);
    }
  }
  return value;
}

function parseFrontmatter(lines: string[]): {
  frontmatter: HandoffFrontmatter;
  bodyStart: number;
} {
  if (lines[0]?.trim() !== "---") {
    throw new CliError("HANDOFF.md is missing frontmatter", 1, "run handoffmd init or save");
  }
  const end = lines.findIndex((line, index) => index > 0 && line.trim() === "---");
  if (end === -1) {
    throw new CliError("HANDOFF.md has an unterminated frontmatter block", 1);
  }
  const fields: Record<string, string> = {};
  for (const line of lines.slice(1, end)) {
    const match = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/);
    if (!match) continue;
    fields[match[1].toLowerCase()] = parseScalar(match[2]);
  }
  if (!/^1$/.test(fields.handoff ?? "")) {
    throw new CliError("HANDOFF.md frontmatter is missing `handoff: 1`", 1);
  }
  if (!fields.title?.trim()) {
    throw new CliError("HANDOFF.md frontmatter is missing a title", 1);
  }
  if (!fields.status) {
    throw new CliError("HANDOFF.md frontmatter is missing a status", 1);
  }
  const status = fields.status as HandoffStatus;
  if (!STATUSES.includes(status)) {
    throw new CliError(
      `invalid handoff status: ${status}`,
      1,
      `use one of: ${STATUSES.join(", ")}`
    );
  }
  const handoff = 1;
  return {
    frontmatter: {
      handoff,
      title: fields.title ?? "",
      status,
      updated: fields.updated ?? "",
      agent: fields.agent,
      session: fields.session,
      branch: fields.branch,
      commit: fields.commit,
      generated:
        fields.generated === "auto" || fields.generated === "manual" ? fields.generated : undefined,
    },
    bodyStart: end + 1,
  };
}

export function parseHandoff(raw: string): ParsedHandoff {
  const lines = raw.replace(/\r\n/g, "\n").split("\n");
  const { frontmatter, bodyStart } = parseFrontmatter(lines);
  const preamble: string[] = [];
  const sections: ParsedHandoff["sections"] = [];
  let current: { heading: string; key: string; body: string[] } | null = null;
  let inFence = false;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    const headingMatch = !inFence ? line.match(/^##\s+(.+?)\s*$/) : null;
    if (headingMatch) {
      if (current) {
        sections.push({
          heading: current.heading,
          key: current.key,
          body: current.body.join("\n").trim(),
        });
      }
      const heading = headingMatch[1];
      current = { heading, key: normalizeHeading(heading), body: [] };
      continue;
    }
    if (current) current.body.push(line);
    else preamble.push(line);
  }
  if (current) {
    sections.push({
      heading: current.heading,
      key: current.key,
      body: current.body.join("\n").trim(),
    });
  }

  const preambleText = preamble.join("\n").trim();
  const intro = preambleText.replace(/^#\s+[^\n]*\n?/, "").trim();
  return { frontmatter, preamble: intro, sections };
}

export function sectionBody(parsed: ParsedHandoff, key: string): string {
  return parsed.sections.find((section) => section.key === key)?.body ?? "";
}

export interface RenderSection {
  heading: string;
  body: string;
}

export interface RenderHandoff {
  frontmatter: HandoffFrontmatter;
  title: string;
  intro?: string;
  sections: RenderSection[];
}

function quote(value: string): string {
  return JSON.stringify(value);
}

export function sanitizeInline(value: string, max = 200): string {
  return [...value.replace(/[\r\n\t]+/g, " ")]
    .filter((char) => char >= " " && char !== "\u007f")
    .join("")
    .replace(/^[#>*+\-\s]+/, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

export function renderHandoff(document: RenderHandoff): string {
  const fm = document.frontmatter;
  const title = sanitizeInline(document.title || fm.title, 160);
  const agent = fm.agent ? sanitizeInline(fm.agent, 40) : undefined;
  const session = fm.session ? sanitizeInline(fm.session, 200) : undefined;
  const branch = fm.branch ? sanitizeInline(fm.branch, 200) : undefined;
  const commit = fm.commit ? sanitizeInline(fm.commit, 80) : undefined;
  const lines = [
    "---",
    `handoff: 1`,
    `title: ${quote(title)}`,
    `status: ${fm.status}`,
    `updated: ${fm.updated}`,
  ];
  if (agent) lines.push(`agent: ${agent}`);
  if (session) lines.push(`session: ${quote(session)}`);
  if (branch) lines.push(`branch: ${quote(branch)}`);
  if (commit) lines.push(`commit: ${commit}`);
  if (fm.generated) lines.push(`generated: ${fm.generated}`);
  lines.push("---", "", `# ${title}`, "");
  if (document.intro) lines.push(document.intro.trim(), "");
  for (const section of document.sections) {
    lines.push(`## ${section.heading}`, "", section.body.trim(), "");
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function updateFrontmatter(
  raw: string,
  updates: Record<string, string | undefined>
): string {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
  if (!match) throw new CliError("HANDOFF.md is missing frontmatter", 1);
  const body = raw.slice(match[0].length);
  const lines = match[1].split(/\r?\n/);
  const seen = new Set<string>();
  const output = lines.map((line) => {
    const field = line.match(/^([A-Za-z][A-Za-z0-9_-]*):\s*(.*)$/)?.[1]?.toLowerCase();
    if (!field || !(field in updates)) return line;
    const value = updates[field];
    if (value === undefined) return line;
    seen.add(field);
    return `${field}: ${value}`;
  });
  for (const [field, value] of Object.entries(updates)) {
    if (value !== undefined && !seen.has(field)) output.push(`${field}: ${value}`);
  }
  return `---\n${output.join("\n")}\n---\n${body}`;
}

export function uncheckedSteps(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.match(/^\s*[-*]\s*\[\s\]\s+(.+)$/)?.[1]?.trim())
    .filter((step): step is string => Boolean(step));
}

export function placeholderLines(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => {
      if (!line) return false;
      if (/^_TODO\b/i.test(line)) return true;
      if (/^(?:TODO|TBD|FIXME)\b/i.test(line)) return true;
      if (/^<[^>]+>$/.test(line)) return true;
      return false;
    });
}

export function localLinks(body: string): Array<{ target: string; line: number }> {
  const links: Array<{ target: string; line: number }> = [];
  let inFence = false;
  body.split("\n").forEach((line, index) => {
    if (line.trimStart().startsWith("```")) inFence = !inFence;
    if (inFence) return;
    const regex = /!?\[[^\]]*\]\(((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\)/g;
    for (const match of line.matchAll(regex)) {
      const target = match[1];
      if (/^(?:https?:|mailto:|tel:|#|data:|\/\/)/i.test(target)) continue;
      if (target.includes("<") || target.includes(">")) continue;
      links.push({ target, line: index + 1 });
    }
  });
  return links;
}
