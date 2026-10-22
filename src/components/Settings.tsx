"use client";

import { useState } from "react";
import { stopDemo } from "@/lib/demo";
import { MODEL_LABELS } from "@/lib/engine";
import { resetLocalSessions } from "@/lib/local/client";
import * as store from "@/lib/store";
import { useWorkspace } from "@/lib/store";
import { TEMPLATES, cloneOrg } from "@/lib/templates";
import type { CostMode, Effort, ModelId } from "@/lib/types";
import { Modal, btnGhost, btnPrimary, inputCls } from "./ui";

const MODES: { id: Exclude<CostMode, "custom">; label: string; blurb: string }[] = [
  { id: "economy", label: "Economy", blurb: "Haiku 5.5 · low effort · no web. Cents per request." },
  { id: "balanced", label: "Balanced", blurb: "Sonnet 5.5 · web search · $0.75 cap. Recommended." },
  { id: "best", label: "Best", blurb: "Opus 5.5 · deepest answers · $2 cap." },
];

export function Settings({ onClose, reason }: { onClose: () => void; reason?: string }) {
  const s = useWorkspace((x) => x);
  const [key, setKey] = useState(s.settings.apiKey);
  const [template, setTemplate] = useState(TEMPLATES[0].id);
  const busy = Object.values(s.threads).some((t) => t.busy);

  const startWorkspace = () => {
    stopDemo();
    const org = cloneOrg(TEMPLATES.find((t) => t.id === template) ?? TEMPLATES[0]);
    store.replaceWorkspace(store.freshWorkspace(org, { ...s.settings, apiKey: key.trim() }));
    if (s.local) resetLocalSessions(); // a new team starts with fresh agent sessions
    onClose();
  };

  const exportJson = () => {
    const { settings, ...rest } = s;
    void settings; // never export the API key
    const blob = new Blob([JSON.stringify(rest, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `agentstaff-workspace-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <Modal title="Settings" onClose={onClose} wide>
      {reason && <p className="mb-4 rounded-lg bg-accent-soft px-3 py-2 text-sm">{reason}</p>}

      {s.local ? (
        <section className="space-y-1 text-sm">
          <h3 className="font-semibold">Local mode</h3>
          <p className="text-xs text-muted">
            Each agent runs as its own Claude Agent SDK session on this machine, in its own folder under{" "}
            <span className="font-mono">{s.local.root ?? "~/AgentStaff"}</span>. Credentials:{" "}
            {s.local.auth?.detail ?? "checking…"}. The key never reaches this page. Model, effort and the budget per
            request below apply here too.
          </p>
        </section>
      ) : (
      <section className="space-y-2">
        <h3 className="text-sm font-semibold">Anthropic API key</h3>
        <div className="flex gap-2">
          <input
            type="password"
            className={inputCls}
            value={key}
            placeholder="sk-ant-…"
            autoComplete="off"
            onChange={(e) => setKey(e.target.value)}
            aria-label="Anthropic API key"
          />
          <button className={btnPrimary} disabled={key.trim() === s.settings.apiKey} onClick={() => store.updateSettings({ apiKey: key.trim() })}>
            Save
          </button>
        </div>
        <p className="text-xs text-muted">
          Get one at{" "}
          <a className="text-accent underline" href="https://platform.claude.com/settings/keys" target="_blank" rel="noopener noreferrer">
            platform.claude.com
          </a>
          . Your key is stored only in this browser and sent only to Anthropic. AgentStaff has no server. You pay
          Anthropic directly for what you use; the sidebar shows an estimate.
        </p>
      </section>
      )}

      <section className="mt-6">
        <h3 className="mb-2 text-sm font-semibold">Cost mode</h3>
        <div className="grid gap-2 sm:grid-cols-3">
          {MODES.map((m) => (
            <button
              key={m.id}
              onClick={() => store.updateSettings({ mode: m.id, ...store.COST_MODES[m.id] })}
              className={`rounded-xl border p-3 text-left ${
                s.settings.mode === m.id ? "border-accent bg-accent-soft ring-2 ring-accent/20" : "border-line hover:border-accent"
              }`}
              aria-pressed={s.settings.mode === m.id}
            >
              <div className="text-sm font-semibold">{m.label}</div>
              <div className="text-xs text-muted">{m.blurb}</div>
            </button>
          ))}
        </div>
        {s.settings.mode === "custom" && <p className="mt-2 text-xs text-muted">Custom settings below.</p>}
      </section>

      <section className="mt-5 grid gap-4 sm:grid-cols-2">
        <label className="text-sm">
          <span className="mb-1 block font-semibold">Model</span>
          <select className={inputCls} value={s.settings.model} onChange={(e) => store.updateSettings({ mode: "custom", model: e.target.value as ModelId })}>
            {(Object.keys(MODEL_LABELS) as ModelId[]).map((m) => (
              <option key={m} value={m}>
                {MODEL_LABELS[m]}
              </option>
            ))}
          </select>
        </label>
        <label className="text-sm">
          <span className="mb-1 block font-semibold">Thinking effort</span>
          <select className={inputCls} value={s.settings.effort} onChange={(e) => store.updateSettings({ mode: "custom", effort: e.target.value as Effort })}>
            <option value="low">Low · fastest replies</option>
            <option value="medium">Medium · balanced</option>
            <option value="high">High · deepest work</option>
          </select>
        </label>
      </section>
      <label className="mt-3 flex items-center gap-2 text-sm">
        <input type="checkbox" checked={s.settings.allowWebSearch} onChange={(e) => store.updateSettings({ mode: "custom", allowWebSearch: e.target.checked })} />
        Let agents with web access search the web (about $0.01 per search)
      </label>
      <label className="mt-3 flex flex-wrap items-center gap-2 text-sm">
        Stop any single request once it costs more than $
        <input
          type="number"
          min={0.1}
          step={0.25}
          className={`${inputCls} !w-24`}
          value={s.settings.maxCostPerRequest}
          onChange={(e) => {
            const v = parseFloat(e.target.value);
            if (Number.isFinite(v) && v > 0) store.updateSettings({ mode: "custom", maxCostPerRequest: v });
          }}
          aria-label="Budget per request in dollars"
        />
        <span className="w-full text-xs text-muted">
          Covers everything the request sets off, including agents delegating to each other.
        </span>
      </label>

      <section className="mt-6 space-y-2 border-t border-line pt-5">
        <h3 className="text-sm font-semibold">{s.demo ? "Start your own workspace" : "Workspace"}</h3>
        <p className="text-xs text-muted">
          {s.demo
            ? "Pick a team to start with. You can hire, edit and remove agents any time."
            : "Starting a new workspace replaces the current team, conversations and task board."}
        </p>
        <div className="flex flex-wrap gap-2">
          <select className={`${inputCls} sm:w-72`} value={template} onChange={(e) => setTemplate(e.target.value)} aria-label="Team template">
            {TEMPLATES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
              </option>
            ))}
          </select>
          <button
            className={s.demo ? btnPrimary : btnGhost}
            disabled={busy || (s.demo && !key.trim())}
            title={s.demo && !key.trim() ? "Add your API key first" : undefined}
            onClick={() => {
              if (s.demo || confirm("Replace this workspace? Conversations and tasks will be deleted.")) startWorkspace();
            }}
          >
            {s.demo ? "Start workspace" : "Start new workspace"}
          </button>
        </div>
        <p className="text-xs text-muted">{TEMPLATES.find((t) => t.id === template)?.description}</p>
        {!s.demo && (
          <button className="mt-2 text-xs text-accent underline" onClick={exportJson}>
            Export workspace as JSON
          </button>
        )}
      </section>
    </Modal>
  );
}
