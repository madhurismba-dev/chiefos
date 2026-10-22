import { readJson, writeJsonAtomic } from "./sessions";

/**
 * Shared context store: named notes every agent can read and write.
 *
 * Hand-offs pass notes by reference: `message_colleague` lists note names, and the colleague reads only the
 * ones it needs with `read_note`. Long specs, findings and file lists don't get copied into every prompt.
 * (Idea from Danau5tin/multi-agent-coding-system's context store; no code taken.)
 */

export const NOTE_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/i;
export const MAX_NOTE_CHARS = 64_000;
export const MAX_NOTES = 200;

export interface Note {
  name: string;
  content: string;
  author: string; // agent id
  updatedAt: number;
}

interface NotesFile {
  version: 1;
  notes: Record<string, Note>;
}

export class NotesStore {
  private data: NotesFile = { version: 1, notes: {} };

  constructor(private readonly file: string | null) {
    if (file) {
      this.data = readJson<NotesFile>(file, (raw) => {
        const d = raw as Partial<NotesFile>;
        return d.version === 1 && d.notes && typeof d.notes === "object" ? (d as NotesFile) : null;
      }) ?? this.data;
    }
  }

  has(name: string) {
    return Object.hasOwn(this.data.notes, name);
  }

  get(name: string): Note | undefined {
    return this.has(name) ? this.data.notes[name] : undefined;
  }

  list(): (Omit<Note, "content"> & { chars: number })[] {
    return Object.values(this.data.notes)
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map(({ content, ...rest }) => ({ ...rest, chars: content.length }));
  }

  /** Returns an error message, or null on success. */
  write(name: string, content: string, author: string): string | null {
    if (!NOTE_NAME.test(name)) return "Note names use letters, digits, dot, dash and underscore (max 64).";
    if (content.length > MAX_NOTE_CHARS) return `Notes are limited to ${MAX_NOTE_CHARS} characters. Split it up.`;
    if (!this.has(name) && Object.keys(this.data.notes).length >= MAX_NOTES) return "The notes store is full.";
    this.data.notes[name] = { name, content, author, updatedAt: Date.now() };
    if (this.file) writeJsonAtomic(this.file, this.data);
    return null;
  }

  clear() {
    this.data.notes = {};
    if (this.file) writeJsonAtomic(this.file, this.data);
  }
}
