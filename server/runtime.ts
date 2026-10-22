import fs from "node:fs";
import path from "node:path";
import type {
  CanUseTool,
  HookCallback,
  Options,
  SDKMessage,
  createSdkMcpServer as sdkCreateSdkMcpServer,
  query as sdkQuery,
  tool as sdkTool,
} from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AuthInfo, PendingApproval, RunSettings, ServerEvent } from "../src/lib/local/protocol";
import type { Agent, ChatMessage, Org, Thread, Usage } from "../src/lib/types";
import { agentFolder, sdkEnv, type Env, type LocalConfig } from "./config";
import { MAX_HANDOFF_TURNS, handoffPrompt, planHandoff, reachableColleagues, roster } from "./handoff";
import type { NotesStore } from "./notes";
import { CHANGE_TOOLS, OWN_TOOL_PREFIX, decide, toolsForRole, type Decision } from "./permissions";
import type { PluginRegistry, TurnInfo } from "./plugins";
import { redact } from "./security";
import type { SessionStore } from "./sessions";
import { folderSnapshot } from "./snapshot";

/**
 * Local mode runtime. Each agent runs as a real Claude Code session through the Claude Agent SDK, in its
 * own folder. Like the browser engine, every thread (your DM with an agent, or a hand-off thread between
 * two agents) is its own conversation; here each one is a resumable SDK session.
 *
 * Hand-offs and shared notes are in-process MCP tools. Every tool call passes the permission policy in
 * permissions.ts, from a PreToolUse hook and again from canUseTool, and anything that needs a human waits
 * for an approve/deny from the UI.
 */

export const VERSION = "0.2.0";
const DM_MAX_TURNS = 30;
const SERVER_NAME = "agentstaff";

/** The three SDK functions the runtime uses. Injected so tests can run without the SDK or the network. */
export interface SdkLike {
  query: typeof sdkQuery;
  createSdkMcpServer: typeof sdkCreateSdkMcpServer;
  tool: typeof sdkTool;
}

export interface RuntimeDeps {
  sdk: SdkLike;
  config: LocalConfig;
  sessions: SessionStore;
  notes: NotesStore;
  plugins: PluginRegistry;
  auth: AuthInfo;
  emit: (event: ServerEvent) => void;
  env?: Env;
  log?: (message: string) => void;
}

/** Shared by everything one CEO request sets in motion: cancellation and budget. */
interface RunContext {
  signal: AbortSignal;
  abort: () => void;
  budgetUsd: number;
  spentUsd: number;
  budgetHit: boolean;
}

const dmId = (agentId: string) => `dm:${agentId}`;
const teamId = (from: string, to: string) => `team:${from}:${to}`;

export class Runtime {
  private org: Org | null = null;
  private settings: RunSettings = {
    model: "claude-sonnet-5-5",
    effort: "medium",
    maxCostPerRequest: 0.75,
    allowWebSearch: false,
  };
  private folders: Record<string, string> = {};
  private folderErrors: Record<string, string> = {};
  private snapshots = new Map<string, string>();
  private threads = new Map<string, { kind: Thread["kind"]; members: string[] }>();
  private locks = new Map<string, Promise<unknown>>();
  private controllers = new Map<string, AbortController>();
  private approvals = new Map<string, { info: PendingApproval; resolve: (allow: boolean) => void }>();
  private busy = new Set<string>();
  private counter = 0;

  constructor(private readonly deps: RuntimeDeps) {}

  // ---------- workspace ----------

  setWorkspace(org: Org, settings: RunSettings) {
    this.org = org;
    this.settings = settings;
    this.folders = {};
    this.folderErrors = {};
    for (const a of org.agents) {
      const r = agentFolder(this.deps.config, a);
      if ("folder" in r) this.folders[a.id] = r.folder;
      else this.folderErrors[a.id] = r.error;
    }
    this.emit({ type: "folders", folders: this.folders, errors: this.folderErrors });
  }

  getOrg() {
    return this.org;
  }

  busyThreads(): string[] {
    return [...this.busy];
  }

  pendingApprovals(): PendingApproval[] {
    return [...this.approvals.values()].map((a) => a.info);
  }

  // ---------- commands from the UI ----------

