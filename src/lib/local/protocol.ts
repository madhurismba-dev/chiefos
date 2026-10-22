import { z } from "zod";
import type { ChatMessage, Thread, Usage } from "../types";

/**
 * Local mode (v2) wire protocol, shared by the browser and the local server (server/).
 *
 * The browser sends small commands; the server streams back events that mirror the workspace store's own
 * mutations (add a message, append to it, mark a thread busy...), so the existing UI renders local agents
 * exactly like browser-mode agents.
 */

export const PROTOCOL_VERSION = 1;
/** WebSocket subprotocol. The per-launch token rides in a second subprotocol: `agentstaff.token.<hex>`. */
export const WS_PROTOCOL = "agentstaff";
export const WS_TOKEN_PREFIX = "agentstaff.token.";
export const WS_PATH = "/ws";
export const DEFAULT_PORT = 4317;

// ---------- browser → server ----------

const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,47}$/, "ids are lowercase letters, digits and dashes");

export const LocalAgentSettingsSchema = z.object({
  /** Role id from the server's role registry ("builder", "reviewer", or one a plugin added). */
  role: z.string().max(40).optional(),
  /** Surface every tool use in the UI for approve/deny. */
  alwaysAsk: z.boolean().optional(),
  /** Ask the agent to check its work after each file change. Default on. */
  verifyAfterChange: z.boolean().optional(),
  /** Absolute path of the agent's working folder. Default: <root>/<agent id>. */
  folder: z.string().max(1024).optional(),
});

const AgentSchema = z.object({
  id,
  name: z.string().min(1).max(80),
  title: z.string().min(1).max(120),
  emoji: z.string().max(16),
  color: z.string().max(32),
  reportsTo: id.nullable(),
  mission: z.string().max(8000),
  tools: z.array(z.literal("web_search")).max(4),
  local: LocalAgentSettingsSchema.optional(),
});

const OrgSchema = z.object({
  id: z.string().max(80),
  name: z.string().max(120),
  description: z.string().max(1000),
  agents: z.array(AgentSchema).max(50),
});

const RunSettingsSchema = z.object({
  model: z.enum(["claude-opus-5-5", "claude-sonnet-5-5", "claude-haiku-5-5"]),
  effort: z.enum(["low", "medium", "high"]),
  maxCostPerRequest: z.number().positive().max(1000),
  allowWebSearch: z.boolean(),
});

export const ClientMessageSchema = z.discriminatedUnion("type", [
  /** First message after connecting, and again whenever the team or settings change. */
  z.object({ type: z.literal("workspace"), org: OrgSchema, settings: RunSettingsSchema }),
  z.object({ type: z.literal("send"), agentId: id, text: z.string().min(1).max(50_000) }),
  z.object({ type: z.literal("stop"), threadId: z.string().max(200) }),
  z.object({ type: z.literal("approval"), id: z.string().max(80), allow: z.boolean() }),
  /** Forget saved Claude Code sessions (all agents when agentId is omitted), e.g. for a new workspace. */
  z.object({ type: z.literal("reset_sessions"), agentId: id.optional() }),
]);

export type ClientMessage = z.infer<typeof ClientMessageSchema>;
export type RunSettings = z.infer<typeof RunSettingsSchema>;
export type LocalAgentSettings = z.infer<typeof LocalAgentSettingsSchema>;

// ---------- server → browser ----------

/** How the local server authenticates with Anthropic. Never contains the key itself. */
export interface AuthInfo {
  mode: "api-key" | "cloud-provider" | "missing";
  /** Human-readable, e.g. "ANTHROPIC_API_KEY from your environment" or "Amazon Bedrock". */
  detail: string;
}

export interface RoleInfo {
  id: string;
  label: string;
  description: string;
}

export interface PendingApproval {
  id: string;
  threadId: string;
  agentId: string;
  toolName: string;
  /** One line, e.g. "Bash: npm test". */
  summary: string;
  /** The tool input as JSON, truncated for display. */
  detail: string;
  reason: string;
}

export type ServerEvent =
  | {
      type: "ready";
      protocol: number;
      version: string;
      auth: AuthInfo;
      root: string;
      roles: RoleInfo[];
      approvals: PendingApproval[];
      /** Threads with an agent working right now (for a tab opened or reloaded mid-run). */
      busy: string[];
    }
  | { type: "folders"; folders: Record<string, string>; errors: Record<string, string> }
  | { type: "thread"; threadId: string; kind: Thread["kind"]; members: string[] }
  | ({ type: "message"; threadId: string } & Pick<ChatMessage, "id" | "author" | "text" | "kind" | "linkThreadId" | "streaming">)
  | { type: "append"; threadId: string; id: string; text: string }
  | { type: "finish"; threadId: string; id: string }
  | { type: "busy"; threadId: string; busy: boolean }
  | { type: "usage"; usage: Usage }
  | { type: "approval"; approval: PendingApproval }
  | { type: "approval_resolved"; id: string; allow: boolean }
  | { type: "error"; message: string };
