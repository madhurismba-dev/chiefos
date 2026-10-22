import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Local mode permission policy. Pure functions over the filesystem, no SDK imports, so it's easy to test.
 *
 * Every tool call an agent makes goes through decide(), from a PreToolUse hook (which runs before Claude
 * Code's own allow rules, so nothing skips it) and again from canUseTool as a second check. Rules, in order:
 *
 *   1. Tools the agent's role doesn't have are denied.
 *   2. File tools must stay inside the agent's own folder. Paths are resolved the way the OS will resolve
 *      them (`..`, `~`, symlinks, including dangling ones); anything that lands outside is denied. This holds
 *      even when "always ask" is on: you can't approve your way out of the folder.
 *   3. With "always ask" on, everything else is surfaced in the UI for approve/deny.
 *   4. Otherwise the role decides: "auto" runs, "ask" waits for you.
 */

export type ToolPolicy = "auto" | "ask";

export interface RoleDefinition {
  label: string;
  description: string;
  /** Built-in Claude Code tools this role may use. Anything not listed is denied (and hidden from the model). */
  tools: Record<string, ToolPolicy>;
}

export const BUILTIN_ROLES: Record<string, RoleDefinition> = {
  builder: {
    label: "Builder",
    description: "Reads and writes files in its own folder. Shell commands ask you first.",
    tools: { Read: "auto", Glob: "auto", Grep: "auto", Write: "auto", Edit: "auto", NotebookEdit: "auto", Bash: "ask" },
  },
  reviewer: {
    label: "Reviewer (read-only)",
    description: "Reads files in its own folder and reports back. Can't write files or run commands.",
    tools: { Read: "auto", Glob: "auto", Grep: "auto" },
  },
};

export const DEFAULT_ROLE = "builder";

/** Web tools are added to any role for agents that have web access in the org chart. */
export const WEB_TOOLS: Record<string, ToolPolicy> = { WebSearch: "auto", WebFetch: "ask" };

/** In-process MCP tools AgentStaff itself provides (hand-offs, shared notes, plugin tools). */
export const OWN_TOOL_PREFIX = "mcp__agentstaff__";

/** Which input fields hold a filesystem path, per built-in tool. */
const PATH_FIELDS: Record<string, string[]> = {
  Read: ["file_path"],
  Write: ["file_path"],
  Edit: ["file_path"],
  MultiEdit: ["file_path"],
  NotebookEdit: ["notebook_path"],
  Glob: ["path"],
  Grep: ["path"],
};
/** Fields that hold a glob pattern; an absolute pattern is checked by its fixed prefix. */
const PATTERN_FIELDS: Record<string, string[]> = { Glob: ["pattern"], Grep: ["glob"] };

export const CHANGE_TOOLS = new Set(["Write", "Edit", "MultiEdit", "NotebookEdit"]);

export interface PolicyInput {
  toolName: string;
  input: Record<string, unknown>;
  /** The agent's working folder (absolute). */
  folder: string;
  role: RoleDefinition;
  alwaysAsk: boolean;
  webAccess: boolean;
}

export interface Decision {
  behavior: "allow" | "deny" | "ask";
  reason: string;
}

/** The built-in tools a role can see, for the SDK's `tools` option. */
export function toolsForRole(role: RoleDefinition, webAccess: boolean): string[] {
  return Object.keys({ ...role.tools, ...(webAccess ? WEB_TOOLS : {}) });
}

export function decide(p: PolicyInput): Decision {
  const { toolName, input } = p;
  const own = toolName.startsWith(OWN_TOOL_PREFIX);
  const policy: ToolPolicy | undefined = own
    ? "auto"
    : { ...p.role.tools, ...(p.webAccess ? WEB_TOOLS : {}) }[toolName];
  if (!policy) return { behavior: "deny", reason: `${toolName} isn't available to the ${p.role.label} role.` };

  for (const field of PATH_FIELDS[toolName] ?? []) {
    const value = input[field];
    if (value === undefined || value === null) continue; // Glob/Grep default to the working folder
    if (typeof value !== "string") return { behavior: "deny", reason: `${field} must be a path.` };
    if (!isInside(p.folder, value)) return { behavior: "deny", reason: `${value} is outside your folder (${p.folder}).` };
  }
  for (const field of PATTERN_FIELDS[toolName] ?? []) {
    const value = input[field];
    if (typeof value !== "string") continue;
    const prefix = globPrefix(value);
    if (prefix !== null && !isInside(p.folder, prefix)) {
      return { behavior: "deny", reason: `${value} reaches outside your folder (${p.folder}).` };
    }
  }

  if (p.alwaysAsk) return { behavior: "ask", reason: "This agent asks before every tool use." };
  if (policy === "ask") return { behavior: "ask", reason: askReason(toolName) };
  return { behavior: "allow", reason: own ? "AgentStaff tool" : "Inside the agent's folder" };
}

function askReason(toolName: string) {
  if (toolName === "Bash") return "Shell commands can touch anything on your machine, so they need your OK.";
  if (toolName === "WebFetch") return "Fetching a URL needs your OK.";
  return `${toolName} needs your OK.`;
}

// ---------- path containment ----------

/** True when `candidate` (absolute, relative to `root`, or `~/...`) resolves to `root` or something under it. */
export function isInside(root: string, candidate: string): boolean {
  if (candidate.includes("\0")) return false;
  const rootReal = resolveReal(path.resolve(root));
  const target = resolveReal(path.resolve(rootReal, expandHome(candidate)));
  return isWithin(rootReal, target);
}

/** Pure path comparison (no filesystem): is `target` equal to or below `root`? Both must be absolute. */
export function isWithin(root: string, target: string): boolean {
  const rel = path.relative(root, target);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false; // different drive on Windows
  return rel.split(path.sep)[0] !== "..";
}

function expandHome(p: string) {
  if (p === "~") return os.homedir();
  if (p.startsWith("~/") || p.startsWith(`~${path.sep}`)) return path.join(os.homedir(), p.slice(2));
  return p;
}

/**
 * Resolve symlinks the way the OS will when the tool opens the path, even when the path doesn't exist yet
 * (Write creates files). Walks up to the deepest existing ancestor, realpaths it, then re-appends the rest.
 * A dangling symlink is followed by hand: writing through it would create its target, possibly outside.
 */
export function resolveReal(abs: string, hops = 0): string {
  if (hops > 40) return abs; // symlink loop; the comparison then fails safe on the unresolved path
  const rest: string[] = [];
  let cur = abs;
  for (;;) {
    try {
      return path.join(fs.realpathSync.native(cur), ...rest);
    } catch {
      let link: string | null = null;
      try {
        if (fs.lstatSync(cur).isSymbolicLink()) link = fs.readlinkSync(cur);
      } catch {
        /* doesn't exist: keep walking up */
      }
      if (link !== null) return resolveReal(path.join(path.resolve(path.dirname(cur), link), ...rest), hops + 1);
      const parent = path.dirname(cur);
      if (parent === cur) return path.join(cur, ...rest);
      rest.unshift(path.basename(cur));
      cur = parent;
    }
  }
}

/** The fixed directory prefix of an absolute or parent-relative glob, or null when it's a plain relative glob. */
export function globPrefix(pattern: string): string | null {
  const expanded = expandHome(pattern);
  const relativeUp = expanded.split(/[\\/]/).includes("..");
  if (!path.isAbsolute(expanded) && !relativeUp) return null;
  const parts = expanded.split(/[\\/]/);
  const fixed: string[] = [];
  for (const part of parts) {
    if (/[*?[\]{}]/.test(part)) break;
    fixed.push(part);
  }
  const joined = fixed.join("/");
  return joined === "" ? "/" : joined;
}
