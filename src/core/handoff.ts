import path from "node:path";
import { shortTitle } from "../adapters/common.ts";
import {
  normalizeHeading,
  placeholderLines,
  type RenderHandoff,
  type RenderSection,
  renderHandoff,
  sectionBody,
} from "./markdown.ts";
import { uniqueTests } from "./test-evidence.ts";
import type { HandoffStatus, ParsedHandoff, RepoSnapshot, Session, TestEvidence } from "./types.ts";

const SECTION_ORDER = [
  "goal",
  "state",
  "decisions",
  "what-changed",
  "didnt-work",
  "next-steps",
  "open-questions",
  "constraints",
  "evidence",
];

const HEADINGS: Record<string, string> = {
  goal: "Goal",
  state: "State",
  decisions: "Decisions",
  "what-changed": "What changed",
  "didnt-work": "What didn't work",
  "next-steps": "Next steps",
  "open-questions": "Open questions",
  constraints: "Constraints",
  evidence: "Evidence",
  "session-summary": "Session summary",
};

function cleanLine(line: string): string {
  return line
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, "")
    .replace(/^\s*\[[ xX]\]\s+/, "")
    .replace(/`/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

function meaningfulUserMessages(session: Session): string[] {
  return session.messages
    .filter((message) => message.role === "user")
    .map((message) => message.text.trim())
    .filter(
      (text) =>
        text.length > 15 &&
        !text.startsWith("<") &&
        !/^(?:continue|ok|yes|no|go on|proceed)$/i.test(text)
    );
}

function extractGoal(session: Session): string {
  const messages = meaningfulUserMessages(session);
  const first = messages[0] ?? session.messages.find((m) => m.role === "user")?.text ?? "";
  return demoteHeadings(first.replace(/\s+/g, " ").trim().slice(0, 900));
}

function extractState(session: Session): string {
  const lastAssistantIndex = session.messages.findLastIndex(
    (message) => message.role === "assistant"
  );
  const lastSummaryIndex = session.messages.findLastIndex(
    (message) => message.role === "system" && /(?:compact|summar|context)/i.test(message.text)
  );
  const assistantText =
    session.messages[lastAssistantIndex]?.text ??
    session.messages[lastAssistantIndex - 1]?.text ??
    "";
  const summaryText = session.messages[lastSummaryIndex]?.text ?? "";
  const last =
    lastSummaryIndex > lastAssistantIndex && summaryText
      ? summaryText
      : assistantText || summaryText;
  return demoteHeadings(
    last
      .replace(/```[\s\S]*?```/g, "[code omitted]")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
      .slice(0, 1800)
  );
}

function demoteHeadings(text: string): string {
  let inFence = false;
  return text
    .split("\n")
    .map((line) => {
      if (line.trimStart().startsWith("```")) inFence = !inFence;
      if (!inFence && /^#{1,6}\s/.test(line)) {
        return `#### ${line.replace(/^#{1,6}\s+/, "")}`;
      }
      return line;
    })
    .join("\n");
}

function listBlocks(text: string): string[] {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => /^(?:[-*+]|\d+\.)\s+/.test(line));
}

function extractNextSteps(session: Session): string[] {
  const messages = session.messages
    .filter((message) => message.role === "assistant")
    .slice(-5)
    .map((message) => message.text);
  const steps: string[] = [];
  for (const text of messages) {
    const lines = text.split("\n");
    let inNext = false;
    for (const line of lines) {
      if (/^#{2,6}\s+.*(?:next|todo|remaining|follow[- ]?up)/i.test(line)) {
        inNext = true;
        continue;
      }
      if (inNext && /^#{2,6}\s+/.test(line)) {
        inNext = false;
        continue;
      }
      const unchecked = line.match(/^\s*[-*+]\s*\[\s\]\s+(.+)$/);
      if (unchecked) {
        steps.push(cleanLine(unchecked[1]));
        continue;
      }
      if (inNext && /^\s*(?:[-*+]|\d+\.)\s+/.test(line)) {
        steps.push(cleanLine(line));
      }
    }
    const inline = text.match(/(?:next steps?|todo|remaining)\s*:\s*([\s\S]{0,800})/i);
    if (inline) {
      for (const line of listBlocks(inline[1])) steps.push(cleanLine(line));
    }
  }
  return unique(steps).slice(0, 8);
}

