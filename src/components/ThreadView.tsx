"use client";

import { useEffect, useRef, useState } from "react";
import { isConfigured, sendFromCeo, stopThread } from "@/lib/engine";
import { answerApproval, localSend, localStop } from "@/lib/local/client";
import type { PendingApproval } from "@/lib/local/protocol";
import * as store from "@/lib/store";
import { useWorkspace } from "@/lib/store";
import type { Agent, ChatMessage } from "@/lib/types";
import { Avatar, Markdown } from "./ui";

const SUGGESTIONS: Record<string, string[]> = {
  chief: [
    "We're considering a 14-day free trial for our B2B product. Get the team on it and bring me a recommendation.",
    "Plan our Q1 priorities. Ask the team for input and give me a one-page plan.",
  ],
  pm: ["Write a PRD for a referral program, and get an engineering estimate."],
  dev: ["What tech stack would you pick for an MVP of a mobile habit-tracking app, and how long would it take?"],
  cfo: ["We have $2.1M in the bank and burn $180K a month. What's our runway, and what are three ways to extend it?"],
  marketing: ["Draft a launch plan for a new AI feature, with three growth experiments."],
  research: ["Who are the top competitors in AI meeting notes apps, and how do they price?"],
};

export function ThreadView({ threadId, onNeedKey, onEdit }: { threadId: string; onNeedKey: () => void; onEdit: (a: Agent) => void }) {
  const thread = useWorkspace((s) => s.threads[threadId]);
  const agents = useWorkspace((s) => s.org.agents);
  const demo = useWorkspace((s) => s.demo);
  const local = useWorkspace((s) => s.local);
  const allApprovals = useWorkspace((s) => s.approvals);
  const [draft, setDraft] = useState("");
  const scroller = useRef<HTMLDivElement>(null);
  const stick = useRef(true);

  useEffect(() => {
    const el = scroller.current;
    if (el && stick.current) el.scrollTop = el.scrollHeight;
  }, [thread?.messages]);
  useEffect(() => {
    stick.current = true;
    const el = scroller.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [threadId]);

  if (!thread) return <div className="p-8 text-muted">This conversation no longer exists.</div>;

  const agentOf = (id: string) => agents.find((a) => a.id === id);
  const isDm = thread.kind === "dm";
  const responder = agentOf(isDm ? thread.members[0] : thread.members[1]);
  const asker = isDm ? undefined : agentOf(thread.members[0]);
  const boss = responder?.reportsTo ? agentOf(responder.reportsTo) : undefined;
  const approvals = (allApprovals ?? []).filter((a) => a.threadId === threadId);
  const folder = local && responder ? local.folders[responder.id] : undefined;
  const role = local && responder ? local.roles.find((r) => r.id === (responder.local?.role ?? "builder")) : undefined;

  const send = (text: string) => {
    const t = text.trim();
    if (!t || !responder || thread.busy) return;
    if (local) {
      // Local mode: the agent runs as a Claude Code session on this machine; the server streams it back.
      if (local.status !== "ready") return;
      setDraft("");
      stick.current = true;
      localSend(responder.id, t);
      return;
    }
    if (demo || !isConfigured()) {
      onNeedKey();
      return;
    }
    setDraft("");
    stick.current = true;
    sendFromCeo(responder.id, t).catch(() => undefined);
  };

  return (
    <section className="flex h-full min-w-0 flex-col">
      <header className="flex items-center gap-3 border-b border-line bg-panel px-5 py-3">
        {isDm ? (
          <>
            <Avatar agent={responder} size={36} busy={thread.busy} />
            <div className="min-w-0">
              <h1 className="truncate font-semibold">
                {responder?.name} <span className="font-normal text-muted">· {responder?.title}</span>
              </h1>
              <p className="truncate text-xs text-muted">
                {thread.busy ? "Working…" : `Reports to ${boss ? boss.name : "you"}`}
                {responder?.tools.includes("web_search") && " · can search the web"}
              </p>
              {local && (
                <p className="truncate font-mono text-[11px] text-muted" title={folder}>
                  {folder ?? local.folderErrors[responder?.id ?? ""] ?? "…"}
                  {role && ` · ${role.label}`}
                  {responder?.local?.alwaysAsk && " · asks before every tool"}
                </p>
              )}
            </div>
          </>
        ) : (
          <div className="min-w-0">
            <h1 className="truncate font-semibold">
              {asker?.emoji} {asker?.name} → {responder?.emoji} {responder?.name}
            </h1>
            <p className="text-xs text-muted">A conversation between your agents. You&apos;re watching it live.</p>
          </div>
        )}
        <div className="ml-auto flex shrink-0 items-center gap-2">
          {thread.busy && isDm && !demo && (
            <button onClick={() => (local ? localStop(thread.id) : stopThread(thread.id))} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-accent-soft">
              Stop
            </button>
          )}
          {isDm && responder && (
            <button
              onClick={() => onEdit(responder)}
              className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-accent-soft"
              title={`Rename ${responder.name}, change their role, or remove them`}
            >
              Edit
            </button>
          )}
        </div>
      </header>

      <div
        ref={scroller}
        className="flex-1 overflow-y-auto px-5 py-4"
        onScroll={(e) => {
          const el = e.currentTarget;
          stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
        }}
      >
        {thread.messages.length === 0 && isDm && responder && (
          <div className="mx-auto mt-10 max-w-lg text-center">
            <Avatar agent={responder} size={56} />
            <h2 className="mt-3 text-lg font-semibold">Start a conversation with {responder.name}</h2>
            <p className="mt-1 text-sm text-muted">{responder.mission}</p>
            <div className="mt-5 space-y-2">
              {(SUGGESTIONS[responder.id] ?? []).map((sug) => (
                <button
                  key={sug}
                  onClick={() => send(sug)}
                  className="block w-full rounded-xl border border-line bg-panel px-4 py-3 text-left text-sm hover:border-accent"
                >
                  {sug}
                </button>
              ))}
            </div>
          </div>
        )}
        <div className="mx-auto max-w-3xl space-y-3">
          {thread.messages.map((m) => (
            <Message key={m.id} m={m} agentOf={agentOf} />
          ))}
          {approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} agent={agentOf(a.agentId)} />
          ))}
          {thread.busy && !thread.messages.some((m) => m.streaming && m.text) && (
            <div className="flex items-center gap-2 pl-11 text-sm text-muted">
              <span className="working-dot h-2 w-2 rounded-full bg-emerald-500" /> {responder?.name} is working…
            </div>
          )}
        </div>
      </div>

      {isDm ? (
        <form
          className="border-t border-line bg-panel p-3"
          onSubmit={(e) => {
            e.preventDefault();
            send(draft);
          }}
        >
          <div className="mx-auto flex max-w-3xl items-end gap-2">
            <textarea
              value={draft}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  send(draft);
                }
              }}
              rows={Math.min(6, Math.max(1, draft.split("\n").length))}
              placeholder={
                local && local.status !== "ready"
                  ? "Connecting to the local server…"
                  : thread.busy
                    ? `${responder?.name} is working… chat with others meanwhile`
                    : `Message ${responder?.name}`
              }
              disabled={thread.busy || (!!local && local.status !== "ready")}
              aria-label={`Message ${responder?.name}`}
              className="flex-1 resize-none rounded-xl border border-line bg-bg px-4 py-2.5 text-[14.5px] outline-none focus:border-accent disabled:opacity-60"
            />
            <button
              type="submit"
              disabled={!draft.trim() || thread.busy}
              className="rounded-xl bg-accent px-4 py-2.5 text-sm font-medium text-white disabled:opacity-40"
            >
              Send
            </button>
          </div>
        </form>
      ) : (
        <div className="border-t border-line bg-panel p-3 text-center text-xs text-muted">
          Agents talk here on their own. Message {responder?.name} directly from the sidebar to join in.
        </div>
      )}
    </section>
  );
}

