import path from "node:path";
import { isExcluded, isHandoffPath, statePath } from "./config.ts";
import { assertSafeRead, readJsonIfExists, sha256, writeFileInside } from "./fs.ts";
import {
  changedFilesBetween,
  commitsBetween,
  filesAtCommit,
  git,
  hashChanges,
  isAncestor,
  repoSnapshot,
} from "./git.ts";
import { redactAll } from "./redact.ts";
import type { CheckFinding, Config, HandoffState, RepoSnapshot, Session } from "./types.ts";

export function readState(root: string): HandoffState | null {
  assertSafeRead(root, statePath(root));
  return readJsonIfExists<HandoffState>(statePath(root));
}

export function writeState(root: string, state: HandoffState): void {
  writeFileInside(root, statePath(root), `${JSON.stringify(state, null, 2)}\n`, 0o644);
}

function handoffHash(raw: string): string {
  return sha256(raw.replace(/\r\n/g, "\n"));
}

export function createState(
  root: string,
  handoffRaw: string,
  snapshot: RepoSnapshot,
  session: Session | null,
  config: Config
): HandoffState {
  const changes = hashChanges(
    root,
    snapshot.changes.filter(
      (change) => !isHandoffPath(config, change.path) && !isExcluded(config, change.path)
    )
  );
  return {
    version: 1,
    savedAt: new Date().toISOString(),
    handoffSha256: handoffHash(handoffRaw),
    repo: {
      branch: snapshot.branch,
      head: snapshot.head,
      headShort: snapshot.headShort,
      dirty: changes.length > 0,
    },
    changes,
    session: session
      ? {
          agent: session.agent,
          id: session.id ? redactAll(session.id) : undefined,
          model: session.model ? redactAll(session.model) : undefined,
          source: redactAll(path.basename(session.source)),
          updatedAt: session.updatedAt,
          compactions: session.compactions,
        }
      : undefined,
  };
}

export interface Freshness {
  findings: CheckFinding[];
  stale: boolean;
  commitsSince: string[];
  changedSince: string[];
  drifted: string[];
  newChanges: string[];
  missingChanges: string[];
  headMoved: boolean;
}