function extractDecisions(session: Session): string[] {
  const lines = session.messages
    .filter((message) => message.role === "assistant")
    .slice(-6)
    .flatMap((message) => message.text.split("\n"));
  return unique(
    lines
      .filter((line) =>
        /\b(?:decided|decision|chose|chosen|we(?:'| a)re using|instead of|because|constraint)\b/i.test(
          line
        )
      )
      .map(cleanLine)
      .filter((line) => line.length > 20)
  ).slice(0, 6);
}

function extractDidntWork(session: Session): string[] {
  const lines = session.messages
    .filter((message) => message.role === "assistant")
    .slice(-8)
    .flatMap((message) => message.text.split("\n"));
  return unique(
    lines
      .filter((line) =>
        /\b(?:failed|fails|doesn't work|does not work|didn't work|did not work|blocked|dead end|reverted|not possible)\b/i.test(
          line
        )
      )
      .map(cleanLine)
      .filter((line) => line.length > 20)
  ).slice(0, 6);
}

function extractQuestions(session: Session): string[] {
  const last =
    session.messages.filter((message) => message.role === "assistant").at(-1)?.text ?? "";
  return unique(
    last
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.endsWith("?") && line.length > 15)
      .map(cleanLine)
  ).slice(0, 5);
}

function unique(values: string[]): string[] {
  const seen = new Set<string>();
  return values.filter((value) => {
    const key = value.toLowerCase();
    if (!value || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function changedFilesBody(snapshot: RepoSnapshot): string {
  if (snapshot.changes.length === 0) {
    return "_Worktree was clean when the handoff was created._";
  }
  return snapshot.changes
    .slice(0, 25)
    .map((change) => `- \`${change.path.replace(/[\r\n]/g, " ")}\` (${change.status})`)
    .join("\n");
}

export function evidenceBody(
  snapshot: RepoSnapshot,
  session: Session | null,
  extraTests: TestEvidence[] = []
): string {
  const lines = [
    `- Branch: \`${snapshot.branch}\` at \`${snapshot.headShort || "unborn"}\``,
    `- Worktree: ${snapshot.dirty ? `dirty (${snapshot.changes.length} file(s))` : "clean"}`,
  ];
  if (session) {
    const model = session.model ? `, ${session.model.replace(/[\r\n]/g, " ")}` : "";
    const sessionId = session.id?.replace(/[\r\n]/g, " ");
    lines.push(`- Session: \`${session.agent}\`${sessionId ? ` \`${sessionId}\`` : ""}${model}`);
    if (session.compactions > 0) {
      lines.push(`- Compactions in session: ${session.compactions}`);
    }
  } else {
    lines.push("- Session: _manual handoff (no agent transcript)_");
  }

  const tests = uniqueTests([...(session?.tests ?? []), ...extraTests]);
  if (tests.length > 0) {
    lines.push("- Test evidence:");
    for (const test of tests) {
      const summary = test.summary ? ` — ${test.summary}` : "";
      lines.push(`  - \`${test.command}\` — **${test.status}**${summary}`);
    }
  } else {
    lines.push("- Test evidence: _no test command detected_");
  }

  if (snapshot.commits.length > 0) {
    lines.push("- Recent commits:");
    for (const commit of snapshot.commits.slice(0, 3)) {
      lines.push(`  - \`${commit.short}\` ${commit.subject}`);
    }
  }
  if (snapshot.changes.length > 0) {
    lines.push("- Changed files:", changedFilesBody(snapshot).replace(/^- /gm, "  - "));
  }
  return lines.join("\n");
}

export interface DraftOptions {
  status: HandoffStatus;
  generated: "auto" | "manual";
  title?: string;
  tests?: TestEvidence[];
}

export function buildDraft(
  session: Session | null,
  snapshot: RepoSnapshot,
  options: DraftOptions
): RenderHandoff {
  const goal = session ? extractGoal(session) : "";
  const state = session ? extractState(session) : "";
  const nextSteps = session ? extractNextSteps(session) : [];
  const decisions = session ? extractDecisions(session) : [];
  const didntWork = session ? extractDidntWork(session) : [];
  const questions = session ? extractQuestions(session) : [];

  const sections: RenderSection[] = [
    {
      heading: HEADINGS.goal,
      body:
        goal ||
        "_TODO: describe the concrete outcome this work must achieve, including user-visible behaviour._",
    },
    {
      heading: HEADINGS.state,
      body: state || "_TODO: summarise what is true now — implemented, broken, unverified._",
    },
    {
      heading: HEADINGS.decisions,
      body:
        decisions.length > 0 ? decisions.map((item) => `- ${item}`).join("\n") : "_None recorded._",
    },
    {
      heading: HEADINGS["what-changed"],
      body: changedFilesBody(snapshot),
    },
    {
      heading: HEADINGS["didnt-work"],
      body:
        didntWork.length > 0 ? didntWork.map((item) => `- ${item}`).join("\n") : "_None recorded._",
    },
    {
      heading: HEADINGS["next-steps"],
      body:
        nextSteps.length > 0
          ? nextSteps.map((step) => `- [ ] ${step}`).join("\n")
          : "- [ ] Define the next concrete step and verify it against the current repository state.",
    },
    {
      heading: HEADINGS["open-questions"],
      body:
        questions.length > 0 ? questions.map((question) => `- ${question}`).join("\n") : "_None._",
    },
    {
      heading: HEADINGS.evidence,
      body: evidenceBody(snapshot, session, options.tests),
    },
  ];

  const title =
    options.title ??
    session?.title ??
    shortTitle(goal, path.basename(snapshot.root) || "Repository handoff");

  return {
    frontmatter: {
      handoff: 1,
      title,
      status: options.status,
      updated: new Date().toISOString(),
      agent: session?.agent,
      session: session?.id,
      branch: snapshot.branch,
      commit: snapshot.head,
      generated: options.generated,
    },
    title,
    intro:
      options.generated === "auto"
        ? "> Auto-extracted from the last agent session. Verify every claim against the repository before continuing."
        : undefined,
    sections,
  };
}

export function isTemplateHandoff(parsed: ParsedHandoff): boolean {
  const goal = sectionBody(parsed, "goal");
  const state = sectionBody(parsed, "state");
  return placeholderLines(goal).length > 0 && placeholderLines(state).length > 0;
}

function isPlaceholderSection(body: string): boolean {
  const trimmed = body.trim();
  return (
    !trimmed ||
    placeholderLines(trimmed).length > 0 ||
    /^_None(?: recorded)?\._$/i.test(trimmed) ||
    /^_Worktree was clean when the handoff was created\._$/i.test(trimmed)
  );
}

export interface MergeOptions {
  status?: HandoffStatus;
  title?: string;
  agent?: string;
  session?: string;
  generated: "auto" | "manual";
}

export function mergeHandoff(
  existing: ParsedHandoff,
  draft: RenderHandoff,
  snapshot: RepoSnapshot,
  options: MergeOptions
): RenderHandoff {
  const existingSections = new Map(existing.sections.map((section) => [section.key, section]));
  const draftSections = new Map(
    draft.sections.map((section) => [normalizeHeading(section.heading), section])
  );
  const sections: RenderSection[] = [];

  for (const key of SECTION_ORDER) {
    const existingSection = existingSections.get(key);
    const draftSection = draftSections.get(key);
    if (key === "evidence") {
      if (draftSection) sections.push({ heading: draftSection.heading, body: draftSection.body });
      continue;
    }
    if (existingSection && !isPlaceholderSection(existingSection.body)) {
      sections.push({ heading: existingSection.heading, body: existingSection.body });
    } else if (draftSection) {
      sections.push({ heading: draftSection.heading, body: draftSection.body });
    }
  }

  for (const section of existing.sections) {
    if (!SECTION_ORDER.includes(section.key) && section.body.trim()) {
      sections.push({ heading: section.heading, body: section.body });
    }
  }

  return {
    frontmatter: {
      handoff: 1,
      title: options.title || existing.frontmatter.title || draft.title,
      status: options.status ?? existing.frontmatter.status,
      updated: new Date().toISOString(),
      agent: options.agent ?? existing.frontmatter.agent ?? draft.frontmatter.agent,
      session: options.session ?? existing.frontmatter.session ?? draft.frontmatter.session,
      branch: snapshot.branch,
      commit: snapshot.head,
      generated:
        existing.frontmatter.generated === "manual" || options.generated === "manual"
          ? "manual"
          : "auto",
    },
    title: options.title || existing.frontmatter.title || draft.title,
    intro:
      existing.frontmatter.generated === "manual" ? existing.preamble || undefined : draft.intro,
    sections,
  };
}

export function renderDraft(draft: RenderHandoff): string {
  return renderHandoff(draft);
}
