const CODES = {
  red: 31,
  green: 32,
  yellow: 33,
  blue: 34,
  magenta: 35,
  cyan: 36,
  gray: 90,
  bold: 1,
  dim: 2,
};

export function color(text: string, code: keyof typeof CODES, enabled: boolean): string {
  if (!enabled) return text;
  return `\u001b[${CODES[code]}m${text}\u001b[0m`;
}

export function symbol(
  level: "ok" | "warn" | "warning" | "error" | "info",
  enabled: boolean
): string {
  if (level === "ok") return color("✓", "green", enabled);
  if (level === "warn" || level === "warning") return color("⚠", "yellow", enabled);
  if (level === "error") return color("✗", "red", enabled);
  return color("·", "gray", enabled);
}

export function printJson(value: unknown): void {
  process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

export function printLine(line = ""): void {
  process.stdout.write(`${line}\n`);
}

export function errorLine(line: string): void {
  process.stderr.write(`${line}\n`);
}

export function table(rows: string[][]): string {
  if (rows.length === 0) return "";
  const widths = rows[0].map((_, index) =>
    Math.max(...rows.map((row) => (row[index] ?? "").length))
  );
  return rows
    .map((row) =>
      row
        .map((cell, index) => (cell ?? "").padEnd(widths[index]))
        .join("  ")
        .trimEnd()
    )
    .join("\n");
}
