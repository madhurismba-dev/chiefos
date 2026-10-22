/**
 * Local mode runtime against a fake Agent SDK (no Claude Code process, no network, no cost).
 * Covers hand-off routing, the shared notes passed by reference, session persistence and resume,
 * approvals, and permissions as the runtime applies them.
 *
 * Run: npm test
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import type { ServerEvent } from "../src/lib/local/protocol";
import { TEMPLATES, cloneOrg } from "../src/lib/templates";
import type { Org } from "../src/lib/types";
import type { LocalConfig } from "../server/config";
import { planHandoff, reachableColleagues } from "../server/handoff";
import { NotesStore } from "../server/notes";
import { PluginRegistry } from "../server/plugins";
import { Runtime, type SdkLike } from "../server/runtime";
import { SessionStore } from "../server/sessions";
import { fakeSdk, resultText, type FakeCall, type Step } from "./fake-sdk";

const SETTINGS = { model: "claude-haiku-5-5" as const, effort: "low" as const, maxCostPerRequest: 1, allowWebSearch: false };

function setup(sdk: SdkLike, opts: { org?: Org; sessionsFile?: string; plugins?: PluginRegistry } = {}) {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agentstaff-rt-")));
  const config: LocalConfig = {
    root,
    stateDir: path.join(root, ".agentstaff"),
    port: 0,
    open: false,
    extraOrigins: [],
    plugins: [],
    outDir: root,
  };
  const events: ServerEvent[] = [];
  const sessions = new SessionStore(opts.sessionsFile ?? path.join(config.stateDir, "sessions.json"));
  const notes = new NotesStore(null);
  const runtime = new Runtime({
    sdk,
    config,
    sessions,
    notes,
    plugins: opts.plugins ?? new PluginRegistry(),
    auth: { mode: "api-key", detail: "test" },
    emit: (e) => events.push(e),
    env: { ANTHROPIC_API_KEY: "sk-ant-test-not-real", CLAUDE_CODE_OAUTH_TOKEN: "should-be-stripped" },
  });
  const org = opts.org ?? cloneOrg(TEMPLATES[0]);
  runtime.setWorkspace(org, SETTINGS);
  return { runtime, events, sessions, notes, config, org };
}

/** A thread's messages as the UI ends up with them (streamed text appended). */
function messages(events: ServerEvent[], threadId: string) {
  const out: Extract<ServerEvent, { type: "message" }>[] = [];
  for (const e of events) {
    if (e.type === "message" && e.threadId === threadId) out.push({ ...e });
    if (e.type === "append" && e.threadId === threadId) {
      const m = out.find((x) => x.id === e.id);
      if (m) m.text += e.text;
    }
  }
  return out;
}

