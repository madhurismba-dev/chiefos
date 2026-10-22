/**
 * Local mode permission policy: path containment (`..`, `~`, symlinks, dangling symlinks, prefix tricks),
 * per-role tools, "always ask", and custom folder rules. Uses a real temp directory; no SDK, no network.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { folderError, type LocalConfig } from "../server/config";
import { BUILTIN_ROLES, decide, globPrefix, isInside, toolsForRole, type PolicyInput } from "../server/permissions";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentstaff-perm-")));
const folder = path.join(tmp, "eli");
const outside = path.join(tmp, "outside");
fs.mkdirSync(path.join(folder, "src"), { recursive: true });
fs.mkdirSync(outside, { recursive: true });
fs.writeFileSync(path.join(folder, "src", "app.ts"), "export {}");
fs.writeFileSync(path.join(outside, "secret.txt"), "nope");
fs.mkdirSync(path.join(tmp, "eli-evil"), { recursive: true });
fs.symlinkSync(outside, path.join(folder, "escape")); // dir symlink pointing out
fs.symlinkSync(path.join(outside, "new-file.txt"), path.join(folder, "dangling")); // target doesn't exist yet
fs.symlinkSync(path.join(folder, "src"), path.join(folder, "src-link")); // symlink that stays inside
fs.symlinkSync(folder, path.join(tmp, "eli-link")); // the agent folder reached through a symlink

const base = (over: Partial<PolicyInput>): PolicyInput => ({
  toolName: "Read",
  input: {},
  folder,
  role: BUILTIN_ROLES.builder,
  alwaysAsk: false,
  webAccess: false,
  ...over,
});

test("paths inside the folder are inside, however they're written", () => {
  assert.ok(isInside(folder, path.join(folder, "src", "app.ts")));
  assert.ok(isInside(folder, "src/app.ts")); // relative to the folder
  assert.ok(isInside(folder, "./src/../src/app.ts"));
  assert.ok(isInside(folder, "notes/new-file.md")); // doesn't exist yet (Write)
  assert.ok(isInside(folder, folder)); // the folder itself (Glob/Grep path)
  assert.ok(isInside(folder, "src-link/app.ts")); // symlink that stays inside
  assert.ok(isInside(path.join(tmp, "eli-link"), path.join(folder, "src", "app.ts")), "symlinked root resolves");
});

test("`..`, absolute paths, ~ and prefix tricks can't leave the folder", () => {
  assert.ok(!isInside(folder, "../outside/secret.txt"));
  assert.ok(!isInside(folder, "src/../../outside/secret.txt"));
  assert.ok(!isInside(folder, path.join(outside, "secret.txt")));
  assert.ok(!isInside(folder, "/etc/passwd"));
  assert.ok(!isInside(folder, "~/.ssh/id_ed25519"));
  assert.ok(!isInside(folder, path.join(tmp, "eli-evil", "x.txt")), "a sibling sharing the folder's name prefix is outside");
  assert.ok(!isInside(folder, `src/app.ts\0`), "NUL bytes are rejected");
});

test("symlinks are followed: a link out of the folder is outside, even a dangling one", () => {
  assert.ok(!isInside(folder, "escape/secret.txt"));
  assert.ok(!isInside(folder, "escape"));
  assert.ok(!isInside(folder, "escape/not-yet-created.txt"));
  assert.ok(!isInside(folder, "dangling"), "writing through a dangling link would create a file outside");
});

test("builder: file tools inside run, outside are denied, shell asks", () => {
  assert.equal(decide(base({ toolName: "Read", input: { file_path: "src/app.ts" } })).behavior, "allow");
  assert.equal(decide(base({ toolName: "Write", input: { file_path: path.join(folder, "plan.md"), content: "x" } })).behavior, "allow");
  assert.equal(decide(base({ toolName: "Edit", input: { file_path: "../outside/secret.txt" } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "Write", input: { file_path: "escape/pwned.txt" } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "NotebookEdit", input: { notebook_path: "/tmp/x.ipynb" } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "Glob", input: { pattern: "**/*.ts" } })).behavior, "allow");
  assert.equal(decide(base({ toolName: "Glob", input: { pattern: "/etc/**" } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "Glob", input: { pattern: "../outside/*" } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "Grep", input: { pattern: "key", path: outside } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "Read", input: { file_path: 42 } })).behavior, "deny");
  assert.equal(decide(base({ toolName: "Bash", input: { command: "npm test" } })).behavior, "ask");
});

test("reviewer role is read-only; unknown tools are denied; web tools need web access", () => {
  const reviewer = (toolName: string, input: Record<string, unknown> = {}) =>
    decide(base({ role: BUILTIN_ROLES.reviewer, toolName, input })).behavior;
  assert.equal(reviewer("Read", { file_path: "src/app.ts" }), "allow");
  assert.equal(reviewer("Grep", { pattern: "TODO" }), "allow");
  assert.equal(reviewer("Write", { file_path: "src/app.ts" }), "deny");
  assert.equal(reviewer("Edit", { file_path: "src/app.ts" }), "deny");
  assert.equal(reviewer("Bash", { command: "ls" }), "deny");
  assert.deepEqual(toolsForRole(BUILTIN_ROLES.reviewer, false), ["Read", "Glob", "Grep"]);

  assert.equal(decide(base({ toolName: "Task" })).behavior, "deny");
  assert.equal(decide(base({ toolName: "WebSearch" })).behavior, "deny");
  assert.equal(decide(base({ toolName: "WebSearch", webAccess: true })).behavior, "allow");
  assert.equal(decide(base({ toolName: "WebFetch", webAccess: true })).behavior, "ask");
  assert.equal(decide(base({ toolName: "mcp__agentstaff__message_colleague" })).behavior, "allow");
  assert.equal(decide(base({ toolName: "mcp__other__thing" })).behavior, "deny");
});

test("always ask surfaces everything, but never lets a path leave the folder", () => {
  const ask = (toolName: string, input: Record<string, unknown>) => decide(base({ alwaysAsk: true, toolName, input })).behavior;
  assert.equal(ask("Read", { file_path: "src/app.ts" }), "ask");
  assert.equal(ask("mcp__agentstaff__write_note", { name: "x", content: "y" }), "ask");
  assert.equal(ask("Read", { file_path: "../outside/secret.txt" }), "deny");
  assert.equal(decide(base({ alwaysAsk: true, role: BUILTIN_ROLES.reviewer, toolName: "Write", input: {} })).behavior, "deny");
});

test("glob prefixes", () => {
  assert.equal(globPrefix("**/*.ts"), null);
  assert.equal(globPrefix("src/*.ts"), null);
  assert.equal(globPrefix("/etc/**/*.conf"), "/etc");
  assert.equal(globPrefix("../x/*"), "../x");
  assert.equal(globPrefix("/*"), "/");
});

test("custom folders can't be the filesystem root, your home or above it, or the state dir", () => {
  const config = { root: tmp, stateDir: path.join(tmp, ".agentstaff") } as LocalConfig;
  assert.equal(folderError(config, path.join(tmp, "projects", "site")), null);
  assert.match(folderError(config, "relative/path") ?? "", /absolute/);
  assert.match(folderError(config, "/") ?? "", /root/);
  assert.match(folderError(config, os.homedir()) ?? "", /home/);
  assert.match(folderError(config, path.dirname(os.homedir())) ?? "", /home/);
  assert.match(folderError(config, path.join(tmp, ".agentstaff", "x")) ?? "", /state/);
  assert.match(folderError(config, tmp) ?? "", /state/, "a folder containing the state dir is refused");
});