  /** You send a message in a DM. Resolves when the agent (and anyone it handed off to) is done. */
  async sendFromCeo(agentId: string, text: string) {
    const agent = this.org?.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    const threadId = dmId(agentId);
    this.ensureThread(threadId, "dm", [agentId]);
    this.addMessage(threadId, "ceo", text);
    if (this.deps.auth.mode === "missing") {
      this.addMessage(threadId, agentId, `Local mode has no Anthropic credentials. ${this.deps.auth.detail}`, { kind: "error" });
      return;
    }

    const controller = new AbortController();
    this.controllers.set(threadId, controller);
    const ctx: RunContext = {
      signal: controller.signal,
      abort: () => controller.abort(),
      budgetUsd: this.settings.maxCostPerRequest,
      spentUsd: 0,
      budgetHit: false,
    };
    try {
      await this.withLock(threadId, () =>
        this.runTurn(threadId, agentId, `Message from the CEO:\n${text}`, 0, [agentId], ctx, DM_MAX_TURNS),
      );
    } finally {
      this.controllers.delete(threadId);
    }
  }

  stop(threadId: string) {
    this.controllers.get(threadId)?.abort();
  }

  answerApproval(id: string, allow: boolean) {
    const pending = this.approvals.get(id);
    if (!pending) return;
    this.approvals.delete(id);
    pending.resolve(allow);
    this.emit({ type: "approval_resolved", id, allow });
    const { threadId, agentId, summary } = pending.info;
    this.addMessage(threadId, agentId, `${allow ? "You approved" : "You declined"}: ${summary}`, { kind: "note" });
  }

  resetSessions(agentId?: string) {
    if (agentId) this.deps.sessions.forget(agentId);
    else this.deps.sessions.forgetAll();
  }

  // ---------- one turn of one agent in one thread ----------