test("hand-offs: parallel, nested, return format, turn caps, notes by reference, org-chart routing", async () => {
  const script = (call: FakeCall): { steps: Step[]; delay?: number } => {
    switch (call.agent) {
      case "Avery":
        return {
          steps: [
            { tools: [{ name: "mcp__agentstaff__write_note", input: { name: "trial-brief", content: "14-day trial, B2B" } }] },
            {
              tools: [
                { name: "mcp__agentstaff__message_colleague", input: { to: "pm", task: "Scope the trial.", return_format: "Scope in 3 bullets", max_turns: 5, notes: ["trial-brief"] } },
                { name: "mcp__agentstaff__message_colleague", input: { to: "cfo", task: "Model the economics.", return_format: "One table" } },
                { name: "mcp__agentstaff__message_colleague", input: { to: "nobody", task: "x", return_format: "y" } },
                { name: "mcp__agentstaff__message_colleague", input: { to: "pm", task: "x", return_format: "y", notes: ["missing-note"] } },
              ],
            },
            { text: "Recommendation: launch the trial." },
          ],
        };
      case "Priya":
        return {
          delay: 30,
          steps: [
            { tools: [{ name: "mcp__agentstaff__message_colleague", input: { to: "dev", task: "Estimate it.", return_format: "Weeks" } }] },
            { text: "Scope: 14 days, 3 seats." },
          ],
        };
      case "Eli":
        return { steps: [{ text: "About 4 weeks." }] };
      case "Fiona":
        return { delay: 60, steps: [{ text: "Net positive at 9% conversion." }] };
      default:
        throw new Error(`Unexpected agent ${call.agent}`);
    }
  };
  const { sdk, calls } = fakeSdk(script);
  const { runtime, events, notes, config } = setup(sdk);

  await runtime.sendFromCeo("chief", "Should we launch a free trial?");

  assert.deepEqual(calls.map((c) => c.agent).sort(), ["Avery", "Eli", "Fiona", "Priya"]);

  // Priya and Fiona ran at the same time.
  const priya = calls.find((c) => c.agent === "Priya")!;
  const fiona = calls.find((c) => c.agent === "Fiona")!;
  const eli = calls.find((c) => c.agent === "Eli")!;
  const avery = calls.find((c) => c.agent === "Avery")!;
  assert.ok(priya.start < fiona.end && fiona.start < priya.end, "hand-offs in one turn run in parallel");

  // Each agent works in its own folder, with the right turn cap.
  assert.equal(priya.options.cwd, path.join(config.root, "pm"));
  assert.ok(fs.existsSync(path.join(config.root, "pm")), "folders are created on first use");
  assert.equal(priya.options.maxTurns, 5, "max_turns from the hand-off");
  assert.equal(fiona.options.maxTurns, 12, "default hand-off turn cap");
  assert.equal(avery.options.maxTurns, 30, "a DM gets the larger cap");

  // The hand-off prompt says what to return and passes notes by name, not content.
  assert.match(priya.prompt, /Hand-off from your colleague Avery/);
  assert.match(priya.prompt, /Send back:\nScope in 3 bullets/);
  assert.match(priya.prompt, /read_note\): trial-brief/);
  assert.ok(!priya.prompt.includes("14-day trial, B2B"), "note content is passed by reference");
  assert.equal(notes.get("trial-brief")?.author, "chief");

  // Replies come back as tool results; bad hand-offs are refused with a reason.
  const results = avery.toolResults.filter((r) => r.name === "mcp__agentstaff__message_colleague").map((r) => resultText(r.result));
  assert.ok(results.some((r) => r.includes("Priya (Product Manager) replied:\nScope: 14 days, 3 seats.")));
  assert.ok(results.some((r) => r.includes("Fiona (CFO) replied:\nNet positive")));
  assert.ok(results.some((r) => r.includes(`can't hand off to "nobody"`)));
  assert.ok(results.some((r) => r.includes("No note named missing-note")));

  // Routing follows the org chart: below the top, agents reach only their direct reports; depth is capped.
  const toolNames = (c: FakeCall) => (c.options.mcpServers.agentstaff.instance.tools as { name: string }[]).map((t) => t.name);
  const targets = (c: FakeCall) =>
    (c.options.mcpServers.agentstaff.instance.tools as { name: string; inputSchema: { to: { options: string[] } } }[])
      .find((t) => t.name === "message_colleague")!.inputSchema.to.options;
  assert.deepEqual(targets(priya), ["dev"]);
  assert.ok(!toolNames(fiona).includes("message_colleague"), "no direct reports, no hand-offs");
  assert.ok(!toolNames(eli).includes("message_colleague"), "depth 2 can't hand off further");
  assert.ok(toolNames(eli).includes("read_note"), "everyone can read shared notes");

  // The UI got the same thread structure as browser mode.
  for (const [id, asker, answer] of [
    ["team:chief:pm", "chief", "Scope: 14 days, 3 seats."],
    ["team:pm:dev", "pm", "About 4 weeks."],
    ["team:chief:cfo", "chief", "Net positive at 9% conversion."],
  ] as const) {
    const ms = messages(events, id);
    assert.equal(ms[0].author, asker);
    assert.ok(ms.some((m) => m.text === answer), `${id} should stream the reply`);
  }
  const dm = messages(events, "dm:chief");
  assert.equal(dm[0].author, "ceo");
  assert.ok(dm.some((m) => m.kind === "note" && m.linkThreadId === "team:chief:pm"));
  assert.ok(events.some((e) => e.type === "usage" && e.usage.costUsd > 0));
  const lastBusy = new Map(events.filter((e) => e.type === "busy").map((e) => [(e as { threadId: string }).threadId, (e as { busy: boolean }).busy]));
  assert.ok([...lastBusy.values()].every((b) => !b), "nothing left working");

  // Isolation and auth: no user settings, only the role's tools, and no claude.ai OAuth token passed down.
  assert.deepEqual(avery.options.settingSources, []);
  assert.deepEqual(avery.options.tools, ["Read", "Glob", "Grep", "Write", "Edit", "NotebookEdit", "Bash"]);
  assert.equal(avery.options.env.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(avery.options.env.ANTHROPIC_API_KEY, "sk-ant-test-not-real");
  assert.match(avery.options.systemPrompt.append, /Snapshot of your folder at startup/);
});

