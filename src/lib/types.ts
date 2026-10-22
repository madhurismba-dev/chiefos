import type Anthropic from "@anthropic-ai/sdk";
import type { AuthInfo, PendingApproval, RoleInfo } from "./local/protocol";

export type AgentTool = "web_search";

/** One AI employee. */
export interface Agent {
  id: string;
  name: string;
  title: string;
  emoji: string;
  color: string;
  reportsTo: string | null; // agent id, or null = reports to the CEO (you)
  mission: string; // becomes the agent's system prompt
  tools: AgentTool[];
  /** Local mode (v2) only: role, approvals and working folder. Ignored in browser mode. */
  local?: {
    role?: string;
    alwaysAsk?: boolean;
    verifyAfterChange?: boolean;
    folder?: string;
  };
}

export interface Org {
  id: string;
  name: string;
  description: string;
  agents: Agent[];
}

/** "ceo" is the human user. Everything else is an agent id. */
export type AuthorId = "ceo" | string;

export interface ChatMessage {
  id: string;
  author: AuthorId;
  text: string;
  ts: number;
  /** "note" = activity line, e.g. "Asked Eli for an estimate" or "Searching the web". */
  kind: "text" | "note" | "error";
  /** For notes that point at another thread. */
  linkThreadId?: string;
  streaming?: boolean;
}

/**
 * A conversation. "dm" = CEO ↔ agent. "team" = agent ↔ agent (opened when one agent messages another).
 * `history` is the Claude API transcript from the responding agent's point of view; it is append-only.
 */
export interface Thread {
  id: string;
  kind: "dm" | "team";
  /** dm: [agentId]. team: [fromAgentId, toAgentId]; `to` is the one who answers. */
  members: string[];
  messages: ChatMessage[];
  history: Anthropic.Beta.BetaMessageParam[];
  busy: boolean;
  unread: number;
  updatedAt: number;
}

export type TaskStatus = "todo" | "doing" | "done" | "blocked";

export interface BoardTask {
  id: string;
  title: string;
  owner: string; // agent id
  status: TaskStatus;
  details: string;
  createdBy: AuthorId;
  updatedAt: number;
}

export type ModelId = "claude-opus-5-5" | "claude-sonnet-5-5" | "claude-haiku-5-5";
export type Effort = "low" | "medium" | "high";

export type CostMode = "economy" | "balanced" | "best" | "custom";

export interface Settings {
  mode: CostMode;
  apiKey: string;
  model: ModelId;
  effort: Effort;
  allowWebSearch: boolean;
  /** Hard stop for one CEO request, including every delegated sub-conversation (USD, estimated). */
  maxCostPerRequest: number;
}

export interface Usage {
  inputTokens: number;
  cachedTokens?: number; // portion of inputTokens served from the prompt cache
  outputTokens: number;
  webSearches: number;
  costUsd: number;
}

export type View = { kind: "thread"; threadId: string } | { kind: "org" } | { kind: "board" };

export interface WorkspaceState {
  org: Org;
  threads: Record<string, Thread>;
  tasks: BoardTask[];
  usage: Usage;
  settings: Settings;
  view: View;
  demo: boolean; // true while showing the pre-written sample workspace
  booted?: boolean; // set once the saved workspace (or the demo) has loaded in the browser
  /** Set only in local mode (v2): connection to the local server. Never persisted. */
  local?: LocalStatus;
  /** Local mode: tool uses waiting for your approve/deny. Never persisted. */
  approvals?: PendingApproval[];
}

export interface LocalStatus {
  status: "connecting" | "ready" | "disconnected";
  version?: string;
  auth?: AuthInfo;
  root?: string;
  roles: RoleInfo[];
  folders: Record<string, string>;
  folderErrors: Record<string, string>;
  error?: string;
}