  private async runTurn(
    threadId: string,
    agentId: string,
    prompt: string,
    depth: number,
    chain: string[],
    ctx: RunContext,
    maxTurns: number,
    retried = false,
  ): Promise<string> {
    const org = this.org!;
    const agent = org.agents.find((a) => a.id === agentId);
    if (!agent) throw new Error(`Unknown agent ${agentId}`);
    const folder = this.folders[agentId];
    if (!folder) {
      this.addMessage(threadId, agentId, `I can't start: ${this.folderErrors[agentId] ?? "no working folder"}`, { kind: "error" });
      return "(error: no working folder)";
    }
    fs.mkdirSync(folder, { recursive: true });
    if (!this.snapshots.has(agentId)) this.snapshots.set(agentId, folderSnapshot(folder));

    const { id: roleId, role } = this.deps.plugins.role(agent.local?.role);
    const webAccess = this.settings.allowWebSearch && agent.tools.includes("web_search");
    const turn: TurnInfo = { agent, threadId, depth, folder, model: this.settings.model, effort: this.settings.effort };
    const overrides = await this.deps.plugins.beforeTurn(turn);
    const resume = retried ? undefined : this.deps.sessions.get(agentId, threadId);

    // One AbortController per query, tied to the whole request.
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    ctx.signal.addEventListener("abort", onAbort, { once: true });
    if (ctx.signal.aborted) abort.abort();

    const policy = (toolName: string, input: Record<string, unknown>): Decision =>
      this.deps.plugins.checkTool({
        agent,
        threadId,
        folder,
        toolName,
        input,
        decision: decide({ toolName, input, folder, role, alwaysAsk: !!agent.local?.alwaysAsk, webAccess }),
      });

    // Runs first for every tool, before Claude Code's own allow rules, so nothing gets past the policy.
    const preToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PreToolUse") return {};
      const toolInput = (input.tool_input ?? {}) as Record<string, unknown>;
      const d = policy(input.tool_name, toolInput);
      if (d.behavior === "deny") {
        this.addMessage(threadId, agentId, `Blocked ${summarize(input.tool_name, toolInput, folder)}: ${d.reason}`, { kind: "note" });
      }
      return { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: d.behavior, permissionDecisionReason: d.reason } };
    };

    // "Verify after change": after each file edit, remind the agent to check its work before reporting done.
    const postToolUse: HookCallback = async (input) => {
      if (input.hook_event_name !== "PostToolUse" || agent.local?.verifyAfterChange === false) return {};
      if (!CHANGE_TOOLS.has(input.tool_name)) return {};
      const file = summarize(input.tool_name, (input.tool_input ?? {}) as Record<string, unknown>, folder);
      return { hookSpecificOutput: { hookEventName: "PostToolUse", additionalContext: verifyPrompt(file) } };
    };

    // Reached for anything the hook sent to "ask". Re-checks the policy, then waits for you.
    const canUseTool: CanUseTool = async (toolName, input, { signal }) => {
      const d = policy(toolName, input);
      if (d.behavior === "deny") return { behavior: "deny", message: d.reason };
      if (d.behavior === "allow") return { behavior: "allow", updatedInput: input };
      const ok = await this.requestApproval(threadId, agentId, toolName, input, folder, d.reason, signal);
      return ok ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "The CEO declined this tool use." };
    };

    const mcp = this.deps.sdk.createSdkMcpServer({
      name: SERVER_NAME,
      version: VERSION,
      tools: [...this.ownTools(agent, threadId, depth, chain, ctx), ...this.deps.plugins.tools(turn, this.deps.sdk)],
    });

    const options: Options = {
      cwd: folder,
      model: overrides.model ?? this.settings.model,
      effort: overrides.effort ?? this.settings.effort,
      maxTurns: overrides.maxTurns ?? maxTurns,
      maxBudgetUsd: Math.max(0.01, ctx.budgetUsd - ctx.spentUsd),
      ...(resume ? { resume } : {}),
      systemPrompt: {
        type: "preset",
        preset: "claude_code",
        append: systemAppend(agent, org, roleId, role.label, role.description, folder, this.snapshots.get(agentId)!, overrides.appendSystemPrompt),
      },
      // Only the role's built-in tools exist for this agent; MCP tools come from our own server.
      tools: toolsForRole(role, webAccess),
      mcpServers: { [SERVER_NAME]: mcp },
      strictMcpConfig: true,
      // Isolation: ignore ~/.claude and project settings, so no allow rule or login there changes the rules above.
      settingSources: [],
      permissionMode: "default",
      hooks: {
        PreToolUse: [{ hooks: [preToolUse] }],
        PostToolUse: [{ hooks: [postToolUse] }],
      },
      canUseTool,
      includePartialMessages: true,
      abortController: abort,
      env: sdkEnv(this.deps.env ?? process.env, VERSION),
    };

    this.setBusy(threadId, true);
    let bubble: string | null = null; // the reply currently streaming in this thread
    let finalText = "";
    let started = false;
    try {
      for await (const m of this.deps.sdk.query({ prompt, options }) as AsyncIterable<SDKMessage>) {
        if (m.type === "system" && m.subtype === "init") {
          started = true;
          // API-key auth only: if Claude Code fell back to a claude.ai login, stop right here.
          if (this.deps.auth.mode === "api-key" && m.apiKeySource === "none") {
            this.addMessage(threadId, agentId, "The agent session didn't pick up ANTHROPIC_API_KEY, so I stopped. Local mode only uses API-key auth.", { kind: "error" });
            abort.abort();
            break;
          }
          this.deps.sessions.set(agentId, threadId, m.session_id);
        } else if (m.type === "stream_event") {
          if (m.parent_tool_use_id) continue; // a subagent's stream; we show the agent's own words only
          const ev = m.event;
          if (ev.type === "content_block_delta" && ev.delta.type === "text_delta") {
            bubble ??= this.addMessage(threadId, agentId, "", { streaming: true });
            this.append(threadId, bubble, ev.delta.text);
          }
        } else if (m.type === "assistant") {
          if (m.parent_tool_use_id) continue;
          const blocks = m.message.content;
          const text = blocks.filter((b) => b.type === "text").map((b) => (b as { text: string }).text).join("");
          if (bubble) {
            this.finish(threadId, bubble);
            bubble = null;
          } else if (text.trim()) {
            this.addMessage(threadId, agentId, text); // no partial messages arrived for this block
          }
          if (text.trim()) finalText = text;
          for (const b of blocks) {
            if (b.type === "tool_use" && !b.name.startsWith(`${OWN_TOOL_PREFIX}message_colleague`)) {
              this.addMessage(threadId, agentId, `Using ${summarize(b.name, b.input as Record<string, unknown>, folder)}`, { kind: "note" });
            }
          }
          if (m.error) this.addMessage(threadId, agentId, describeAssistantError(m.error), { kind: "error" });
        } else if (m.type === "result") {
          this.deps.sessions.set(agentId, threadId, m.session_id);
          ctx.spentUsd += this.recordUsage(m);
          if (m.subtype === "success") {
            if (m.result.trim()) finalText = m.result;
          } else if (m.subtype === "error_max_turns") {
            this.addMessage(threadId, agentId, `Stopped after ${m.num_turns} turns (the limit for this ${depth ? "hand-off" : "message"}).`, { kind: "note" });
            finalText = `(stopped at the ${maxTurns}-turn limit before finishing) ${finalText}`.trim();
          } else if (m.subtype === "error_max_budget_usd") {
            this.stopForBudget(ctx);
          } else {
            const why = redact(m.errors.join("; ") || m.subtype);
            if (resume && !retried && /no conversation found|session/i.test(why)) throw new ResumeFailed(why);
            this.addMessage(threadId, agentId, `The agent session reported an error: ${why}`, { kind: "error" });
          }
          if (ctx.spentUsd >= ctx.budgetUsd) this.stopForBudget(ctx);
        }
      }
      if (ctx.signal.aborted) throw new DOMException("Stopped", "AbortError");
      return finalText || "(no reply)";
    } catch (err) {
      if (bubble) this.finish(threadId, bubble);
      bubble = null;
      if (ctx.signal.aborted) {
        const why = ctx.budgetHit
          ? `Stopped: this request reached its $${ctx.budgetUsd.toFixed(2)} budget (change it in Settings).`
          : "Stopped.";
        this.addMessage(threadId, agentId, why, { kind: "note" });
        throw err;
      }
      // A saved session that can't be resumed (deleted transcript, new machine): start fresh once.
      if (resume && !retried && (err instanceof ResumeFailed || !started)) {
        this.deps.sessions.forget(agentId, threadId);
        this.addMessage(threadId, agentId, "Couldn't resume my previous session, so I'm starting a fresh one.", { kind: "note" });
        this.setBusy(threadId, false);
        return this.runTurn(threadId, agentId, prompt, depth, chain, ctx, maxTurns, true);
      }
      const message = redact(err instanceof Error ? err.message : String(err));
      this.addMessage(threadId, agentId, message, { kind: "error" });
      return `(error: ${message})`;
    } finally {
      ctx.signal.removeEventListener("abort", onAbort);
      if (bubble) this.finish(threadId, bubble);
      this.setBusy(threadId, false);
    }
  }

  /** message_colleague and the shared notes, as in-process MCP tools. */
  private ownTools(agent: Agent, threadId: string, depth: number, chain: string[], ctx: RunContext) {
    const { tool } = this.deps.sdk;
    const org = this.org!;
    const text = (t: string, isError = false) => ({ content: [{ type: "text" as const, text: t }], ...(isError ? { isError } : {}) });
    const tools = [];

    const reachable = reachableColleagues(org, agent.id, depth, chain);
    if (reachable.length > 0) {
      tools.push(
        tool(
          "message_colleague",
          "Hand work off to a colleague and wait for their reply. They work in their own folder and session " +
            "and can't see your chats, so write a complete, self-contained task. Say exactly what to send " +
            "back. Call it several times in one turn to work with several colleagues in parallel.",
          {
            to: z.enum(reachable as [string, ...string[]]).describe("Colleague's id"),
            task: z.string().describe("The full request"),
            return_format: z.string().describe('What to send back, e.g. "a 5-line summary and the path of the file you wrote"'),
            max_turns: z.number().int().min(1).max(MAX_HANDOFF_TURNS).optional().describe("Turn limit for the colleague (default 12)"),
            notes: z.array(z.string()).optional().describe("Names of shared notes the colleague should read"),
          },
          async (args) => {
            const plan = planHandoff(org, agent, depth, chain, args, (n) => this.deps.notes.has(n));
            if (!plan.ok) return text(plan.error, true);
            const colleague = plan.colleague;
            const tId = teamId(agent.id, colleague.id);
            this.ensureThread(tId, "team", [agent.id, colleague.id]);
            this.addMessage(threadId, agent.id, `Handed off to ${colleague.name} (${colleague.title}): ${args.task}`, {
              kind: "note",
              linkThreadId: tId,
            });
            const prompt = handoffPrompt(agent, args, plan);
            const reply = await this.withLock(tId, async () => {
              this.addMessage(tId, agent.id, prompt);
              return this.runTurn(tId, colleague.id, prompt, depth + 1, [...chain, colleague.id], ctx, plan.maxTurns);
            });
            this.addMessage(threadId, agent.id, `${colleague.name} replied`, { kind: "note", linkThreadId: tId });
            return text(`${colleague.name} (${colleague.title}) replied:\n${reply}`);
          },
          // Lets Claude Code run several hand-offs at once. The tool doesn't touch this agent's folder; the
          // colleague's own tool calls go through the colleague's own permissions.
          { annotations: { readOnlyHint: true } },
        ),
      );
    }

    tools.push(
      tool("list_notes", "List the shared notes every agent can read.", {}, async () => {
        const notes = this.deps.notes.list();
        return text(notes.length ? notes.map((n) => `${n.name} (by ${n.author}, ${n.chars} chars)`).join("\n") : "No notes yet.");
      }, { annotations: { readOnlyHint: true } }),
      tool("read_note", "Read a shared note by name.", { name: z.string() }, async ({ name }) => {
        const note = this.deps.notes.get(name);
        return note ? text(note.content) : text(`No note named ${name}. Use list_notes.`, true);
      }, { annotations: { readOnlyHint: true } }),
      tool(
        "write_note",
        "Create or replace a shared note (specs, findings, file lists) so colleagues can read it by name.",
        { name: z.string().describe("Letters, digits, dot, dash, underscore"), content: z.string() },
        async ({ name, content }) => {
          const error = this.deps.notes.write(name, content, agent.id);
          if (error) return text(error, true);
          this.addMessage(threadId, agent.id, `Wrote note ${name}`, { kind: "note" });
          return text(`Saved note ${name}.`);
        },
      ),
    );
    return tools;
  }

  private requestApproval(
    threadId: string,
    agentId: string,
    toolName: string,
    input: Record<string, unknown>,
    folder: string,
    reason: string,
    signal: AbortSignal,
  ): Promise<boolean> {
    const id = this.uid("ap");
    const info: PendingApproval = {
      id,
      threadId,
      agentId,
      toolName,
      summary: summarize(toolName, input, folder),
      detail: redact(JSON.stringify(input, null, 2)).slice(0, 4000),
      reason,
    };
    return new Promise<boolean>((resolve) => {
      const done = (allow: boolean) => {
        signal.removeEventListener("abort", onAbort);
        resolve(allow);
      };
      const onAbort = () => {
        if (this.approvals.delete(id)) this.emit({ type: "approval_resolved", id, allow: false });
        done(false);
      };
      this.approvals.set(id, { info, resolve: done });
      signal.addEventListener("abort", onAbort, { once: true });
      this.emit({ type: "approval", approval: info });
    });
  }

  // ---------- helpers ----------

  /** Serialize turns within one thread (different threads run in parallel). */
  private withLock<T>(threadId: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.locks.get(threadId) ?? Promise.resolve();
    const next = prev.catch(() => undefined).then(fn);
    this.locks.set(threadId, next);
    return next;
  }

  private stopForBudget(ctx: RunContext): never {
    ctx.budgetHit = true;
    ctx.abort(); // cancels every in-flight sub-conversation of this request
    throw new DOMException("Budget reached", "AbortError");
  }

  private recordUsage(m: Extract<SDKMessage, { type: "result" }>): number {
    const u = m.usage;
    const read = u.cache_read_input_tokens ?? 0;
    const usage: Usage = {
      inputTokens: (u.input_tokens ?? 0) + (u.cache_creation_input_tokens ?? 0) + read,
      cachedTokens: read,
      outputTokens: u.output_tokens ?? 0,
      webSearches: u.server_tool_use?.web_search_requests ?? 0,
      costUsd: m.total_cost_usd ?? 0,
    };
    this.emit({ type: "usage", usage });
    return usage.costUsd;
  }

  private uid(prefix: string) {
    return `${prefix}_${Date.now().toString(36)}_${(this.counter++).toString(36)}`;
  }

  private emit(event: ServerEvent) {
    this.deps.emit(event);
    this.deps.plugins.emit(event);
  }

  private ensureThread(threadId: string, kind: Thread["kind"], members: string[]) {
    if (this.threads.has(threadId)) return;
    this.threads.set(threadId, { kind, members });
    this.emit({ type: "thread", threadId, kind, members });
  }

  private addMessage(threadId: string, author: string, text: string, extra: Partial<Pick<ChatMessage, "kind" | "linkThreadId" | "streaming">> = {}) {
    const id = this.uid("m");
    this.emit({ type: "message", threadId, id, author, text, kind: extra.kind ?? "text", linkThreadId: extra.linkThreadId, streaming: extra.streaming });
    return id;
  }

  private append(threadId: string, id: string, text: string) {
    this.emit({ type: "append", threadId, id, text });
  }

  private finish(threadId: string, id: string) {
    this.emit({ type: "finish", threadId, id });
  }

  private setBusy(threadId: string, busy: boolean) {
    if (busy) this.busy.add(threadId);
    else this.busy.delete(threadId);
    this.emit({ type: "busy", threadId, busy });
  }
}

