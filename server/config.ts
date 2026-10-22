import os from "node:os";
import path from "node:path";
import { DEFAULT_PORT, type AuthInfo } from "../src/lib/local/protocol";
import type { Agent } from "../src/lib/types";
import { isWithin, resolveReal } from "./permissions";

/** Environment variables (a plain record, so tests don't need Next's NODE_ENV typing). */
export type Env = Record<string, string | undefined>;

export interface LocalConfig {
  /** Parent of the default agent folders: <root>/<agent id>. */
  root: string;
  /** Where sessions.json and notes.json live. Never reachable by an agent. */
  stateDir: string;
  port: number;
  open: boolean;
  /** Extra Origins allowed to connect, e.g. http://localhost:3000 while running `next dev`. */
  extraOrigins: string[];
  /** Plugin module paths (see server/plugins.ts). */
  plugins: string[];
  /** The static UI build to serve (Next's `out/`). */
  outDir: string;
}

export function defaultConfig(repoRoot: string): LocalConfig {
  const root = path.join(os.homedir(), "AgentStaff");
  return {
    root,
    stateDir: path.join(root, ".agentstaff"),
    port: DEFAULT_PORT,
    open: true,
    extraOrigins: [],
    plugins: [],
    outDir: path.join(repoRoot, "out"),
  };
}

/** The agent's working folder, or an error if a custom folder isn't allowed. */
export function agentFolder(config: LocalConfig, agent: Agent): { folder: string } | { error: string } {
  const custom = agent.local?.folder?.trim();
  if (!custom) return { folder: path.join(config.root, agent.id) };
  const error = folderError(config, custom);
  return error ? { error } : { folder: path.resolve(custom) };
}

/** Custom folders must be absolute and must not be (or contain) the filesystem root, your home or the state dir. */
export function folderError(config: LocalConfig, folder: string): string | null {
  if (!path.isAbsolute(folder)) return "Use an absolute path.";
  const real = resolveReal(path.resolve(folder));
  const home = resolveReal(os.homedir());
  const state = resolveReal(config.stateDir);
  if (real === path.parse(real).root) return "An agent can't work in the filesystem root.";
  if (isWithin(real, home)) return "An agent can't work in your home folder or above it. Pick a subfolder.";
  if (isWithin(real, state) || isWithin(state, real)) return "That folder holds AgentStaff's own state.";
  return null;
}

/**
 * How the Agent SDK will authenticate. Per Anthropic's docs, third-party apps must use API-key style auth
 * (an API key or a cloud provider), not claude.ai login. We read it from the environment and never store it.
 */
export function detectAuth(env: Env): AuthInfo {
  if (env.ANTHROPIC_API_KEY?.trim()) return { mode: "api-key", detail: "ANTHROPIC_API_KEY from your environment" };
  const providers: [string, string][] = [
    ["CLAUDE_CODE_USE_BEDROCK", "Amazon Bedrock"],
    ["CLAUDE_CODE_USE_VERTEX", "Google Cloud"],
    ["CLAUDE_CODE_USE_FOUNDRY", "Microsoft Foundry"],
    ["CLAUDE_CODE_USE_ANTHROPIC_AWS", "Claude Platform on AWS"],
  ];
  for (const [flag, name] of providers) {
    if (env[flag] && env[flag] !== "0") return { mode: "cloud-provider", detail: name };
  }
  return { mode: "missing", detail: "Set ANTHROPIC_API_KEY in the terminal you start AgentStaff from, then restart it." };
}

/** Environment for the Claude Code subprocess: yours, minus any claude.ai subscription token. */
export function sdkEnv(env: Env, version: string): Record<string, string | undefined> {
  const out: Record<string, string | undefined> = { ...env, CLAUDE_AGENT_SDK_CLIENT_APP: `agentstaff/${version}` };
  delete out.CLAUDE_CODE_OAUTH_TOKEN;
  return out;
}