test("routing rules as pure functions", () => {
  const org = cloneOrg(TEMPLATES[0]);
  const pm = org.agents.find((a) => a.id === "pm")!;
  assert.deepEqual(reachableColleagues(org, "pm", 1, ["chief", "pm"]), ["dev"]);
  assert.ok(reachableColleagues(org, "pm", 0, ["pm"]).includes("cfo"), "the agent you talk to reaches everyone");
  assert.deepEqual(reachableColleagues(org, "dev", 2, ["chief", "pm", "dev"]), []);
  const plan = planHandoff(org, pm, 1, ["chief", "pm"], { to: "dev", task: "t", return_format: "r", max_turns: 999 }, () => true);
  assert.ok(plan.ok && plan.maxTurns === 40, "turn caps are clamped");
  const back = planHandoff(org, pm, 1, ["chief", "pm"], { to: "chief", task: "t", return_format: "r" }, () => true);
  assert.ok(!back.ok, "can't hand back up the chain");
  const empty = planHandoff(org, pm, 1, ["chief", "pm"], { to: "dev", task: "t", return_format: " " }, () => true);
  assert.ok(!empty.ok, "a hand-off must say what to return");
});

test("sessions persist per agent and thread, and resume after a restart", async () => {
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "agentstaff-sess-")), "sessions.json");
  const first = fakeSdk(() => ({ steps: [{ text: "Hi." }] }));
  const a = setup(first.sdk, { sessionsFile: file });
  await a.runtime.sendFromCeo("cfo", "Runway?");
  const saved = first.calls[0].sessionId;
  assert.equal(first.calls[0].options.resume, undefined, "first run starts fresh");
  assert.equal(JSON.parse(fs.readFileSync(file, "utf8")).agents.cfo["dm:cfo"].sessionId, saved);
  assert.equal((fs.statSync(file).mode & 0o777).toString(8), "600", "owner-only file");

  // "Restart": a new runtime and store reading the same file.
  const second = fakeSdk(() => ({ steps: [{ text: "Still 11 months." }] }));
  const b = setup(second.sdk, { sessionsFile: file });
  await b.runtime.sendFromCeo("cfo", "And now?");
  assert.equal(second.calls[0].options.resume, saved, "resumes the saved session");

  // A session that can't be resumed is dropped and replaced with a fresh one.
  const third = fakeSdk(() => ({ steps: [{ text: "Fresh start." }], failResume: true }));
  const c = setup(third.sdk, { sessionsFile: file });
  await c.runtime.sendFromCeo("cfo", "Hello again");
  assert.equal(third.calls.length, 2);
  assert.equal(third.calls[0].options.resume, saved);
  assert.equal(third.calls[1].options.resume, undefined);
  assert.equal(c.sessions.get("cfo", "dm:cfo"), third.calls[1].sessionId);
  assert.ok(messages(c.events, "dm:cfo").some((m) => /starting a fresh one/.test(m.text)));

  c.runtime.resetSessions("cfo");
  assert.equal(new SessionStore(file).get("cfo", "dm:cfo"), undefined);

  // A corrupt file doesn't crash startup; it's moved aside.
  fs.writeFileSync(file, "{not json");
  assert.deepEqual(new SessionStore(file).snapshot(), {});
  assert.ok(fs.existsSync(`${file}.bad`));
});

