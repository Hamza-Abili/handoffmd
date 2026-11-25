import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { checkCommand } from "./commands/check.ts";
import { diffCommand } from "./commands/diff.ts";
import { doctorCommand } from "./commands/doctor.ts";
import { initCommand } from "./commands/init.ts";
import { listCommand, pruneCommand } from "./commands/list.ts";
import { loadCommand } from "./commands/load.ts";
import { saveCommand } from "./commands/save.ts";
import { showCommand } from "./commands/show.ts";
import { skillCommand } from "./commands/skill.ts";
import { assertNoUnknownFlags, parseArgs } from "./core/args.ts";
import { isCliError } from "./core/errors.ts";
import { realpathSafe } from "./core/fs.ts";
import { errorLine, printLine } from "./core/output.ts";
import { redactAll } from "./core/redact.ts";

const VERSION = (() => {
  try {
    const file = new URL("../package.json", import.meta.url);
    return (JSON.parse(readFileSync(file, "utf8")) as { version?: string }).version ?? "0.1.1";
  } catch {
    return "0.1.1";
  }
})();

const GLOBAL =
  "  --cwd <dir>   repository directory (default: current)\n  --json        machine-readable output\n  --quiet       suppress human output\n  --no-color    disable colors";

const HELP: Record<string, string> = {
  init: `handoffmd init — create HANDOFF.md, config and the agent skill

Usage: handoffmd init [options]

  --agents <list>  claude,codex,opencode,agents,all or auto (default: auto)
  --global         install the skill in the home directory
  --force          overwrite an existing HANDOFF.md
  --no-skill       do not install the agent skill

${GLOBAL}`,
  save: `handoffmd save — capture a session and git evidence into HANDOFF.md

Usage: handoffmd save [options]

  --from <agent>       claude, codex, opencode, generic, auto (default: auto)
  --session <id>       specific session id
  --transcript <file>  parse a JSONL/JSON transcript instead of discovery
  --manual             no transcript; build from git evidence only
  --status <status>    in-progress, blocked, review, done
  --title <text>       override the title
  --rewrite            regenerate the narrative (destructive)
  --new                archive the current handoff, then create a new one
  --lock               only refresh evidence after you edited HANDOFF.md
  --dry-run            print what would be written, change nothing
  --no-redact          disable secret redaction (check still flags secrets)
  --include-sidechains include Claude subagent transcripts
  --test <command>     run a test command and record fresh evidence
  --test-timeout <s>   timeout for --test (default: 120 seconds)

${GLOBAL}`,
  check: `handoffmd check — validate structure, freshness, secrets, links and budget

Usage: handoffmd check [options]
Exit: 0 clean, 1 findings, 2 usage/internal error

  --strict      fail on warnings too
  --max-age <n> override the maximum age in days (0 disables)
  --allow-stale downgrade freshness errors to warnings
  --no-secrets  skip the secret scan (not recommended)

${GLOBAL}`,
  load: `handoffmd load — print a compact brief for the next agent

Usage: handoffmd load [options]

  --for <agent>     claude, codex, opencode, generic (default: generic)
  --max-tokens <n>  budget for the brief (default: config.loadMaxTokens)
  --full            include every section, ignore the budget
  --check           refuse to load a stale or invalid handoff
  --no-instructions omit the "how to continue" block

${GLOBAL}`,
  show: `handoffmd show — show the current handoff and its evidence

Usage: handoffmd show [options]

${GLOBAL}`,
  diff: `handoffmd diff — show what changed since the handoff was saved

Usage: handoffmd diff [options]

${GLOBAL}`,
  list: `handoffmd list — list the current and archived handoffs

Usage: handoffmd list [options]

${GLOBAL}`,
  prune: `handoffmd prune — delete old archived handoffs

Usage: handoffmd prune [options]

  --keep <n>  number of archives to keep (default: 10)
  --yes       actually delete; without it the command is a dry run

${GLOBAL}`,
  doctor: `handoffmd doctor — diagnose setup, sessions and configuration

Usage: handoffmd doctor [options]

${GLOBAL}`,
  skill: `handoffmd skill — print, locate or install the agent skill

Usage: handoffmd skill <print|path|install> [options]

  --agents <list>  claude,codex,opencode,agents,all or auto
  --global         use the home directory instead of the repository

${GLOBAL}`,
};

