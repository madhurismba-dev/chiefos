"use client";

import { useSyncExternalStore } from "react";
import { TEMPLATES, cloneOrg } from "./templates";
import type { AuthorId, BoardTask, ChatMessage, Org, Settings, Thread, Usage, View, WorkspaceState } from "./types";

/**
 * A tiny external store. The agent engine mutates it from outside React (many agents stream at once),
 * and components subscribe with useWorkspace(). Real workspaces persist to localStorage; the demo doesn't.
 */

let STATE_KEY = "agentstaff:workspace:v1";
const KEY_KEY = "agentstaff:apiKey";
const LEGACY = { "chiefos:workspace:v1": STATE_KEY, "chiefos:apiKey": KEY_KEY };   // the app's earlier name

/** One-click presets. New workspaces start on Balanced so a first run never surprises anyone. */
export const COST_MODES = {
  economy: { model: "claude-haiku-5-5", effort: "low", allowWebSearch: false, maxCostPerRequest: 0.25 },
  balanced: { model: "claude-sonnet-5-5", effort: "medium", allowWebSearch: true, maxCostPerRequest: 0.75 },
  best: { model: "claude-opus-5-5", effort: "medium", allowWebSearch: true, maxCostPerRequest: 2 },
} as const satisfies Record<Exclude<Settings["mode"], "custom">, Partial<Settings>>;

export const DEFAULT_SETTINGS: Settings = { apiKey: "", mode: "balanced", ...COST_MODES.balanced };

const emptyUsage = (): Usage => ({ inputTokens: 0, outputTokens: 0, webSearches: 0, costUsd: 0 });

export function freshWorkspace(org: Org = cloneOrg(TEMPLATES[0]), settings: Settings = DEFAULT_SETTINGS): WorkspaceState {
  const first = org.agents[0];
  const threads: Record<string, Thread> = {};
  for (const a of org.agents) threads[dmId(a.id)] = newThread(dmId(a.id), "dm", [a.id]);
  return {
    org,
    threads,
    tasks: [],
    usage: emptyUsage(),
    settings,
    view: first ? { kind: "thread", threadId: dmId(first.id) } : { kind: "org" },
    demo: false,
  };
}

export const dmId = (agentId: string) => `dm:${agentId}`;
export const teamId = (from: string, to: string) => `team:${from}:${to}`;

function newThread(id: string, kind: Thread["kind"], members: string[]): Thread {
  return { id, kind, members, messages: [], history: [], busy: false, unread: 0, updatedAt: Date.now() };
}

let state: WorkspaceState = freshWorkspace();
const listeners = new Set<() => void>();
let saveTimer: ReturnType<typeof setTimeout> | undefined;

export function getState() {
  return state;
}

export function setState(update: (s: WorkspaceState) => WorkspaceState) {
  state = update(state);
  listeners.forEach((l) => l());
  clearTimeout(saveTimer);
  saveTimer = setTimeout(save, 400);
}

export function subscribe(l: () => void) {
  listeners.add(l);
  return () => listeners.delete(l);
}

/** Local mode keeps its workspace apart from the browser-mode one (they can share an origin under `next dev`). */
export function setLocalStorageKey() {
  STATE_KEY = "agentstaff:local:workspace:v1";
}

export function useWorkspace<T>(select: (s: WorkspaceState) => T): T {
  return useSyncExternalStore(subscribe, () => select(state), () => select(state));
}

// ---------- persistence ----------

function save() {
  try {
    // The sample workspace is never saved, but a key entered while viewing it is.
    if (state.demo) {
      localStorage.setItem(KEY_KEY, state.settings.apiKey);
      return;
    }
    const { settings, local, approvals, ...rest } = state;
    void local; // connection state and pending approvals belong to this session only
    void approvals;
    // Never write streaming/busy flags; a reload mid-run shouldn't leave agents "working" forever.
    const threads = Object.fromEntries(
      Object.entries(rest.threads).map(([id, t]) => [
        id,
        { ...t, busy: false, messages: t.messages.map((m) => ({ ...m, streaming: false })) },
      ]),
    );
    localStorage.setItem(STATE_KEY, JSON.stringify({ ...rest, booted: undefined, threads, settings: { ...settings, apiKey: "" } }));
    localStorage.setItem(KEY_KEY, settings.apiKey);
  } catch {
    /* storage full or blocked: the app still works for this session */
  }
}

/** Load the saved workspace. Returns false when there is none (first visit). */
export function loadSaved(): boolean {
  try {
    for (const [old, now] of Object.entries(LEGACY)) {
      const v = localStorage.getItem(old);
      if (v !== null && localStorage.getItem(now) === null) localStorage.setItem(now, v);
      if (v !== null) localStorage.removeItem(old);
    }
    const raw = localStorage.getItem(STATE_KEY);
    const apiKey = localStorage.getItem(KEY_KEY) ?? "";
    if (!raw) {
      if (apiKey) state = { ...state, settings: { ...state.settings, apiKey } };
      return false;
    }
    const saved = JSON.parse(raw) as WorkspaceState;
    state = { ...saved, settings: { ...DEFAULT_SETTINGS, ...saved.settings, apiKey }, demo: false };
    listeners.forEach((l) => l());
    return true;
  } catch {
    return false;
  }
}

