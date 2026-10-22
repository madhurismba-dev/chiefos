"use client";

import { useState } from "react";
import * as store from "@/lib/store";
import { useWorkspace } from "@/lib/store";
import type { Agent } from "@/lib/types";
import { Modal, btnGhost, btnPrimary, inputCls } from "./ui";

const COLORS = ["#4f46e5", "#7c3aed", "#2563eb", "#0891b2", "#059669", "#d97706", "#db2777", "#dc2626"];

const slug = (s: string) =>
  s.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 24) || "agent";

export function AgentEditor({ agent, onClose }: { agent: Agent | null; onClose: () => void }) {
  const agents = useWorkspace((s) => s.org.agents);
  const busy = useWorkspace((s) => Object.values(s.threads).some((t) => t.busy));
  const local = useWorkspace((s) => s.local);
  const isNew = agent === null;
  const [form, setForm] = useState<Agent>(() =>
    agent ?? {
      id: "",
      name: "",
      title: "",
      emoji: "🤖",
      color: COLORS[Math.floor(Math.random() * COLORS.length)],
      reportsTo: agents[0]?.id ?? null,
      mission: "",
      tools: [],
    },
  );
  const set = (patch: Partial<Agent>) => setForm((f) => ({ ...f, ...patch }));
  const setLocal = (patch: NonNullable<Agent["local"]>) => setForm((f) => ({ ...f, local: { ...f.local, ...patch } }));
  const valid = form.name.trim() && form.title.trim() && form.mission.trim();

  const save = () => {
    if (!valid) return;
    let id = form.id;
    if (isNew) {
      id = slug(form.title);
      while (agents.some((a) => a.id === id)) id = `${slug(form.title)}-${Math.floor(Math.random() * 1000)}`;
    }
    store.saveAgent({ ...form, id, name: form.name.trim(), title: form.title.trim(), mission: form.mission.trim() });
    onClose();
  };

  return (
    <Modal title={isNew ? "Hire an AI agent" : `Edit ${agent.name}`} onClose={onClose} wide>
      <div className="grid gap-4 sm:grid-cols-[80px_1fr_1fr]">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Emoji</span>
          <input className={`${inputCls} text-center text-lg`} value={form.emoji} maxLength={4} onChange={(e) => set({ emoji: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Name</span>
          <input className={inputCls} value={form.name} placeholder="e.g. Jordan" onChange={(e) => set({ name: e.target.value })} />
        </label>
        <label className="text-sm">
          <span className="mb-1 block text-muted">Title</span>
          <input className={inputCls} value={form.title} placeholder="e.g. Head of Sales" onChange={(e) => set({ title: e.target.value })} />
        </label>
      </div>

      <label className="mt-4 block text-sm">
        <span className="mb-1 block text-muted">Role and responsibilities (this becomes the agent&apos;s instructions)</span>
        <textarea
          className={`${inputCls} min-h-28`}
          value={form.mission}
          placeholder="You own pipeline and revenue: ideal customer profile, outbound sequences, pricing negotiations…"
          onChange={(e) => set({ mission: e.target.value })}
        />
      </label>

      <div className="mt-4 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block text-muted">Reports to</span>
          <select
            className={inputCls}
            value={form.reportsTo ?? ""}
            onChange={(e) => set({ reportsTo: e.target.value || null })}
          >
            <option value="">You (CEO)</option>
            {agents
              .filter((a) => a.id !== form.id)
              .map((a) => (
                <option key={a.id} value={a.id}>
                  {a.name} · {a.title}
                </option>
              ))}
          </select>
        </label>
        <div className="text-sm">
          <span className="mb-1 block text-muted">Color</span>
          <div className="flex gap-1.5 pt-1">
            {COLORS.map((c) => (
              <button
                key={c}
                onClick={() => set({ color: c })}
                className={`h-7 w-7 rounded-full ${form.color === c ? "ring-2 ring-offset-2 ring-offset-panel" : ""}`}
                style={{ background: c, ["--tw-ring-color" as string]: c }}
                aria-label={`Color ${c}`}
              />
            ))}
          </div>
        </div>
      </div>

      <label className="mt-4 flex items-center gap-2 text-sm">
        <input
          type="checkbox"
          checked={form.tools.includes("web_search")}
          onChange={(e) => set({ tools: e.target.checked ? ["web_search"] : [] })}
        />
        Can search the web (Opus and Sonnet only)
      </label>

      {local && (
        <fieldset className="mt-5 space-y-3 rounded-xl border border-line p-4">
          <legend className="px-1 text-sm font-semibold">Local mode</legend>
          <div className="grid gap-4 sm:grid-cols-2">
            <label className="text-sm">
              <span className="mb-1 block text-muted">Role (what tools they get)</span>
              <select className={inputCls} value={form.local?.role ?? "builder"} onChange={(e) => setLocal({ role: e.target.value })}>
                {local.roles.map((r) => (
                  <option key={r.id} value={r.id} title={r.description}>
                    {r.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="text-sm">
              <span className="mb-1 block text-muted">Working folder</span>
              <input
                className={`${inputCls} font-mono text-xs`}
                value={form.local?.folder ?? ""}
                placeholder={`${local.root ?? "~/AgentStaff"}/${form.id || "agent-id"}`}
                onChange={(e) => setLocal({ folder: e.target.value || undefined })}
              />
            </label>
          </div>
          <p className="text-xs text-muted">{local.roles.find((r) => r.id === (form.local?.role ?? "builder"))?.description}</p>
          <label className="flex items-center gap-2 text-sm">
            <input type="checkbox" checked={!!form.local?.alwaysAsk} onChange={(e) => setLocal({ alwaysAsk: e.target.checked })} />
            Always ask: show me every tool use to approve or deny
          </label>
          <label className="flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={form.local?.verifyAfterChange !== false}
              onChange={(e) => setLocal({ verifyAfterChange: e.target.checked })}
            />
            After changing files, ask the agent to verify its work
          </label>
          {form.id && local.folderErrors[form.id] && <p className="text-xs text-rose-600">{local.folderErrors[form.id]}</p>}
        </fieldset>
      )}

      <div className="mt-6 flex items-center gap-2">
        {!isNew && (
          <button
            className="rounded-lg px-3 py-2 text-sm text-rose-600 hover:bg-rose-50 disabled:opacity-40 dark:hover:bg-rose-950/40"
            disabled={busy}
            title={busy ? "Wait until agents finish working" : undefined}
            onClick={() => {
              if (confirm(`Remove ${agent.name} and their conversations?`)) {
                store.removeAgent(agent.id);
                onClose();
              }
            }}
          >
            Remove agent
          </button>
        )}
        <div className="ml-auto flex gap-2">
          <button className={btnGhost} onClick={onClose}>
            Cancel
          </button>
          <button className={btnPrimary} disabled={!valid} onClick={save}>
            {isNew ? "Hire" : "Save"}
          </button>
        </div>
      </div>
    </Modal>
  );
}