test("permissions in the runtime: blocked paths, read-only role, always-ask approvals, verify-after-change", async () => {
  const org = cloneOrg(TEMPLATES[0]);
  org.agents.find((a) => a.id === "research")!.local = { role: "reviewer" };
  org.agents.find((a) => a.id === "cfo")!.local = { alwaysAsk: true };
  const { sdk, calls } = fakeSdk((call) => {
    if (call.agent === "Eli") {
      return {
        steps: [
          { tools: [{ name: "Write", input: { file_path: "plan.md", content: "x" } }] },
          { tools: [{ name: "Write", input: { file_path: "../research/hijack.md", content: "x" } }] },
          { text: "Done." },
        ],
      };
    }
    if (call.agent === "Fiona") return { steps: [{ tools: [{ name: "Read", input: { file_path: "model.csv" } }] }, { text: "Read it." }] };
    return { steps: [{ tools: [{ name: "Write", input: { file_path: "notes.md", content: "x" } }] }, { text: "Can't write." }] };
  });
  const { runtime, events } = setup(sdk, { org });

  await runtime.sendFromCeo("dev", "Write a plan.");
  const eli = calls.find((c) => c.agent === "Eli")!;
  assert.equal(eli.toolResults[0].denied, undefined);
  assert.match(JSON.stringify(eli.toolResults[0].result), /verify it/, "a change gets a verify-after-change prompt");
  assert.match(eli.toolResults[1].denied ?? "", /outside your folder/);
  assert.ok(messages(events, "dm:dev").some((m) => m.kind === "note" && m.text.startsWith("Blocked Write")));

  await runtime.sendFromCeo("research", "Take notes.");
  const reviewer = calls.find((c) => c.agent !== "Eli" && c.agent !== "Fiona")!;
  assert.match(reviewer.toolResults[0].denied ?? "", /isn't available to the Reviewer/);
  assert.deepEqual(reviewer.options.tools, ["Read", "Glob", "Grep"], "web tools only when web search is allowed in Settings");

  // Always ask: the Read waits for an approval from the UI.
  const done = runtime.sendFromCeo("cfo", "Read the model.");
  let approval: Extract<ServerEvent, { type: "approval" }> | undefined;
  for (let i = 0; i < 100 && !approval; i++) {
    await new Promise((r) => setTimeout(r, 5));
    approval = events.find((e): e is Extract<ServerEvent, { type: "approval" }> => e.type === "approval");
  }
  assert.ok(approval, "an approval request reached the UI");
  assert.equal(approval.approval.summary, "Read model.csv");
  assert.deepEqual(runtime.pendingApprovals().map((a) => a.id), [approval.approval.id]);
  runtime.answerApproval(approval.approval.id, true);
  await done;
  const fiona = calls.find((c) => c.agent === "Fiona")!;
  assert.equal(fiona.toolResults[0].denied, undefined);
  assert.ok(events.some((e) => e.type === "approval_resolved" && e.allow));
  assert.deepEqual(runtime.pendingApprovals(), []);
});

test("plugins can add roles and tighten checks, but can't loosen them", async () => {
  const plugins = new PluginRegistry();
  plugins.register({
    name: "test",
    roles: { writer: { label: "Writer", description: "Docs only", tools: { Read: "auto", Write: "auto" } } },
    checkTool: (req) => (req.toolName === "Read" ? { behavior: "allow", reason: "plugin tries to loosen" } : { behavior: "deny", reason: "plugin says no" }),
  });
  assert.ok(plugins.roleInfo().some((r) => r.id === "writer"));
  assert.equal(plugins.role("does-not-exist").id, "reviewer", "unknown roles fall back to read-only");
  const deny = plugins.checkTool({ toolName: "Write", decision: { behavior: "allow", reason: "" } } as never);
  assert.equal(deny.behavior, "deny");
  const stillDenied = plugins.checkTool({ toolName: "Read", decision: { behavior: "deny", reason: "outside" } } as never);
  assert.equal(stillDenied.behavior, "deny");
});
