import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";

rmSync("dist", { recursive: true, force: true });
mkdirSync("dist", { recursive: true });

const result = await Bun.build({
  entrypoints: ["./src/cli.ts"],
  outdir: "./dist",
  target: "node",
  format: "esm",
  minify: false,
  sourcemap: "none",
  naming: "cli.js",
});

if (!result.success) {
  for (const log of result.logs) console.error(log);
  process.exit(1);
}

const file = "./dist/cli.js";
let code = readFileSync(file, "utf8");
if (!code.startsWith("#!")) {
  code = `#!/usr/bin/env node\n${code}`;
  writeFileSync(file, code, "utf8");
}
try {
  chmodSync(file, 0o755);
} catch {
  // Windows filesystems may not expose POSIX modes.
}
console.log(`built ${file} (${(code.length / 1024).toFixed(1)} KiB)`);
