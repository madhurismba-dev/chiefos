import type { Agent, Org } from "../src/lib/types";

/**
 * Hand-off routing for local mode. Same rules as the browser engine:
 *
 * - The agent you're talking to can reach the whole team; everyone else hands off only to direct reports.
 * - At most You → agent → colleague → colleague, and no one can hand back to anyone already in the chain.
 *
 * What's new in v2: a hand-off says what to return (`return_format`), caps the colleague's turns
 * (`max_turns`), and can point at shared notes by name instead of pasting them in.
 */

export const MAX_DEPTH = 2; // CEO → agent (0) → colleague (1) → colleague (2, can't hand off further)
export const DEFAULT_HANDOFF_TURNS = 12;
export const MAX_HANDOFF_TURNS = 40;
export const MAX_NOTES_PER_HANDOFF = 10;

export interface HandoffRequest {
  to: string;
  task: string;
  return_format: string;
  max_turns?: number;
  notes?: string[];
}

export function reachableColleagues(org: Org, agentId: string, depth: number, chain: string[]): string[] {
  if (depth >= MAX_DEPTH) return [];
  return org.agents
    .filter((a) => a.id !== agentId && !chain.includes(a.id) && (depth === 0 || a.reportsTo === agentId))
    .map((a) => a.id);
}

export type HandoffPlan =
  | { ok: true; colleague: Agent; maxTurns: number; notes: string[] }
  | { ok: false; error: string };

/** Validate a hand-off before anything runs. `noteExists` checks the shared notes store. */
export function planHandoff(
  org: Org,
  from: Agent,
  depth: number,
  chain: string[],
  req: HandoffRequest,
  noteExists: (name: string) => boolean,
): HandoffPlan {
  const reachable = reachableColleagues(org, from.id, depth, chain);
  const colleague = org.agents.find((a) => a.id === req.to);
  if (!colleague || !reachable.includes(req.to)) {
    return {
      ok: false,
      error: reachable.length
        ? `You can't hand off to "${req.to}" from here. You can reach: ${reachable.join(", ")}.`
        : "You can't hand off from here. Do the work yourself.",
    };
  }
  if (!req.task.trim()) return { ok: false, error: "Say what the colleague should do (task)." };
  if (!req.return_format.trim()) return { ok: false, error: "Say what they should send back (return_format)." };
  const notes = [...new Set(req.notes ?? [])];
  if (notes.length > MAX_NOTES_PER_HANDOFF) return { ok: false, error: `Pass at most ${MAX_NOTES_PER_HANDOFF} notes.` };
  const missing = notes.filter((n) => !noteExists(n));
  if (missing.length) return { ok: false, error: `No note named ${missing.join(", ")}. Write it with write_note first.` };
  const maxTurns = Math.min(Math.max(1, Math.floor(req.max_turns ?? DEFAULT_HANDOFF_TURNS)), MAX_HANDOFF_TURNS);
  return { ok: true, colleague, maxTurns, notes };
}

/** The first user message the colleague sees in their hand-off thread. */
export function handoffPrompt(from: Agent, req: HandoffRequest, plan: Extract<HandoffPlan, { ok: true }>): string {
  const lines = [
    `Hand-off from your colleague ${from.name} (${from.title}).`,
    "",
    `Task:\n${req.task.trim()}`,
    "",
    `Send back:\n${req.return_format.trim()}`,
  ];
  if (plan.notes.length) {
    lines.push("", `Shared notes for this task (read them with read_note): ${plan.notes.join(", ")}`);
  }
  lines.push(
    "",
    `You have at most ${plan.maxTurns} turns. Work in your own folder. Finish with exactly what was asked ` +
      `for in "Send back"; put anything long in a shared note (write_note) and return its name.`,
  );
  return lines.join("\n");
}

/** The team roster for system prompts, with who reports to whom. */
export function roster(org: Org): string {
  return org.agents
    .map((a) => {
      const boss = a.reportsTo ? org.agents.find((b) => b.id === a.reportsTo)?.name ?? "the CEO" : "the CEO";
      return `- ${a.id}: ${a.name}, ${a.title} (reports to ${boss})`;
    })
    .join("\n");
}
