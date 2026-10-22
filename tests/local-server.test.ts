/**
 * Local server security: 127.0.0.1 only, per-launch token, Origin and Host checks, no path traversal
 * in static files, auth detection, and keys never reaching logs. Real HTTP/WebSocket on a random port;
 * the Agent SDK is faked, so nothing calls Anthropic.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, test } from "node:test";
import WebSocket from "ws";
import { WS_PROTOCOL, WS_TOKEN_PREFIX, type ServerEvent } from "../src/lib/local/protocol";
import { detectAuth, sdkEnv, type LocalConfig } from "../server/config";
import { redact } from "../server/security";
import { startServer, type ServerHandle } from "../server/server";
import { fakeSdk } from "./fake-sdk";

let handle: ServerHandle;
let config: LocalConfig;
const logs: string[] = [];

before(async () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentstaff-srv-")));
  const outDir = path.join(root, "out");
  fs.mkdirSync(outDir);
  fs.writeFileSync(path.join(outDir, "index.html"), "<!doctype html><title>AgentStaff</title>");
  fs.writeFileSync(path.join(root, "secret.txt"), "do not serve");
  config = { root, stateDir: path.join(root, ".agentstaff"), port: 0, open: false, extraOrigins: [], plugins: [], outDir };
  const { sdk } = fakeSdk(() => ({ steps: [{ text: "Hello from a fake session." }] }));
  handle = await startServer(config, {
    sdk,
    env: { ANTHROPIC_API_KEY: "sk-ant-api03-supersecretvalue" },
    log: (m) => logs.push(m),
  });
});
after(() => handle.close());

const origin = () => `http://127.0.0.1:${config.port}`;

function connect(opts: { token?: string; origin?: string; host?: string } = {}) {
  const protocols = [WS_PROTOCOL, ...(opts.token === "" ? [] : [`${WS_TOKEN_PREFIX}${opts.token ?? handle.token}`])];
  return new WebSocket(`ws://127.0.0.1:${config.port}/ws`, protocols, {
    origin: opts.origin ?? origin(),
    headers: opts.host ? { Host: opts.host } : {},
  });
}

function outcome(ws: WebSocket): Promise<{ status: "open"; first: ServerEvent } | { status: number }> {
  return new Promise((resolve) => {
    ws.once("message", (data) => resolve({ status: "open", first: JSON.parse(String(data)) }));
    ws.once("unexpected-response", (_req, res) => resolve({ status: res.statusCode ?? 0 }));
    ws.once("error", () => resolve({ status: -1 }));
  });
}

test("binds to 127.0.0.1 only", () => {
  assert.match(handle.url, /^http:\/\/127\.0\.0\.1:\d+\/$/);
});

test("a connection with the token from the right origin gets the ready event", async () => {
  const ws = connect();
  const r = await outcome(ws);
  assert.equal(r.status, "open");
  const first = (r as { first: ServerEvent }).first;
  assert.equal(first.type, "ready");
  assert.equal(ws.protocol, WS_PROTOCOL, "the token subprotocol is never echoed back");
  if (first.type === "ready") {
    assert.equal(first.auth.mode, "api-key");
    assert.ok(!JSON.stringify(first).includes("supersecret"), "the key never reaches the browser");
    assert.deepEqual(first.roles.map((x) => x.id), ["builder", "reviewer"]);
  }
  ws.close();
});

test("wrong or missing token, foreign Origin, or a rebinding Host are refused", async () => {
  assert.equal((await outcome(connect({ token: "0".repeat(64) }))).status, 401);
  assert.equal((await outcome(connect({ token: "" }))).status, 401);
  assert.equal((await outcome(connect({ origin: "https://evil.example" }))).status, 403);
  assert.equal((await outcome(connect({ origin: "null" }))).status, 403);
  assert.equal((await outcome(connect({ host: `evil.example:${config.port}` }))).status, 403);
  assert.ok(logs.some((l) => l.includes("Origin not allowed")));
  assert.ok(logs.every((l) => !l.includes(handle.token)), "the token never reaches the log");
});

test("invalid messages are rejected; a valid run streams back", async () => {
  const ws = connect();
  await outcome(ws);
  const events: ServerEvent[] = [];
  ws.on("message", (d) => events.push(JSON.parse(String(d))));
  ws.send(JSON.stringify({ type: "send", agentId: "../../etc", text: "hi" }));
  ws.send("{nope");
  const org = { id: "o", name: "Org", description: "", agents: [{ id: "cfo", name: "Fiona", title: "CFO", emoji: "📊", color: "#000", reportsTo: null, mission: "Numbers", tools: [] }] };
  ws.send(JSON.stringify({ type: "workspace", org, settings: { model: "claude-haiku-5-5", effort: "low", maxCostPerRequest: 0.5, allowWebSearch: false } }));
  ws.send(JSON.stringify({ type: "send", agentId: "cfo", text: "Runway?" }));
  for (let i = 0; i < 100 && !events.some((e) => e.type === "busy" && !e.busy); i++) await new Promise((r) => setTimeout(r, 10));
  assert.equal(events.filter((e) => e.type === "error").length, 2);
  assert.ok(events.some((e) => e.type === "folders" && e.folders.cfo === path.join(config.root, "cfo")));
  assert.ok(events.some((e) => e.type === "append" && e.text === "Hello from a fake session."));
  ws.close();
});

test("static files: serves the UI, refuses traversal and non-GET", async () => {
  const get = (p: string, method = "GET") =>
    new Promise<number>((resolve) => {
      const req = http.request({ host: "127.0.0.1", port: config.port, path: p, method }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      req.end();
    });
  assert.equal(await get("/"), 200);
  assert.equal(await get("/../secret.txt"), 404);
  assert.equal(await get("/%2e%2e/secret.txt"), 404);
  assert.equal(await get("/", "POST"), 405);
});

test("auth: API key or cloud provider from the environment; claude.ai OAuth token is never passed on", () => {
  assert.equal(detectAuth({ ANTHROPIC_API_KEY: "sk-ant-x" }).mode, "api-key");
  assert.equal(detectAuth({ CLAUDE_CODE_USE_BEDROCK: "1" }).mode, "cloud-provider");
  assert.equal(detectAuth({ CLAUDE_CODE_OAUTH_TOKEN: "subscription" }).mode, "missing");
  assert.equal(detectAuth({}).mode, "missing");
  const env = sdkEnv({ ANTHROPIC_API_KEY: "k", CLAUDE_CODE_OAUTH_TOKEN: "t", PATH: "/bin" }, "0.2.0");
  assert.equal(env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(env.CLAUDE_AGENT_SDK_CLIENT_APP, "agentstaff/0.2.0");
  assert.equal(redact("key sk-ant-api03-abcdefghijk end"), "key sk-ant-…[redacted] end");
});