export function replaceWorkspace(next: WorkspaceState) {
  setState((s) => ({ ...next, booted: true, local: s.local, approvals: s.approvals }));
}

export function markBooted() {
  if (!state.booted) setState((s) => ({ ...s, booted: true }));
}

// ---------- mutations used by the UI and the engine ----------

export function setView(view: View) {
  setState((s) => {
    const threads =
      view.kind === "thread" && s.threads[view.threadId]
        ? { ...s.threads, [view.threadId]: { ...s.threads[view.threadId], unread: 0 } }
        : s.threads;
    return { ...s, view, threads };
  });
}

export function updateSettings(patch: Partial<Settings>) {
  setState((s) => ({ ...s, settings: { ...s.settings, ...patch } }));
}

export function ensureThread(id: string, kind: Thread["kind"], members: string[]) {
  if (!state.threads[id]) {
    setState((s) => ({ ...s, threads: { ...s.threads, [id]: newThread(id, kind, members) } }));
  }
  return state.threads[id];
}

function patchThread(id: string, patch: (t: Thread) => Partial<Thread>) {
  setState((s) => {
    const t = s.threads[id];
    if (!t) return s;
    return { ...s, threads: { ...s.threads, [id]: { ...t, ...patch(t), updatedAt: Date.now() } } };
  });
}

let counter = 0;
const uid = (p: string) => `${p}_${Date.now().toString(36)}_${(counter++).toString(36)}`;

export function addMessage(threadId: string, author: AuthorId, text: string, extra: Partial<ChatMessage> = {}) {
  const msg: ChatMessage = { id: uid("m"), author, text, ts: Date.now(), kind: "text", ...extra };
  patchThread(threadId, (t) => {
    const viewing = state.view.kind === "thread" && state.view.threadId === threadId;
    const countsAsUnread = !viewing && author !== "ceo" && msg.kind === "text";
    return { messages: [...t.messages, msg], unread: t.unread + (countsAsUnread ? 1 : 0) };
  });
  return msg.id;
}

export function appendToMessage(threadId: string, msgId: string, delta: string) {
  patchThread(threadId, (t) => ({
    messages: t.messages.map((m) => (m.id === msgId ? { ...m, text: m.text + delta } : m)),
  }));
}

export function finishMessage(threadId: string, msgId: string) {
  patchThread(threadId, (t) => ({
    // Drop bubbles that never received text (e.g. a turn that only called tools).
    messages: t.messages
      .map((m) => (m.id === msgId ? { ...m, streaming: false } : m))
      .filter((m) => !(m.id === msgId && m.kind === "text" && !m.text.trim())),
  }));
}

export function pushHistory(threadId: string, entry: Thread["history"][number]) {
  patchThread(threadId, (t) => ({ history: [...t.history, entry] }));
}

export function setBusy(threadId: string, busy: boolean) {
  patchThread(threadId, () => ({ busy }));
}

export function addUsage(delta: Usage) {
  setState((s) => ({
    ...s,
    usage: {
      inputTokens: s.usage.inputTokens + delta.inputTokens,
      outputTokens: s.usage.outputTokens + delta.outputTokens,
      webSearches: s.usage.webSearches + delta.webSearches,
      cachedTokens: (s.usage.cachedTokens ?? 0) + (delta.cachedTokens ?? 0),
      costUsd: s.usage.costUsd + delta.costUsd,
    },
  }));
}

export function createTask(t: Omit<BoardTask, "id" | "updatedAt">) {
  const task: BoardTask = { ...t, id: `T-${state.tasks.length + 1}`, updatedAt: Date.now() };
  setState((s) => ({ ...s, tasks: [...s.tasks, task] }));
  return task;
}

export function updateTask(id: string, patch: Partial<BoardTask>) {
  let found: BoardTask | undefined;
  setState((s) => ({
    ...s,
    tasks: s.tasks.map((t) => (t.id === id ? (found = { ...t, ...patch, updatedAt: Date.now() }) : t)),
  }));
  return found;
}

export function saveAgent(agent: Org["agents"][number]) {
  setState((s) => {
    const exists = s.org.agents.some((a) => a.id === agent.id);
    const agents = exists ? s.org.agents.map((a) => (a.id === agent.id ? agent : a)) : [...s.org.agents, agent];
    const threads = s.threads[dmId(agent.id)]
      ? s.threads
      : { ...s.threads, [dmId(agent.id)]: newThread(dmId(agent.id), "dm", [agent.id]) };
    return { ...s, org: { ...s.org, agents }, threads };
  });
}

export function removeAgent(agentId: string) {
  setState((s) => {
    const agents = s.org.agents
      .filter((a) => a.id !== agentId)
      .map((a) => (a.reportsTo === agentId ? { ...a, reportsTo: null } : a));
    const threads = Object.fromEntries(Object.entries(s.threads).filter(([, t]) => !t.members.includes(agentId)));
    const view = s.view.kind === "thread" && !threads[s.view.threadId] ? ({ kind: "org" } as View) : s.view;
    return { ...s, org: { ...s.org, agents }, threads, view };
  });
}
