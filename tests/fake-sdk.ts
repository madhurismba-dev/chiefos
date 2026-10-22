/**
 * A fake Claude Agent SDK for local-mode tests: no Claude Code process, no network, no cost.
 *
 * `query()` plays a scripted agent. Each step either says something or calls tools; tool calls go through
 * the real hooks and canUseTool the runtime passed in, and AgentStaff's own MCP tools run their real
 * handlers, so hand-offs, permissions and sessions are exercised end to end.
 */
import type { SdkLike } from "../server/runtime";

export type Step = { text: string } | { tools: { name: string; input: Record<string, unknown> }[] };

export interface FakeCall {
  agent: string;
  prompt: string;
  options: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  sessionId: string;
  start: number;
  end: number;
  toolResults: { name: string; result: unknown; denied?: string }[];
}

export interface FakeTool {
  name: string;
  description: string;
  inputSchema: Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  handler: (args: any, extra: unknown) => Promise<any>; // eslint-disable-line @typescript-eslint/no-explicit-any
}

export function fakeSdk(script: (call: FakeCall) => { steps: Step[]; delay?: number; failResume?: boolean }) {
  const calls: FakeCall[] = [];
  let n = 0;

  const sdk = {
    tool: (name: string, description: string, inputSchema: Record<string, unknown>, handler: FakeTool["handler"]) =>
      ({ name, description, inputSchema, handler }) as FakeTool,
    createSdkMcpServer: ({ name, tools }: { name: string; tools: FakeTool[] }) => ({ type: "sdk", name, instance: { tools } }),
    query: ({ prompt, options }: { prompt: string; options: Record<string, any> }) => // eslint-disable-line @typescript-eslint/no-explicit-any
      (async function* () {
        const agent = /You are (\w+),/.exec(options.systemPrompt?.append ?? "")?.[1] ?? "?";
        const call: FakeCall = {
          agent,
          prompt,
          options,
          sessionId: options.resume ?? `sess-${agent.toLowerCase()}-${++n}`,
          start: Date.now(),
          end: 0,
          toolResults: [],
        };
        calls.push(call);
        const { steps, delay = 5, failResume } = script(call);
        if (failResume && options.resume) throw new Error("No conversation found with session ID");
        yield { type: "system", subtype: "init", session_id: call.sessionId, apiKeySource: "ANTHROPIC_API_KEY" };
        const signal: AbortSignal = options.abortController.signal;
        let finalText = "";
        let turns = 0;

        for (const step of steps) {
          if (signal.aborted) throw new Error("aborted");
          await new Promise((r) => setTimeout(r, delay));
          turns++;
          if ("text" in step) {
            finalText = step.text;
            yield { type: "stream_event", parent_tool_use_id: null, event: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: step.text } } };
            yield { type: "assistant", parent_tool_use_id: null, message: { content: [{ type: "text", text: step.text }] } };
            continue;
          }
          yield {
            type: "assistant",
            parent_tool_use_id: null,
            message: { content: step.tools.map((t, i) => ({ type: "tool_use", id: `tu_${n}_${i}`, name: t.name, input: t.input })) },
          };
          // Tool calls from one step run concurrently, like Claude Code does for concurrency-safe tools.
          await Promise.all(step.tools.map((t) => runTool(call, t.name, t.input, signal)));
        }
        call.end = Date.now();
        yield {
          type: "result",
          subtype: options.maxTurns && turns > options.maxTurns ? "error_max_turns" : "success",
          result: finalText,
          session_id: call.sessionId,
          num_turns: turns,
          total_cost_usd: 0.001,
          usage: { input_tokens: 100, output_tokens: 20, cache_read_input_tokens: 50, cache_creation_input_tokens: 0 },
          errors: [],
        };
      })(),
  };

  async function runTool(call: FakeCall, name: string, input: Record<string, unknown>, signal: AbortSignal) {
    const { options } = call;
    const pre = await options.hooks.PreToolUse[0].hooks[0]({ hook_event_name: "PreToolUse", tool_name: name, tool_input: input }, "id", { signal });
    let decision = pre.hookSpecificOutput?.permissionDecision ?? "ask";
    if (decision === "deny") {
      call.toolResults.push({ name, result: null, denied: pre.hookSpecificOutput.permissionDecisionReason });
      return;
    }
    if (decision === "ask") {
      const r = await options.canUseTool(name, input, { signal });
      decision = r.behavior;
      if (decision === "deny") {
        call.toolResults.push({ name, result: null, denied: r.message });
        return;
      }
    }
    let result: unknown = "ok";
    if (name.startsWith("mcp__agentstaff__")) {
      const tools: FakeTool[] = options.mcpServers.agentstaff.instance.tools;
      const t = tools.find((x) => `mcp__agentstaff__${x.name}` === name);
      result = t ? await t.handler(input, {}) : { isError: true, content: [{ type: "text", text: "no such tool" }] };
    }
    const post = await options.hooks.PostToolUse[0].hooks[0]({ hook_event_name: "PostToolUse", tool_name: name, tool_input: input, tool_response: result }, "id", { signal });
    call.toolResults.push({ name, result: post.hookSpecificOutput?.additionalContext ? { result, verify: post.hookSpecificOutput.additionalContext } : result });
  }

  return { sdk: sdk as unknown as SdkLike, calls };
}

/** Text of an MCP tool result. */
export function resultText(r: unknown): string {
  const c = (r as { content?: { text: string }[] })?.content;
  return c ? c.map((b) => b.text).join("") : String(r);
}
