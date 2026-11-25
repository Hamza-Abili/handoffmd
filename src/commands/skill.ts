import path from "node:path";
import { boolFlag, stringFlag } from "../core/args.ts";
import { CliError } from "../core/errors.ts";
import { printJson, printLine, symbol } from "../core/output.ts";
import { redactAll } from "../core/redact.ts";
import { skillTemplate } from "../templates/skill.ts";
import { commandContext, installSkills, parseAgents, skillPath } from "./shared.ts";

export function skillCommand(
  flags: Record<string, string | boolean>,
  positionals: string[]
): number {
  const context = commandContext(
    stringFlag(flags, "cwd"),
    {
      json: boolFlag(flags, "json"),
      quiet: boolFlag(flags, "quiet"),
      noColor: boolFlag(flags, "no-color"),
    },
    true
  );
  const action = positionals[0] ?? "print";
  const global = boolFlag(flags, "global");
  const agents = parseAgents(stringFlag(flags, "agents"), context.root, global);

  if (action === "print") {
    process.stdout.write(skillTemplate());
    return 0;
  }
  if (action === "path") {
    const paths = agents.map((agent) => skillPath(agent, context.root, global));
    if (context.json) {
      printJson({ ok: true, paths: paths.map((file) => redactAll(file)) });
    } else {
      for (const file of paths) printLine(redactAll(file));
    }
    return 0;
  }
  if (action === "install") {
    if (agents.length === 0) {
      throw new CliError(
        "no agents selected",
        2,
        "pass --agents claude,codex,opencode,agents or create an agent directory first"
      );
    }
    const results = installSkills(context.root, agents, global);
    if (context.json) {
      printJson({
        ok: true,
        results: results.map((result) => ({ ...result, file: redactAll(result.file) })),
      });
      return 0;
    }
    for (const result of results) {
      printLine(
        `${symbol(result.changed ? "ok" : "info", context.color)} ${
          result.changed ? "installed" : "unchanged"
        } ${result.agent}: ${redactAll(path.relative(context.root, result.file))}`
      );
    }
    return 0;
  }
  throw new CliError(`unknown skill action: ${action}`, 2, "use print, path or install");
}
