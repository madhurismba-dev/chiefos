"use client";

import * as store from "../store";
import type { LocalStatus, Org, Settings, Thread } from "../types";
import { WS_PATH, WS_PROTOCOL, WS_TOKEN_PREFIX, type ClientMessage, type ServerEvent } from "./protocol";

/**
 * Browser side of local mode (v2). Active only when the page was opened from the link the local server
 * prints (`#token=…`); the hosted static site never sees a token and behaves exactly like v1.
 *
 * The server streams events that mirror the store's own mutations, so local agents show up in the same
 * threads, notes, busy dots and cost meter as browser-mode agents.
 */

const TOKEN_KEY = "agentstaff:localToken";
const PORT_KEY = "agentstaff:localPort";

let socket: WebSocket | null = null;
let retry = 0;
let lastSent: { org: Org; settings: Settings } | null = null;

/** Pick the token up from the URL (then hide it) or from this tab's session. True when local mode is on. */
export function detectLocal(): boolean {
  try {
    const params = new URLSearchParams(location.hash.slice(1));
    const token = params.get("token");
    if (token && /^[a-f0-9]{64}$/.test(token)) {
      sessionStorage.setItem(TOKEN_KEY, token);
      const port = params.get("port");
      if (port && /^\d{2,5}$/.test(port)) sessionStorage.setItem(PORT_KEY, port);
      history.replaceState(null, "", location.pathname + location.search); // keep the token out of history
    }
    return !!sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return false;
  }
}

export const isLocal = () => !!store.getState().local;

export function connectLocal() {
  const token = sessionStorage.getItem(TOKEN_KEY);
  if (!token || (socket && socket.readyState <= WebSocket.OPEN)) return; // already connected or connecting
  setLocal({ status: "connecting" });
  // Under `next dev` the UI and the server are on different ports; otherwise the server serves this page.
  const port = sessionStorage.getItem(PORT_KEY);
  const host = port ? `127.0.0.1:${port}` : location.host;
  const ws = new WebSocket(`ws://${host}${WS_PATH}`, [WS_PROTOCOL, `${WS_TOKEN_PREFIX}${token}`]);
  socket = ws;

  ws.onopen = () => {
    retry = 0;
  };
  ws.onmessage = (e) => {
    try {
      apply(JSON.parse(String(e.data)) as ServerEvent);
    } catch {
      /* ignore malformed events */
    }
  };
  ws.onclose = () => {
    if (socket !== ws) return;
    socket = null;
    lastSent = null;
    setLocal({
      status: "disconnected",
      error: "Lost the connection to the local server. If you restarted it, open the new link from your terminal.",
    });
    store.setState((s) => ({ ...s, approvals: [] }));
    retry = Math.min(retry + 1, 5);
    setTimeout(connectLocal, 1000 * 2 ** retry);
  };
}

function send(msg: ClientMessage) {
  if (socket?.readyState === WebSocket.OPEN) {
    socket.send(JSON.stringify(msg));
    return true;
  }
  return false;
}

export function localSend(agentId: string, text: string) {
  if (!send({ type: "send", agentId, text })) {
    setLocal({ error: "Not connected to the local server." });
  }
}

export const localStop = (threadId: string) => send({ type: "stop", threadId });
export const answerApproval = (id: string, allow: boolean) => send({ type: "approval", id, allow });
export const resetLocalSessions = () => send({ type: "reset_sessions" });

/** Send the team and run settings whenever they change, so the server always runs the current org. */
function syncWorkspace() {
  const s = store.getState();
  if (s.local?.status !== "ready") return;
  if (lastSent && lastSent.org === s.org && lastSent.settings === s.settings) return;
  lastSent = { org: s.org, settings: s.settings };
  const { model, effort, maxCostPerRequest, allowWebSearch } = s.settings;
  send({ type: "workspace", org: s.org, settings: { model, effort, maxCostPerRequest, allowWebSearch } });
}
if (typeof window !== "undefined") store.subscribe(syncWorkspace);

function setLocal(patch: Partial<LocalStatus>) {
  store.setState((s) => ({
    ...s,
    local: { status: "connecting", roles: [], folders: {}, folderErrors: {}, ...s.local, ...patch },
  }));
}

function ensureThread(threadId: string, members?: string[]) {
  if (store.getState().threads[threadId]) return;
  const [kind, ...rest] = threadId.split(":");
  store.ensureThread(threadId, kind === "team" ? "team" : "dm", members ?? rest);
}

function apply(ev: ServerEvent) {
  switch (ev.type) {
    case "ready":
      setLocal({ status: "ready", version: ev.version, auth: ev.auth, root: ev.root, roles: ev.roles, error: undefined });
      store.setState((s) => ({
        ...s,
        approvals: ev.approvals,
        threads: Object.fromEntries(
          Object.entries(s.threads).map(([id, t]) => [id, { ...t, busy: ev.busy.includes(id) }]),
        ) as Record<string, Thread>,
      }));
      syncWorkspace();
      break;
    case "folders":
      setLocal({ folders: ev.folders, folderErrors: ev.errors });
      break;
    case "thread":
      ensureThread(ev.threadId, ev.members);
      break;
    case "message":
      ensureThread(ev.threadId);
      store.addMessage(ev.threadId, ev.author, ev.text, {
        id: ev.id,
        kind: ev.kind,
        linkThreadId: ev.linkThreadId,
        streaming: ev.streaming,
      });
      break;
    case "append":
      store.appendToMessage(ev.threadId, ev.id, ev.text);
      break;
    case "finish":
      store.finishMessage(ev.threadId, ev.id);
      break;
    case "busy":
      ensureThread(ev.threadId);
      store.setBusy(ev.threadId, ev.busy);
      break;
    case "usage":
      store.addUsage(ev.usage);
      break;
    case "approval":
      store.setState((s) => ({ ...s, approvals: [...(s.approvals ?? []).filter((a) => a.id !== ev.approval.id), ev.approval] }));
      break;
    case "approval_resolved":
      store.setState((s) => ({ ...s, approvals: (s.approvals ?? []).filter((a) => a.id !== ev.id) }));
      break;
    case "error":
      setLocal({ error: ev.message });
      break;
  }
}
