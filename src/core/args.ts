import { CliError } from "./errors.ts";

export interface ParsedArgs {
  command: string;
  positionals: string[];
  flags: Record<string, string | boolean>;
}

const BOOLEAN_FLAGS = new Set([
  "help",
  "version",
  "json",
  "quiet",
  "strict",
  "full",
  "rewrite",
  "lock",
  "new",
  "dry-run",
  "no-redact",
  "no-color",
  "no-instructions",
  "no-skill",
  "no-secrets",
  "allow-stale",
  "include-sidechains",
  "manual",
  "force",
  "global",
  "yes",
  "all",
  "check",
]);

export function parseArgs(argv: string[]): ParsedArgs {
  const args = [...argv];
  let command = args.shift() ?? "help";
  if (command === "-h" || command === "--help") command = "help";
  if (command === "-v" || command === "--version") command = "version";

  const positionals: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (!arg.startsWith("-")) {
      positionals.push(arg);
      continue;
    }
    if (arg.startsWith("--")) {
      const eq = arg.indexOf("=");
      if (eq !== -1) {
        const key = arg.slice(2, eq);
        flags[key] = arg.slice(eq + 1);
        continue;
      }
      const key = arg.slice(2);
      if (BOOLEAN_FLAGS.has(key)) {
        flags[key] = true;
        continue;
      }
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("-")) {
        flags[key] = next;
        i++;
        continue;
      }
      flags[key] = true;
      continue;
    }
    const short = arg.slice(1);
    if (short === "h") flags.help = true;
    else if (short === "v") flags.version = true;
    else if (short === "q") flags.quiet = true;
    else throw new CliError(`unknown option: ${arg}`, 2, "run handoffmd help");
  }

  return { command, positionals, flags };
}

export function stringFlag(
  flags: Record<string, string | boolean>,
  name: string,
  fallback?: string
): string | undefined {
  const value = flags[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") {
    throw new CliError(`--${name} requires a value`, 2);
  }
  return value;
}

export function intFlag(
  flags: Record<string, string | boolean>,
  name: string,
  fallback: number
): number {
  const raw = stringFlag(flags, name);
  if (raw === undefined) return fallback;
  if (!/^\d+$/.test(raw)) {
    throw new CliError(`--${name} must be a non-negative integer`, 2);
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value)) {
    throw new CliError(`--${name} must be a non-negative integer`, 2);
  }
  return value;
}

export function boolFlag(flags: Record<string, string | boolean>, name: string): boolean {
  return flags[name] === true;
}

export function assertNoUnknownFlags(
  flags: Record<string, string | boolean>,
  allowed: string[]
): void {
  const known = new Set([...allowed, "help", "json", "quiet", "no-color", "cwd"]);
  for (const key of Object.keys(flags)) {
    if (!known.has(key)) {
      throw new CliError(`unknown option: --${key}`, 2, "run handoffmd help");
    }
  }
}
