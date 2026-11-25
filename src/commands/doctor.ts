import { existsSync } from "node:fs";
import path from "node:path";
import { loadSession } from "../adapters/index.ts";
import { opencodeDatabasePath } from "../adapters/opencode.ts";
import { boolFlag, stringFlag } from "../core/args.ts";
import { configPath } from "../core/config.ts";
import { assertSafeRead, readTextIfExists } from "../core/fs.ts";
import { parseHandoff } from "../core/markdown.ts";
import { printJson, printLine, symbol } from "../core/output.ts";
import { redactAll, scanSecrets } from "../core/redact.ts";
import { readState } from "../core/state.ts";
import { estimateTokens } from "../core/tokens.ts";
import { commandContext, type SkillAgent, skillPath } from "./shared.ts";

interface DoctorCheck {
  level: "ok" | "warning" | "error" | "info";
  code: string;
  message: string;
  hint?: string;
}

export async function doctorCommand(
  flags: Record<string, string | boolean>,
  context = commandContext(stringFlag(flags, "cwd"), {
    json: boolFlag(flags, "json"),
    quiet: boolFlag(flags, "quiet"),
    noColor: boolFlag(flags, "no-color"),
  })
): Promise<number> {
  const checks: DoctorCheck[] = [];
  const add = (level: DoctorCheck["level"], code: string, message: string, hint?: string) =>
    checks.push({ level, code, message, hint });

  const major = Number.parseInt(process.versions.node.split(".")[0], 10);
  if (major >= 22) add("ok", "node", `Node ${process.versions.node}`);
  else add("error", "node", `Node ${process.versions.node} is too old`, "use Node 22 or newer");

  add("ok", "git", `Git repository: ${redactAll(context.root)}`);
  if (existsSync(configPath(context.root))) add("ok", "config", "config present");
  else add("warning", "config", "no .handoff/config.json", "run `handoffmd init`");

  if (!existsSync(context.file)) {
    add(
      "error",
      "handoff",
      "HANDOFF.md is missing",
      "run `handoffmd init` or `handoffmd save --manual`"
    );
  } else {
    let readable = true;
    try {
      assertSafeRead(context.root, context.file);
    } catch (error) {
      readable = false;
      add(
        "error",
        "handoff",
        (error as Error).message,
        "replace the symlink with a real file inside the repository"
      );
    }
    let raw = "";
    if (readable) {
      try {
        raw = readTextIfExists(context.file) ?? "";
      } catch (error) {
        readable = false;
        add("error", "handoff", (error as Error).message, "reduce the handoff size");
      }
    }
    if (readable) {
      try {
        const parsed = parseHandoff(raw);
        add("ok", "handoff", `HANDOFF.md parses (${parsed.frontmatter.status})`);
        add("ok", "tokens", `~${estimateTokens(raw).toLocaleString()} tokens`);
        const secrets = scanSecrets(raw);
        if (secrets.length > 0) {
          add(
            "error",
            "secrets",
            `${secrets.length} possible secret(s) in HANDOFF.md`,
            "remove them or re-run save"
          );
        } else {
          add("ok", "secrets", "no obvious secrets");
        }
      } catch (error) {
        add(
          "error",
          "handoff",
          (error as Error).message,
          "fix the frontmatter or re-create the file"
        );
      }
    }
  }

  let state = null;
  let stateUnsafe = false;
  try {
    state = readState(context.root);
  } catch (error) {
    stateUnsafe = true;
    add("error", "state", (error as Error).message, "replace the symlink with a real state file");
  }
  if (state) {
    add("ok", "state", `state saved ${state.savedAt} (${state.changes.length} file(s))`);
  } else if (!stateUnsafe) {
    add("warning", "state", "no .handoff/state.json", "run `handoffmd save`");
  }

  const agents: SkillAgent[] = ["claude", "codex", "opencode", "agents"];
  for (const agent of agents) {
    const dir = path.join(context.root, `.${agent}`);
    if (!existsSync(dir)) continue;
    const file = skillPath(agent, context.root, false);
    if (existsSync(file)) add("ok", `skill-${agent}`, `skill installed for ${agent}`);
    else
      add(
        "warning",
        `skill-${agent}`,
        `${agent} directory found but no handoffmd skill`,
        "run `handoffmd skill install`"
      );
  }

  try {
    const session = await loadSession("auto", { cwd: context.root });
    if (session) {
      add(
        "ok",
        "session",
        `found ${session.agent} session ${session.id ? redactAll(session.id) : ""} (${session.messages.length} messages, ${session.tests.length} tests)`
      );
    } else {
      add("warning", "session", "no session found");
    }
  } catch (error) {
    add("warning", "session", (error as Error).message, "use --manual or --transcript");
  }

  const db = opencodeDatabasePath();
  if (db) add("ok", "opencode-db", `OpenCode database found: ${redactAll(db)}`);
  else add("info", "opencode-db", "no OpenCode database found");

  for (const check of checks) {
    check.message = redactAll(check.message);
    if (check.hint) check.hint = redactAll(check.hint);
  }
  const errors = checks.filter((check) => check.level === "error").length;
  const warnings = checks.filter((check) => check.level === "warning").length;
  if (context.json) {
    printJson({ ok: errors === 0, checks, errors, warnings });
    return errors === 0 ? 0 : 1;
  }
  if (!context.quiet) {
    for (const check of checks) {
      printLine(`${symbol(check.level, context.color)} ${check.message}`);
      if (check.hint) printLine(`  ${check.hint}`);
    }
    printLine("");
    printLine(`${errors} error(s), ${warnings} warning(s)`);
  }
  return errors === 0 ? 0 : 1;
}