function helpText(command?: string): string {
  if (command && HELP[command]) return HELP[command];
  return `handoffmd ${VERSION} — verified session handoffs for any coding agent

Usage:
  handoffmd <command> [options]

Commands:
  init      create HANDOFF.md, config and the agent skill
  save      capture a session + git evidence into HANDOFF.md
  check     validate structure, freshness, secrets and links (CI)
  load      print a compact brief for the next agent
  show      show the current handoff
  diff      show what changed since the handoff
  list      list current and archived handoffs
  prune     delete old archived handoffs
  doctor    diagnose setup and session discovery
  skill     print or install the agent skill
  help      show help for a command
  version   show the version

Global options:
${GLOBAL}

Examples:
  npx @hamzaabili/handoffmd init
  npx @hamzaabili/handoffmd save --from claude
  npx @hamzaabili/handoffmd check --strict
  npx @hamzaabili/handoffmd load --for codex

Docs: https://github.com/Hamza-Abili/handoffmd`;
}

const ALLOWED: Record<string, string[]> = {
  init: ["agents", "global", "force", "no-skill"],
  save: [
    "from",
    "session",
    "transcript",
    "status",
    "title",
    "manual",
    "rewrite",
    "lock",
    "new",
    "dry-run",
    "no-redact",
    "include-sidechains",
    "test",
    "test-timeout",
  ],
  check: ["strict", "max-age", "no-secrets", "allow-stale"],
  load: ["for", "max-tokens", "full", "check", "no-instructions"],
  show: [],
  diff: [],
  list: [],
  prune: ["keep", "yes"],
  doctor: [],
  skill: ["agents", "global"],
};

export async function main(argv = process.argv.slice(2)): Promise<number> {
  try {
    const { command, positionals, flags } = parseArgs(argv);
    if (command === "help") {
      printLine(helpText(positionals[0]));
      return 0;
    }
    if (command === "version") {
      printLine(VERSION);
      return 0;
    }
    if (!ALLOWED[command]) {
      errorLine(`handoffmd: unknown command: ${redactAll(command)}`);
      errorLine(helpText());
      return 2;
    }
    if (flags.help) {
      printLine(helpText(command));
      return 0;
    }
    assertNoUnknownFlags(flags, ALLOWED[command]);

    switch (command) {
      case "init":
        return initCommand(flags);
      case "save":
        return await saveCommand(flags);
      case "check":
        return checkCommand(flags);
      case "load":
        return loadCommand(flags);
      case "show":
        return showCommand(flags);
      case "diff":
        return diffCommand(flags);
      case "list":
        return listCommand(flags);
      case "prune":
        return pruneCommand(flags);
      case "doctor":
        return await doctorCommand(flags);
      case "skill":
        return skillCommand(flags, positionals);
      default:
        return 2;
    }
  } catch (error) {
    const cli = isCliError(error);
    const message = redactAll(error instanceof Error ? error.message : String(error));
    errorLine(`handoffmd: ${message}`);
    if (cli && error.hint) errorLine(`  hint: ${redactAll(error.hint)}`);
    if (!cli && process.env.DEBUG) {
      errorLine(redactAll(error instanceof Error ? (error.stack ?? "") : String(error)));
    }
    return cli ? error.exitCode : 2;
  }
}

const isMain =
  Boolean(process.argv[1]) &&
  realpathSafe(process.argv[1]) === realpathSafe(fileURLToPath(import.meta.url));

if (isMain) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      errorLine(`handoffmd: ${redactAll(error instanceof Error ? error.message : String(error))}`);
      process.exitCode = 2;
    }
  );
}