class ResumeFailed extends Error {}

function systemAppend(
  agent: Agent,
  org: Org,
  roleId: string,
  roleLabel: string,
  roleDescription: string,
  folder: string,
  snapshot: string,
  extra?: string,
) {
  return [
    `You are ${agent.name}, ${agent.title} at a company whose CEO is the human you work for. Your colleagues ` +
      `are AI agents too, each with their own folder and session.`,
    `Your role: ${agent.mission}`,
    `The team:\n${roster(org)}`,
    `Your working folder is ${folder}. File tools only work inside it; paths outside it are blocked. ` +
      `Permissions: ${roleLabel} (${roleId}). ${roleDescription}`,
    `Snapshot of your folder at startup:\n${snapshot}`,
    `How you work:\n` +
      `- Answer directly when you can. Hand off with message_colleague only when a colleague's expertise clearly ` +
      `improves the result. Say exactly what to send back, keep max_turns small, and send independent hand-offs ` +
      `in the same turn so they run in parallel.\n` +
      `- Put long material (specs, findings, file lists) in a shared note with write_note and pass its name in ` +
      `notes instead of pasting it.\n` +
      `- When a colleague hands you work, do it yourself and reply with exactly what they asked for.\n` +
      `- After you change files, check your work before you say it's done.\n` +
      `- Write in concise markdown. When colleagues contributed, say who found what.`,
    ...(extra ? [extra] : []),
  ].join("\n\n");
}

