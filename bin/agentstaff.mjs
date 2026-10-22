#!/usr/bin/env node
// `npx agentstaff local` from a clone of this repo: runs server/cli.ts with tsx.
import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const tsx = createRequire(import.meta.url).resolve("tsx/cli");
const child = spawn(process.execPath, [tsx, path.join(repo, "server", "cli.ts"), ...process.argv.slice(2)], {
  stdio: "inherit",
});
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
child.on("exit", (code) => process.exit(code ?? 0));
