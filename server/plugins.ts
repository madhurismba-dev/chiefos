import path from "node:path";
import { pathToFileURL } from "node:url";
import type { SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk";
import type { RoleInfo, ServerEvent } from "../src/lib/local/protocol";
import type { Agent, Effort, Org } from "../src/lib/types";
import { BUILTIN_ROLES, DEFAULT_ROLE, type Decision, type RoleDefinition } from "./permissions";
import type { SdkLike } from "./runtime";

/**
 * Extension points for the local server. A plugin is a plain module whose default export is an
 * AgentStaffPlugin (or an array of them), loaded with `--plugin ./path/to/plugin.ts`. Plugins add to the core
 * without editing it: new roles, extra tools, per-turn overrides, stricter permission checks, event
 * listeners, and code that runs at startup with access to the runtime.
 *
 * Plugins are trusted code running in the server process. They can tighten permissions but never loosen
 * them: a plugin's checkTool can deny or ask, and its "allow" is ignored.
 */

/** What a plugin learns about a turn that's about to start. */
export interface TurnInfo {
  agent: Agent;
  threadId: string;
  depth: number;
  folder: string;
  model: string;
  effort: Effort;
}

/** What a plugin may change for one turn. */
export interface TurnOverrides {
  model?: string;
  effort?: Effort;
  maxTurns?: number;
  /** Appended to the agent's system prompt. */
  appendSystemPrompt?: string;
}

export interface ToolRequest {
  agent: Agent;
  threadId: string;
  folder: string;
  toolName: string;
  input: Record<string, unknown>;
  /** The core policy's decision; a plugin can only make it stricter. */
  decision: Decision;
}

/** What setup() gets: enough to drive agents from outside the UI. */
export interface PluginApi {
  sendFromCeo(agentId: string, text: string): Promise<void>;
  stop(threadId: string): void;
  org(): Org | null;
  log(message: string): void;
}

export interface AgentStaffPlugin {
  name: string;
  roles?: Record<string, RoleDefinition>;
  tools?: (turn: TurnInfo, sdk: SdkLike) => SdkMcpToolDefinition[];
  beforeTurn?: (turn: TurnInfo) => TurnOverrides | void | Promise<TurnOverrides | void>;
  checkTool?: (req: ToolRequest) => Decision | void;
  onEvent?: (event: ServerEvent) => void;
  setup?: (api: PluginApi) => void | Promise<void>;
}

export class PluginRegistry {
  private plugins: AgentStaffPlugin[] = [];

  register(plugin: AgentStaffPlugin) {
    if (!plugin?.name) throw new Error("A plugin needs a name.");
    this.plugins.push(plugin);
  }

  list() {
    return this.plugins.map((p) => p.name);
  }

  roles(): Record<string, RoleDefinition> {
    return Object.assign({}, BUILTIN_ROLES, ...this.plugins.map((p) => p.roles ?? {}));
  }

  roleInfo(): RoleInfo[] {
    return Object.entries(this.roles()).map(([id, r]) => ({ id, label: r.label, description: r.description }));
  }

  /** Unknown role ids fall back to the read-only reviewer, never to something more permissive. */
  role(id: string | undefined): { id: string; role: RoleDefinition } {
    const roles = this.roles();
    const key = id ?? DEFAULT_ROLE;
    return roles[key] ? { id: key, role: roles[key] } : { id: "reviewer", role: BUILTIN_ROLES.reviewer };
  }

  tools(turn: TurnInfo, sdk: SdkLike): SdkMcpToolDefinition[] {
    return this.plugins.flatMap((p) => p.tools?.(turn, sdk) ?? []);
  }

  async beforeTurn(turn: TurnInfo): Promise<TurnOverrides> {
    let out: TurnOverrides = {};
    for (const p of this.plugins) out = { ...out, ...((await p.beforeTurn?.(turn)) ?? {}) };
    return out;
  }

  /** Apply plugin checks in order. Only deny (always wins) and ask (over allow) are honored. */
  checkTool(req: ToolRequest): Decision {
    let decision = req.decision;
    for (const p of this.plugins) {
      if (decision.behavior === "deny") break;
      const d = p.checkTool?.({ ...req, decision });
      if (d?.behavior === "deny" || (d?.behavior === "ask" && decision.behavior === "allow")) decision = d;
    }
    return decision;
  }

  emit(event: ServerEvent) {
    for (const p of this.plugins) {
      try {
        p.onEvent?.(event);
      } catch {
        /* a listener's bug shouldn't stop the stream */
      }
    }
  }

  async setup(api: PluginApi) {
    for (const p of this.plugins) await p.setup?.(api);
  }
}

export async function loadPlugins(registry: PluginRegistry, paths: string[]) {
  for (const p of paths) {
    const mod = await import(pathToFileURL(path.resolve(p)).href);
    const exported = mod.default ?? mod.plugin;
    for (const plugin of Array.isArray(exported) ? exported : [exported]) registry.register(plugin);
  }
}
