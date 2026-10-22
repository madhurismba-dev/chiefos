import fs from "node:fs";
import path from "node:path";

/**
 * Saved Claude Code session IDs, so agents pick up where they left off after a restart.
 *
 * Grouped by agent, then by thread: an agent's DM with you and each of its hand-off threads with a colleague
 * are separate sessions (like v1's separate conversations), which is what lets them run in parallel.
 * The transcripts themselves are kept by Claude Code; this file only maps threads to session IDs.
 */

interface SessionFile {
  version: 1;
  agents: Record<string, Record<string, { sessionId: string; updatedAt: number }>>;
}

export class SessionStore {
  private data: SessionFile = { version: 1, agents: {} };

  constructor(private readonly file: string) {
    this.data = readJson<SessionFile>(file, (raw) => {
      const d = raw as Partial<SessionFile>;
      return d.version === 1 && d.agents && typeof d.agents === "object" ? (d as SessionFile) : null;
    }) ?? this.data;
  }

  get(agentId: string, threadId: string): string | undefined {
    return this.data.agents[agentId]?.[threadId]?.sessionId;
  }

  set(agentId: string, threadId: string, sessionId: string) {
    if (this.get(agentId, threadId) === sessionId) return;
    (this.data.agents[agentId] ??= {})[threadId] = { sessionId, updatedAt: Date.now() };
    this.save();
  }

  forget(agentId: string, threadId?: string) {
    if (threadId) delete this.data.agents[agentId]?.[threadId];
    else delete this.data.agents[agentId];
    this.save();
  }

  forgetAll() {
    this.data.agents = {};
    this.save();
  }

  /** agentId → threadId → sessionId, for display and tests. */
  snapshot(): Record<string, Record<string, string>> {
    return Object.fromEntries(
      Object.entries(this.data.agents).map(([a, threads]) => [
        a,
        Object.fromEntries(Object.entries(threads).map(([t, s]) => [t, s.sessionId])),
      ]),
    );
  }

  private save() {
    writeJsonAtomic(this.file, this.data);
  }
}

/** Read a JSON file. Missing → null. Unreadable or invalid → moved aside to `<file>.bad` and null. */
export function readJson<T>(file: string, validate: (raw: unknown) => T | null): T | null {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
  try {
    const parsed = validate(JSON.parse(text));
    if (parsed) return parsed;
  } catch {
    /* fall through */
  }
  try {
    fs.renameSync(file, `${file}.bad`);
  } catch {
    /* ignore */
  }
  return null;
}

/** Write via a temp file and rename, so a crash never leaves half a file. Owner-only permissions. */
export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2), { mode: 0o600 });
  fs.renameSync(tmp, file);
}
