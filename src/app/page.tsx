"use client";

import { useEffect, useState } from "react";
import { AgentEditor } from "@/components/AgentEditor";
import { OrgChart } from "@/components/OrgChart";
import { Settings } from "@/components/Settings";
import { Sidebar } from "@/components/Sidebar";
import { TaskBoard } from "@/components/TaskBoard";
import { ThreadView } from "@/components/ThreadView";
import { playDemo } from "@/lib/demo";
import { connectLocal, detectLocal } from "@/lib/local/client";
import * as store from "@/lib/store";
import { useWorkspace } from "@/lib/store";
import type { Agent } from "@/lib/types";

export default function Home() {
  const view = useWorkspace((s) => s.view);
  const demo = useWorkspace((s) => s.demo);
  const [settings, setSettings] = useState<{ reason?: string } | null>(null);
  const [editing, setEditing] = useState<Agent | null | undefined>(undefined); // undefined = closed, null = new
  const [navOpen, setNavOpen] = useState(false);

  useEffect(() => {
    // Local mode (v2): opened from the link `npm run local` prints. Agents run on this machine, no demo.
    if (detectLocal()) {
      store.setLocalStorageKey();
      if (store.loadSaved()) store.markBooted();
      else store.replaceWorkspace(store.freshWorkspace());
      connectLocal();
      return;
    }
    // First visit: play the sample workspace. Returning visitors get their saved workspace.
    if (store.loadSaved()) store.markBooted();
    else playDemo();
  }, []);

  const booted = useWorkspace((s) => s.booted);
  if (!booted) return <div className="h-full bg-bg" />;

  const needKey = () =>
    setSettings({
      reason: demo
        ? "This is a sample workspace. Add your Anthropic API key and start your own workspace to chat with your agents."
        : "Add your Anthropic API key to start chatting.",
    });

  return (
    <div className="flex h-full">
      {/* Sidebar: fixed on desktop, a drawer on mobile */}
      <div className="hidden w-64 shrink-0 md:block">
        <Sidebar onSettings={() => setSettings({})} onHire={() => setEditing(null)} />
      </div>
      {navOpen && (
        <div className="fixed inset-0 z-40 flex md:hidden" onClick={() => setNavOpen(false)}>
          <div className="h-full w-72 max-w-[85%]" onClick={(e) => e.stopPropagation()}>
            <Sidebar
              onSettings={() => {
                setNavOpen(false);
                setSettings({});
              }}
              onHire={() => {
                setNavOpen(false);
                setEditing(null);
              }}
              onNavigate={() => setNavOpen(false)}
            />
          </div>
          <div className="flex-1 bg-black/40" />
        </div>
      )}

      <main className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-line bg-panel px-3 py-2 md:hidden">
          <button onClick={() => setNavOpen(true)} className="rounded-md px-2 py-1 text-lg" aria-label="Open navigation">
            ☰
          </button>
          <span className="font-semibold">AgentStaff</span>
        </div>

        {demo && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-indigo-200 bg-indigo-50 px-4 py-2 text-sm text-indigo-950 dark:border-indigo-900 dark:bg-indigo-950/50 dark:text-indigo-100">
            <span>
              <b>Sample workspace.</b> A replay of a real-style session: the CEO hands Avery a goal, and the team works it in
              parallel. Click the conversations in the sidebar to watch.
            </span>
            <span className="ml-auto flex gap-2">
              <button onClick={() => playDemo()} className="rounded-md border border-indigo-300 px-2.5 py-1 hover:bg-white/60 dark:border-indigo-700 dark:hover:bg-white/10">
                Replay
              </button>
              <button onClick={() => setSettings({})} className="rounded-md bg-indigo-600 px-2.5 py-1 font-medium text-white hover:bg-indigo-700">
                Start your own workspace
              </button>
            </span>
          </div>
        )}

        <div className="min-h-0 flex-1">
          {view.kind === "thread" && <ThreadView key={view.threadId} threadId={view.threadId} onNeedKey={needKey} onEdit={(a) => setEditing(a)} />}
          {view.kind === "org" && <OrgChart onEdit={(a) => setEditing(a)} onHire={() => setEditing(null)} />}
          {view.kind === "board" && <TaskBoard />}
        </div>
      </main>

      {settings && <Settings reason={settings.reason} onClose={() => setSettings(null)} />}
      {editing !== undefined && <AgentEditor agent={editing} onClose={() => setEditing(undefined)} />}
    </div>
  );
}
