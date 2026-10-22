"use client";

import * as store from "@/lib/store";
import { dmId, useWorkspace } from "@/lib/store";
import type { View } from "@/lib/types";
import { Avatar, isAgentBusy } from "./ui";

export function Sidebar({ onSettings, onHire, onNavigate }: { onSettings: () => void; onHire: () => void; onNavigate?: () => void }) {
  const s = useWorkspace((x) => x);
  const go = (view: View) => {
    store.setView(view);
    onNavigate?.();
  };
  const active = (v: View) => JSON.stringify(v) === JSON.stringify(s.view);
  const teamThreads = Object.values(s.threads)
    .filter((t) => t.kind === "team" && t.messages.length > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt);
  const nameOf = (id: string) => s.org.agents.find((a) => a.id === id)?.name ?? id;
  const anyBusy = Object.values(s.threads).some((t) => t.busy);
  const approvals = s.approvals ?? [];
  const item = (on: boolean) =>
    `flex w-full items-center gap-2.5 rounded-lg px-2.5 py-1.5 text-left text-[14px] ${
      on ? "bg-white/12 text-white" : "text-sidebar-ink hover:bg-white/6"
    }`;

  return (
    <nav className="flex h-full w-full flex-col bg-sidebar text-sidebar-ink" aria-label="Workspace">
      <div className="border-b border-white/8 px-4 py-4">
        <div className="flex items-center gap-2 text-[15px] font-semibold text-white">
          <span className="grid h-7 w-7 place-items-center rounded-lg bg-indigo-500 text-sm">⌘</span>
          AgentStaff
          {anyBusy && <span className="working-dot ml-auto h-2 w-2 rounded-full bg-emerald-400" title="Agents working" />}
        </div>
        <div className="mt-1 truncate text-xs text-sidebar-muted">{s.org.name}</div>
      </div>

      <div className="flex-1 space-y-5 overflow-y-auto px-2 py-3">
        <div className="space-y-0.5">
          {approvals.length > 0 && (
            <button
              className="flex w-full items-center gap-2.5 rounded-lg bg-amber-400/15 px-2.5 py-1.5 text-left text-[14px] text-amber-200 hover:bg-amber-400/25"
              onClick={() => go({ kind: "thread", threadId: approvals[0].threadId })}
            >
              <span className="w-5 text-center">✋</span> {approvals.length} waiting for your OK
            </button>
          )}
          <button className={item(active({ kind: "org" }))} onClick={() => go({ kind: "org" })}>
            <span className="w-5 text-center">🏢</span> Org chart
          </button>
          <button className={item(active({ kind: "board" }))} onClick={() => go({ kind: "board" })}>
            <span className="w-5 text-center">📋</span> Task board
            {s.tasks.length > 0 && (
              <span className="ml-auto text-xs text-sidebar-muted">
                {s.tasks.filter((t) => t.status !== "done").length} open
              </span>
            )}
          </button>
        </div>

        <div>
          <div className="mb-1 flex items-center justify-between px-2.5 text-[11px] font-semibold tracking-wider text-sidebar-muted uppercase">
            Team
            <button onClick={onHire} className="rounded px-1 text-base leading-none hover:text-white" title="Hire an agent" aria-label="Hire an agent">
              +
            </button>
          </div>
          <div className="space-y-0.5">
            {s.org.agents.map((a) => {
              const t = s.threads[dmId(a.id)];
              const view: View = { kind: "thread", threadId: dmId(a.id) };
              return (
                <button key={a.id} className={item(active(view))} onClick={() => go(view)}>
                  <Avatar agent={a} size={26} busy={isAgentBusy(s, a.id)} />
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{a.name}</span>
                    <span className="block truncate text-[11.5px] text-sidebar-muted">{a.title}</span>
                  </span>
                  {t && t.unread > 0 && (
                    <span className="rounded-full bg-rose-500 px-1.5 text-[11px] font-semibold text-white">{t.unread}</span>
                  )}
                </button>
              );
            })}
          </div>
        </div>

        {teamThreads.length > 0 && (
          <div>
            <div className="mb-1 px-2.5 text-[11px] font-semibold tracking-wider text-sidebar-muted uppercase">
              Agent conversations
            </div>
            <div className="space-y-0.5">
              {teamThreads.map((t) => {
                const view: View = { kind: "thread", threadId: t.id };
                return (
                  <button key={t.id} className={item(active(view))} onClick={() => go(view)}>
                    <span className="w-5 text-center text-sidebar-muted">#</span>
                    <span className="min-w-0 flex-1 truncate">
                      {nameOf(t.members[0])} → {nameOf(t.members[1])}
                    </span>
                    {t.busy && <span className="working-dot h-2 w-2 rounded-full bg-emerald-400" />}
                    {!t.busy && t.unread > 0 && <span className="h-2 w-2 rounded-full bg-rose-400" />}
                  </button>
                );
              })}
            </div>
          </div>
        )}
      </div>

      <div className="border-t border-white/8 p-3">
        {s.local && (
          <div className="mb-2 px-1 text-xs text-sidebar-muted" title={s.local.error}>
            <span
              className={`mr-1.5 inline-block h-2 w-2 rounded-full ${
                s.local.status === "ready" ? "bg-emerald-400" : s.local.status === "connecting" ? "bg-amber-400" : "bg-rose-400"
              }`}
            />
            Local mode · {s.local.status === "ready" ? "connected" : s.local.status}
            {s.local.status === "ready" && s.local.auth?.mode === "missing" && (
              <span className="block text-rose-300">No ANTHROPIC_API_KEY on the server</span>
            )}
            {s.local.status === "disconnected" && <span className="block">{s.local.error}</span>}
          </div>
        )}
        {s.demo ? (
          <div className="mb-2 px-1 text-xs text-sidebar-muted">Sample workspace · no API calls</div>
        ) : (
          <div className="mb-2 px-1 text-xs text-sidebar-muted" title="Estimated from token usage at list prices">
            Spend this workspace: <span className="text-sidebar-ink">${s.usage.costUsd.toFixed(2)}</span>
            {s.usage.inputTokens > 0 && (
              <span className="block">
                {Math.round(((s.usage.cachedTokens ?? 0) / s.usage.inputTokens) * 100)}% of input served from cache
              </span>
            )}
          </div>
        )}
        <button onClick={onSettings} className={item(false)}>
          <span className="w-5 text-center">⚙️</span> Settings
        </button>
      </div>
    </nav>
  );
}
