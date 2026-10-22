import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { WebSocketServer, type WebSocket } from "ws";
import {
  ClientMessageSchema,
  PROTOCOL_VERSION,
  WS_PATH,
  WS_PROTOCOL,
  type ServerEvent,
} from "../src/lib/local/protocol";
import { detectAuth, type Env, type LocalConfig } from "./config";
import { NotesStore } from "./notes";
import { isWithin } from "./permissions";
import { PluginRegistry, loadPlugins } from "./plugins";
import { Runtime, VERSION, type SdkLike } from "./runtime";
import { hostAllowed, newToken, originAllowed, redact, tokenFromProtocols, tokenMatches } from "./security";
import { SessionStore } from "./sessions";

/**
 * The local server: serves the static UI and one WebSocket for commands and streaming.
 * Binds to 127.0.0.1 only. See security.ts for what every WebSocket connection must prove.
 */

const MAX_MESSAGE_BYTES = 1024 * 1024;

const TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".woff2": "font/woff2",
  ".txt": "text/plain; charset=utf-8",
};

export interface ServerHandle {
  url: string;
  token: string;
  runtime: Runtime;
  plugins: PluginRegistry;
  close(): Promise<void>;
}

export interface ServerDeps {
  sdk: SdkLike;
  env?: Env;
  log?: (message: string) => void;
  /** Use a fixed token (tests). Normally a fresh random one per launch. */
  token?: string;
  /** Register plugins in code (tests, or a private edition's own entry point). */
  plugins?: PluginRegistry;
}

export async function startServer(config: LocalConfig, deps: ServerDeps): Promise<ServerHandle> {
  const env = deps.env ?? process.env;
  const token = deps.token ?? newToken();
  const log = (m: string) => (deps.log ?? console.log)(redact(m, [token]));
  const auth = detectAuth(env);

  fs.mkdirSync(config.stateDir, { recursive: true, mode: 0o700 });
  const sessions = new SessionStore(path.join(config.stateDir, "sessions.json"));
  const notes = new NotesStore(path.join(config.stateDir, "notes.json"));
  const plugins = deps.plugins ?? new PluginRegistry();
  await loadPlugins(plugins, config.plugins);

  const clients = new Set<WebSocket>();
  const send = (ws: WebSocket, ev: ServerEvent) => ws.readyState === ws.OPEN && ws.send(JSON.stringify(ev));
  const broadcast = (ev: ServerEvent) => clients.forEach((ws) => send(ws, ev));

  const runtime = new Runtime({ sdk: deps.sdk, config, sessions, notes, plugins, auth, emit: broadcast, env, log });

  const server = http.createServer((req, res) => serveStatic(config.outDir, req, res));

  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_MESSAGE_BYTES,
    handleProtocols: (protocols) => (protocols.has(WS_PROTOCOL) ? WS_PROTOCOL : false),
  });

  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://127.0.0.1");
    const reject = (status: string, why: string) => {
      log(`Refused a WebSocket connection: ${why}`);
      socket.write(`HTTP/1.1 ${status}\r\nConnection: close\r\n\r\n`);
      socket.destroy();
    };
    if (url.pathname !== WS_PATH) return reject("404 Not Found", "unknown path");
    if (!hostAllowed(req.headers.host, config.port)) return reject("403 Forbidden", "bad Host header");
    if (!originAllowed(req.headers.origin, config.port, config.extraOrigins)) return reject("403 Forbidden", "Origin not allowed");
    const given = tokenFromProtocols(req.headers["sec-websocket-protocol"]) ?? headerValue(req.headers["x-agentstaff-token"]);
    if (!tokenMatches(token, given)) return reject("401 Unauthorized", "missing or wrong token");
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws: WebSocket) => {
    clients.add(ws);
    send(ws, {
      type: "ready",
      protocol: PROTOCOL_VERSION,
      version: VERSION,
      auth,
      root: config.root,
      roles: plugins.roleInfo(),
      approvals: runtime.pendingApprovals(),
      busy: runtime.busyThreads(),
    });
    ws.on("close", () => clients.delete(ws));
    ws.on("message", (raw) => {
      let parsed;
      try {
        parsed = ClientMessageSchema.safeParse(JSON.parse(raw.toString()));
      } catch {
        return send(ws, { type: "error", message: "Invalid JSON." });
      }
      if (!parsed.success) return send(ws, { type: "error", message: `Invalid message: ${parsed.error.issues[0]?.message ?? ""}` });
      const msg = parsed.data;
      switch (msg.type) {
        case "workspace":
          runtime.setWorkspace(msg.org, msg.settings);
          break;
        case "send":
          if (!runtime.getOrg()) return send(ws, { type: "error", message: "Send the workspace first." });
          runtime.sendFromCeo(msg.agentId, msg.text).catch((err) => {
            if (!(err instanceof DOMException && err.name === "AbortError")) log(`Turn failed: ${err instanceof Error ? err.message : err}`);
          });
          break;
        case "stop":
          runtime.stop(msg.threadId);
          break;
        case "approval":
          runtime.answerApproval(msg.id, msg.allow);
          break;
        case "reset_sessions":
          runtime.resetSessions(msg.agentId);
          break;
      }
    });
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    // 127.0.0.1 only. Not configurable on purpose: this server can run tools on your machine.
    server.listen(config.port, "127.0.0.1", () => resolve());
  });
  const port = (server.address() as { port: number }).port;
  config.port = port; // when started with port 0 (tests)

  await plugins.setup({
    sendFromCeo: (agentId, text) => runtime.sendFromCeo(agentId, text),
    stop: (threadId) => runtime.stop(threadId),
    org: () => runtime.getOrg(),
    log,
  });

  return {
    url: `http://127.0.0.1:${port}/`,
    token,
    runtime,
    plugins,
    close: () =>
      new Promise<void>((resolve) => {
        clients.forEach((ws) => ws.terminate());
        wss.close();
        server.close(() => resolve());
      }),
  };
}

function headerValue(h: string | string[] | undefined) {
  return Array.isArray(h) ? h[0] : h;
}

function serveStatic(outDir: string, req: http.IncomingMessage, res: http.ServerResponse) {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "no-referrer");
  res.setHeader("X-Frame-Options", "DENY");
  if (req.method !== "GET" && req.method !== "HEAD") {
    res.writeHead(405).end();
    return;
  }
  let pathname: string;
  try {
    pathname = decodeURIComponent(new URL(req.url ?? "/", "http://127.0.0.1").pathname);
  } catch {
    res.writeHead(400).end();
    return;
  }
  const base = path.resolve(outDir);
  const candidates = pathname.endsWith("/")
    ? [path.join(base, pathname, "index.html")]
    : [path.join(base, pathname), path.join(base, `${pathname}.html`), path.join(base, pathname, "index.html")];
  const file = candidates.find((f) => isWithin(base, f) && fs.statSync(f, { throwIfNoEntry: false })?.isFile());
  if (!file) {
    const notFound = path.join(base, "404.html");
    res.writeHead(404, { "Content-Type": TYPES[".html"] });
    res.end(fs.existsSync(notFound) ? fs.readFileSync(notFound) : "Not found");
    return;
  }
  const ext = path.extname(file);
  res.writeHead(200, {
    "Content-Type": TYPES[ext] ?? "application/octet-stream",
    "Cache-Control": ext === ".html" ? "no-store" : "public, max-age=3600",
  });
  if (req.method === "HEAD") res.end();
  else fs.createReadStream(file).pipe(res);
}