export function verifyPrompt(what: string) {
  return (
    `You just changed ${what}. Before you report this work as done, verify it: re-read the part you changed, ` +
    `and if this folder has tests or a build you're allowed to run, run them. Say briefly what you checked.`
  );
}

/** One line for notes and approval cards, e.g. "Read notes/plan.md" or "Bash: npm test". */
export function summarize(toolName: string, input: Record<string, unknown>, folder: string): string {
  const name = toolName.startsWith(OWN_TOOL_PREFIX) ? toolName.slice(OWN_TOOL_PREFIX.length) : toolName;
  const rel = (p: unknown) => {
    if (typeof p !== "string") return "";
    const r = path.relative(folder, path.resolve(folder, p));
    return r && !r.startsWith("..") ? r : p;
  };
  const one = (s: unknown, n = 160) => (typeof s === "string" ? s.replace(/\s+/g, " ").slice(0, n) : "");
  switch (toolName) {
    case "Read":
    case "Write":
    case "Edit":
    case "MultiEdit":
      return `${name} ${rel(input.file_path)}`;
    case "NotebookEdit":
      return `${name} ${rel(input.notebook_path)}`;
    case "Glob":
    case "Grep":
      return `${name} ${one(input.pattern)}${input.path ? ` in ${rel(input.path)}` : ""}`;
    case "Bash":
      return `Bash: ${one(input.command)}`;
    case "WebFetch":
      return `WebFetch ${one(input.url)}`;
    case "WebSearch":
      return `WebSearch: ${one(input.query)}`;
    default:
      return typeof input.name === "string" ? `${name} ${input.name}` : name;
  }
}

function describeAssistantError(code: string) {
  switch (code) {
    case "authentication_failed":
      return "Anthropic rejected the credentials. Check ANTHROPIC_API_KEY and restart AgentStaff.";
    case "billing_error":
      return "Anthropic reported a billing problem with this API key.";
    case "rate_limit":
      return "Rate limited by the API. Wait a minute and try again.";
    case "model_not_found":
      return "This API key doesn't have access to that model.";
    default:
      return `The API returned an error (${code}).`;
  }
}
