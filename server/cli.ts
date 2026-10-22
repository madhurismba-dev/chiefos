import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";
import { defaultConfig, detectAuth } from "./config";
import type { SdkLike } from "./runtime";
import { startServer } from "./server";

/**
 * `npx agentstaff local` / `npm run local`: start the local server and open the UI.
 *
 *   --port <n>            Port on 127.0.0.1 (default 4317)
 *   --root <dir>          Parent folder for agent folders (default ~/AgentStaff)
 *   --no-open             Don't open the browser
 *   --allow-origin <url>  Also accept this UI origin, e.g. http://localhost:3000 for `next dev` (repeatable)
 *   --plugin <file>       Load a plugin module (repeatable)
 *   --rebuild             Rebuild the static UI first
 */

const HELP = `Usage: agentstaff local [--port 4317] [--root ~/AgentStaff] [--no-open]
                       [--allow-origin URL] [--plugin FILE] [--rebuild]`;

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      port: { type: "string" },
      root: { type: "string" },
      "no-open": { type: "boolean" },
      "allow-origin": { type: "string", multiple: true },
      plugin: { type: "string", multiple: true },
      rebuild: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  if (values.help || (positionals[0] && positionals[0] !== "local")) {
    console.log(HELP);
    process.exit(values.help ? 0 : 1);
  }

  const repoRoot = path.resolve(__dirname, "..");
  const config = defaultConfig(repoRoot);
  if (values.port) config.port = Number(values.port);
  if (values.root) {
    config.root = path.resolve(values.root.replace(/^~(?=$|\/)/, os.homedir()));
    config.stateDir = path.join(config.root, ".agentstaff");
  }
  config.open = !values["no-open"];
  config.extraOrigins = values["allow-origin"] ?? [];
  config.plugins = values.plugin ?? [];

  if (values.rebuild || !fs.existsSync(path.join(config.outDir, "index.html"))) {
    console.log("Building the UI (next build)…");
    const nextBin = require.resolve("next/dist/bin/next", { paths: [repoRoot] });
    const r = spawnSync(process.execPath, [nextBin, "build"], { cwd: repoRoot, stdio: "inherit" });
    if (r.status !== 0) process.exit(r.status ?? 1);
  }

  const auth = detectAuth(process.env);
  // The SDK is ESM-only; a dynamic import keeps this entry point working however tsx loads it.
  const sdk = (await import("@anthropic-ai/claude-agent-sdk")) as SdkLike;
  let handle;
  try {
    handle = await startServer(config, { sdk });
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "EADDRINUSE") {
      console.error(`Port ${config.port} is in use. Try: npm run local -- --port ${config.port + 1}`);
      process.exit(1);
    }
    throw err;
  }

  const uiUrl = `${handle.url}#token=${handle.token}`;
  console.log(
    [
      "",
      "AgentStaff local mode",
      `  Open:     ${uiUrl}`,
      `  Folders:  ${config.root}${path.sep}<agent id>`,
      `  Auth:     ${auth.detail}`,
      ...(config.extraOrigins.length
        ? [`  Dev UI:   ${config.extraOrigins[0]}/#token=${handle.token}&port=${config.port}`]
        : []),
      ...(handle.plugins.list().length ? [`  Plugins:  ${handle.plugins.list().join(", ")}`] : []),
      "",
      "  Listening on 127.0.0.1 only. The token above changes every launch; don't share the link.",
      "  Press Ctrl+C to stop.",
      "",
    ].join("\n"),
  );
  if (auth.mode === "missing") console.warn("  No credentials found: agents won't run until you set ANTHROPIC_API_KEY.\n");
  if (config.open) openBrowser(uiUrl);

  const shutdown = async () => {
    await handle.close();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

function openBrowser(url: string) {
  const [cmd, args] =
    process.platform === "darwin" ? ["open", [url]] : process.platform === "win32" ? ["cmd", ["/c", "start", "", url]] : ["xdg-open", [url]];
  try {
    spawn(cmd, args as string[], { stdio: "ignore", detached: true }).on("error", () => undefined).unref();
  } catch {
    /* no browser: the URL is printed above */
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
