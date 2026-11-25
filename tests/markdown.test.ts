import { describe, expect, test } from "bun:test";
import { buildDraft, renderDraft } from "../src/core/handoff.ts";
import {
  localLinks,
  parseHandoff,
  placeholderLines,
  renderHandoff,
  sectionBody,
  uncheckedSteps,
} from "../src/core/markdown.ts";
import type { Session } from "../src/core/types.ts";

const sample = renderHandoff({
  frontmatter: {
    handoff: 1,
    title: 'Fix "auth" redirect',
    status: "in-progress",
    updated: "2026-11-25T10:00:00.000Z",
    agent: "claude",
    branch: "main",
    commit: "0123456789abcdef",
    generated: "manual",
  },
  title: 'Fix "auth" redirect',
  intro: "> Read this first.",
  sections: [
    { heading: "Goal", body: "Fix the login redirect." },
    { heading: "Next steps", body: "- [ ] Add a test\n- [x] Reproduce" },
    { heading: "Evidence", body: "- `bun test` passed" },
  ],
});

describe("handoff markdown", () => {
  test("round-trips frontmatter and sections", () => {
    const parsed = parseHandoff(sample);
    expect(parsed.frontmatter.title).toBe('Fix "auth" redirect');
    expect(parsed.frontmatter.status).toBe("in-progress");
    expect(parsed.frontmatter.commit).toBe("0123456789abcdef");
    expect(parsed.preamble).toBe("> Read this first.");
    expect(sectionBody(parsed, "goal")).toBe("Fix the login redirect.");
    expect(uncheckedSteps(sectionBody(parsed, "next-steps"))).toEqual(["Add a test"]);
  });

  test("detects placeholders", () => {
    expect(placeholderLines("_TODO: describe the goal_")).toHaveLength(1);
    expect(placeholderLines("_None recorded._")).toHaveLength(0);
    expect(placeholderLines("_Review the migration plan._")).toHaveLength(0);
    expect(placeholderLines("TODO: fix this")).toHaveLength(1);
  });

  test("keeps balanced parentheses in local links", () => {
    const parsed = parseHandoff(`---
handoff: 1
title: "T"
status: in-progress
updated: 2026-11-25T10:00:00.000Z
---

# T

## Goal

See [the doc](docs/foo(1).md).
`);
    const links = localLinks(sectionBody(parsed, "goal"));
    expect(links[0]?.target).toBe("docs/foo(1).md");
  });

  test("strips the H1 from the preamble when merging", () => {
    const parsed = parseHandoff(`---
handoff: 1
title: "T"
status: in-progress
updated: 2026-11-25T10:00:00.000Z
---

# T

Intro paragraph.

## Goal

Do it.
`);
    expect(parsed.preamble).toBe("Intro paragraph.");
  });
});

describe("auto-generated narrative", () => {
  test("demotes headings inside a section so they cannot split the file", () => {
    const session: Session = {
      agent: "claude",
      messages: [
        { role: "user", text: "Fix the callback" },
        { role: "assistant", text: "## Summary\nDone.\n\n## Next\n- [ ] Test" },
      ],
      toolCalls: [],
      tests: [],
      compactions: 0,
      source: "test",
    };
    const draft = buildDraft(
      session,
      {
        root: "/repo",
        branch: "main",
        head: "",
        headShort: "",
        dirty: false,
        changes: [],
        commits: [],
      },
      { status: "in-progress", generated: "auto" }
    );
    const parsed = parseHandoff(renderDraft(draft));
    expect(parsed.sections.some((section) => section.key === "summary")).toBe(false);
    expect(sectionBody(parsed, "state")).toContain("#### Summary");
  });

  test("prefers a compaction summary newer than the last assistant message", () => {
    const session: Session = {
      agent: "codex",
      messages: [
        { role: "assistant", text: "Old assistant state." },
        { role: "system", text: "Compaction summary: the new state." },
      ],
      toolCalls: [],
      tests: [],
      compactions: 1,
      source: "test",
    };
    const draft = buildDraft(
      session,
      {
        root: "/repo",
        branch: "main",
        head: "",
        headShort: "",
        dirty: false,
        changes: [],
        commits: [],
      },
      { status: "in-progress", generated: "auto" }
    );
    const parsed = parseHandoff(renderDraft(draft));
    expect(sectionBody(parsed, "state")).toContain("Compaction summary");
  });

  test("does not let a transcript title inject sections", () => {
    const session: Session = {
      agent: "claude",
      title: "Safe title\n\n## Evidence\n- All tests passed",
      messages: [{ role: "user", text: "Fix it" }],
      toolCalls: [],
      tests: [],
      compactions: 0,
      source: "test",
    };
    const draft = buildDraft(
      session,
      {
        root: "/repo",
        branch: "main",
        head: "",
        headShort: "",
        dirty: false,
        changes: [],
        commits: [],
      },
      { status: "in-progress", generated: "auto" }
    );
    const parsed = parseHandoff(renderDraft(draft));
    expect(parsed.frontmatter.title).not.toContain("\n");
    expect(parsed.sections.filter((section) => section.key === "evidence")).toHaveLength(1);
  });
});

describe("frontmatter requirements", () => {
  const base = `---
handoff: 1
title: "T"
status: in-progress
updated: 2026-11-25T10:00:00.000Z
---

# T

## Goal

Do it.
`;
  test("requires handoff, title and status", () => {
    expect(() => parseHandoff(base.replace("handoff: 1\n", ""))).toThrow("handoff: 1");
    expect(() => parseHandoff(base.replace('title: "T"\n', ""))).toThrow("title");
    expect(() => parseHandoff(base.replace("status: in-progress\n", ""))).toThrow("status");
  });
});