export function checkFreshness(
  root: string,
  state: HandoffState,
  handoffRaw: string,
  config: Config
): Freshness {
  const findings: CheckFinding[] = [];
  const result: Freshness = {
    findings,
    stale: false,
    commitsSince: [],
    changedSince: [],
    drifted: [],
    newChanges: [],
    missingChanges: [],
    headMoved: false,
  };

  const actualHandoffSha = handoffHash(handoffRaw);
  if (state.handoffSha256 !== actualHandoffSha) {
    findings.push({
      level: "error",
      code: "HANDOFF_CHANGED",
      message: "HANDOFF.md changed after the last save, so the recorded evidence is out of date.",
      hint: "review the file, then run `handoffmd save --lock`",
    });
    result.stale = true;
  }

  const snapshot = repoSnapshot(root, {
    exclude: [config.file, ".handoff/**"],
  });
  const handoffOnly = (file: string) => {
    const normalized = file.replaceAll("\\", "/");
    return isHandoffPath(config, normalized);
  };

  if (!state.repo.head && snapshot.head) {
    result.headMoved = true;
    const changed = filesAtCommit(root, snapshot.head).filter((file) => !handoffOnly(file));
    if (changed.length > 0) {
      findings.push({
        level: "error",
        code: "HEAD_CREATED",
        message: `Repository created its first commit ${snapshot.headShort}; ${changed.length} file(s) are not covered by the handoff.`,
        hint: "run `handoffmd save` after the first commit",
      });
      result.stale = true;
    } else {
      findings.push({
        level: "info",
        code: "HEAD_CREATED",
        message: `Repository created its first commit ${snapshot.headShort} with handoff-only changes.`,
      });
    }
  }

  if (state.repo.head && snapshot.head && state.repo.head !== snapshot.head) {
    result.headMoved = true;
    if (isAncestor(root, state.repo.head, snapshot.head)) {
      const changed = changedFilesBetween(root, state.repo.head, snapshot.head).filter(
        (file) => !handoffOnly(file)
      );
      result.changedSince = changed;
      result.commitsSince = commitsBetween(root, state.repo.head, snapshot.head);
      if (changed.length > 0) {
        findings.push({
          level: "error",
          code: "HEAD_MOVED",
          message: `Repository moved to ${snapshot.headShort}; ${changed.length} non-handoff file(s) changed since the save.`,
          hint: "re-run `handoffmd save` to refresh the evidence",
        });
        result.stale = true;
      } else {
        findings.push({
          level: "info",
          code: "HEAD_ADVANCED",
          message: `HEAD advanced to ${snapshot.headShort} with handoff-only changes.`,
        });
      }
    } else {
      findings.push({
        level: "error",
        code: "HISTORY_REWRITTEN",
        message: "The saved commit is no longer an ancestor of HEAD (rebase, reset or filter).",
        hint: "run `handoffmd save` to rebase the handoff evidence",
      });
      result.stale = true;
    }
  }

  if (state.repo.branch !== snapshot.branch) {
    findings.push({
      level: "warning",
      code: "BRANCH_CHANGED",
      message: `Handoff was saved on '${state.repo.branch}', current branch is '${snapshot.branch}'.`,
      hint: "confirm the handoff still applies, or re-save on this branch",
    });
  }

  const current = new Map(
    snapshot.changes
      .filter((change) => !handoffOnly(change.path) && !isExcluded(config, change.path))
      .map((change) => [change.path, change])
  );
  const saved = new Map(state.changes.map((change) => [change.path, change]));

  for (const change of state.changes) {
    const now = current.get(change.path);
    if (!now) {
      result.missingChanges.push(change.path);
      continue;
    }
    if (change.sha256 && now.sha256 && change.sha256 !== now.sha256) {
      result.drifted.push(change.path);
    }
  }
  for (const file of current.keys()) {
    if (!saved.has(file)) result.newChanges.push(file);
  }

  if (result.missingChanges.length > 0) {
    findings.push({
      level: "error",
      code: "CHANGES_CLEANED",
      message: `${result.missingChanges.length} file(s) recorded at save time are no longer modified (${preview(
        result.missingChanges
      )}).`,
      hint: "re-run `handoffmd save` so the evidence matches the worktree",
    });
    result.stale = true;
  }
  if (result.drifted.length > 0) {
    findings.push({
      level: "error",
      code: "FILE_DRIFT",
      message: `${result.drifted.length} file(s) changed after the handoff was saved (${preview(
        result.drifted
      )}).`,
      hint: "review the new changes, then run `handoffmd save --lock`",
    });
    result.stale = true;
  }
  if (result.newChanges.length > 0) {
    findings.push({
      level: "error",
      code: "NEW_CHANGES",
      message: `${result.newChanges.length} new worktree change(s) are not covered by the handoff (${preview(
        result.newChanges
      )}).`,
      hint: "run `handoffmd save` to include them",
    });
    result.stale = true;
  }

  return result;
}

function preview(files: string[]): string {
  const shown = files.slice(0, 3).join(", ");
  return files.length > 3 ? `${shown}, +${files.length - 3} more` : shown;
}

export interface StateDiff {
  commitsSince: Array<{ sha: string; subject: string }>;
  changedSince: string[];
  drifted: string[];
  newChanges: string[];
  missingChanges: string[];
  branchChanged: boolean;
  headMoved: boolean;
}

export function diffState(root: string, state: HandoffState, config: Config): StateDiff {
  const snapshot = repoSnapshot(root, { exclude: [config.file, ".handoff/**"] });
  const commits = commitsBetween(root, state.repo.head, snapshot.head);
  const changed = changedFilesBetween(root, state.repo.head, snapshot.head).filter(
    (file) => !isHandoffPath(config, file)
  );
  const current = new Map(
    snapshot.changes
      .filter((change) => !isHandoffPath(config, change.path) && !isExcluded(config, change.path))
      .map((change) => [change.path, change])
  );
  const saved = new Map(state.changes.map((change) => [change.path, change]));
  const drifted = state.changes
    .filter((change) => {
      const now = current.get(change.path);
      return now && change.sha256 && now.sha256 && change.sha256 !== now.sha256;
    })
    .map((change) => change.path);
  const missing = state.changes.filter((change) => !current.has(change.path)).map((c) => c.path);
  const added = [...current.keys()].filter((file) => !saved.has(file));

  return {
    commitsSince: commits.map((sha) => {
      const subject = gitSubject(root, sha);
      return { sha, subject };
    }),
    changedSince: changed,
    drifted,
    newChanges: added,
    missingChanges: missing,
    branchChanged: state.repo.branch !== snapshot.branch,
    headMoved: state.repo.head !== snapshot.head,
  };
}

function gitSubject(root: string, sha: string): string {
  try {
    return git(root, ["log", "-1", "--format=%s", sha]);
  } catch {
    return "";
  }
}