/** Local mode: a tool use waiting for your OK. */
function ApprovalCard({ a, agent }: { a: PendingApproval; agent?: Agent }) {
  return (
    <div className="ml-11 rounded-xl border border-amber-300 bg-amber-50 p-3 text-sm dark:border-amber-800 dark:bg-amber-950/40">
      <div className="font-medium">
        {agent?.name ?? a.agentId} wants to run <span className="font-mono">{a.summary}</span>
      </div>
      <div className="mt-0.5 text-xs text-muted">{a.reason}</div>
      <details className="mt-2">
        <summary className="cursor-pointer text-xs text-muted">Full input</summary>
        <pre className="mt-1 max-h-48 overflow-auto rounded bg-bg p-2 text-[11.5px] whitespace-pre-wrap">{a.detail}</pre>
      </details>
      <div className="mt-2 flex gap-2">
        <button onClick={() => answerApproval(a.id, true)} className="rounded-lg bg-accent px-3 py-1.5 text-sm font-medium text-white hover:opacity-90">
          Approve
        </button>
        <button onClick={() => answerApproval(a.id, false)} className="rounded-lg border border-line px-3 py-1.5 text-sm hover:bg-accent-soft">
          Deny
        </button>
      </div>
    </div>
  );
}

function Message({ m, agentOf }: { m: ChatMessage; agentOf: (id: string) => Agent | undefined }) {
  const agent = m.author === "ceo" ? undefined : agentOf(m.author);
  const time = new Date(m.ts).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });

  if (m.kind === "note") {
    return (
      <div className="flex items-center gap-2 pl-11 text-[13px] text-muted">
        <span aria-hidden>↳</span>
        {m.linkThreadId ? (
          <button
            onClick={() => store.setView({ kind: "thread", threadId: m.linkThreadId! })}
            className="truncate text-left hover:text-accent hover:underline"
            title="Open this conversation"
          >
            {m.text}
          </button>
        ) : (
          <span className="truncate">{m.text}</span>
        )}
      </div>
    );
  }

  return (
    <div className="flex gap-3">
      {m.author === "ceo" ? (
        <span className="grid h-8 w-8 shrink-0 place-items-center rounded-lg bg-zinc-800 text-xs font-semibold text-white dark:bg-zinc-200 dark:text-zinc-900">
          You
        </span>
      ) : (
        <Avatar agent={agent} size={32} />
      )}
      <div className="min-w-0 flex-1">
        <div className="flex items-baseline gap-2">
          <span className="text-sm font-semibold">{m.author === "ceo" ? "You (CEO)" : agent?.name}</span>
          <span className="text-[11px] text-muted">{time}</span>
        </div>
        {m.kind === "error" ? (
          <p className="mt-0.5 rounded-lg bg-rose-50 px-3 py-2 text-sm text-rose-700 dark:bg-rose-950/40 dark:text-rose-300">{m.text}</p>
        ) : (
          <div className={m.streaming ? "caret" : ""}>
            <Markdown text={m.text} />
          </div>
        )}
      </div>
    </div>
  );
}
