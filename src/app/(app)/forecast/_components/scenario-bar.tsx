"use client";

/**
 * Scenario bar: pick a scenario, save / save as (copy or variant), rename,
 * detach, delete, history (with "put this version back"), freeze a snapshot,
 * manage snapshots, and choose what to compare with.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuSeparator, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { ScenarioConfig } from "@/lib/forecast/config";
import type { ForecastResult } from "@/lib/forecast/types";
import type { Revision, useForecastScenarios } from "./use-forecast-scenarios";
import { Bot, Camera, ChevronDown, History, Save } from "lucide-react";

type Hook = ReturnType<typeof useForecastScenarios>;

export function ScenarioBar({
  hook,
  working,
  dirty,
  result,
  onOpened,
  compareWith,
  onCompareWith,
}: {
  hook: Hook;
  working: ScenarioConfig;
  dirty: boolean;
  result: ForecastResult;
  onOpened: (config: ScenarioConfig) => void;
  compareWith: string;
  onCompareWith: (v: string) => void;
}) {
  const { open, scenarios, snapshots } = hook;
  const [message, setMessage] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const [nameDialog, setNameDialog] = useState<null | "saveAs" | "rename" | "freeze">(null);
  const [nameValue, setNameValue] = useState("");
  const [asVariant, setAsVariant] = useState(true);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [snapshotsOpen, setSnapshotsOpen] = useState(false);
  const [pendingSwitch, setPendingSwitch] = useState<string | null>(null);

  if (!open) return null;
  const isSaved = open.id !== "builtin";
  const nameOf = (id: number) => scenarios.find((s) => s.id === id)?.name ?? `#${id}`;
  const report = (r: { ok?: true; error?: string }, okText: string) =>
    setMessage(r.error ? { tone: "error", text: r.error } : { tone: "ok", text: okText });

  const doOpen = async (v: string) => {
    const id = v === "builtin" ? "builtin" : Number(v);
    const r = await hook.openScenario(id);
    if ("error" in r) setMessage({ tone: "error", text: r.error });
    else {
      onOpened(r.config);
      setMessage(null);
    }
  };

  const pick = (v: string | null) => {
    if (!v) return;
    if (dirty) setPendingSwitch(v);
    else void doOpen(v);
  };

  const submitName = async () => {
    const name = nameValue.trim();
    if (!name) return;
    if (nameDialog === "saveAs") report(await hook.saveAs(name, working, asVariant), `Saved as "${name}".`);
    if (nameDialog === "rename") report(await hook.rename(name), "Renamed.");
    if (nameDialog === "freeze") report(await hook.freeze(name, result, working), `Froze this forecast as "${name}". Pick it under Compare with to compare later.`);
    setNameDialog(null);
  };

  const variantNote =
    isSaved && open.kind === "variant" && open.parent
      ? `Based on ${open.parent.type === "builtin" ? "Baseline" : nameOf(open.parent.id)}: changes to it flow into this one.`
      : null;

  return (
    <div className="space-y-2">
      <div className="flex flex-wrap items-center gap-2">
        <Select value={isSaved ? String(open.id) : "builtin"} onValueChange={pick}>
          <SelectTrigger className="h-8 w-64 text-xs" aria-label="Scenario"><SelectValue /></SelectTrigger>
          <SelectContent>
            <SelectItem value="builtin">Baseline (built in)</SelectItem>
            {scenarios.filter((s) => !s.unreadable).map((s) => (
              <SelectItem key={s.id} value={String(s.id)}>{s.kind === "variant" ? `↳ ${s.name}` : s.name}</SelectItem>
            ))}
          </SelectContent>
        </Select>
        {dirty && <span className="text-xs text-amber-700 dark:text-amber-300">Unsaved changes</span>}
        {isSaved && open.updatedBy === "assistant" && (
          <span className="inline-flex items-center gap-1 text-xs text-muted-foreground"><Bot className="h-3.5 w-3.5" /> Last changed by your assistant</span>
        )}
        <Button size="sm" className="h-8" disabled={!isSaved || !dirty || hook.busy} onClick={async () => report(await hook.save(working), "Saved.")}>
          <Save className="h-3.5 w-3.5 mr-1" /> Save
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => { setNameValue(""); setAsVariant(true); setNameDialog("saveAs"); }}>
          Save as…
        </Button>
        <Button size="sm" variant="outline" className="h-8" onClick={() => { setNameValue(""); setNameDialog("freeze"); }}>
          <Camera className="h-3.5 w-3.5 mr-1" /> Freeze
        </Button>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button size="sm" variant="ghost" className="h-8">More <ChevronDown className="h-3.5 w-3.5 ml-1" /></Button>} />
          <DropdownMenuContent align="end" className="min-w-52">
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!isSaved} onClick={() => { setNameValue(open.name); setNameDialog("rename"); }}>Rename</DropdownMenuItem>
              <DropdownMenuItem disabled={!isSaved} onClick={async () => { setRevisions(await hook.loadRevisions()); setHistoryOpen(true); }}>
                <History className="h-3.5 w-3.5 mr-1.5" /> History
              </DropdownMenuItem>
              <DropdownMenuItem disabled={!isSaved || open.kind !== "variant"} onClick={async () => report(await hook.detach(working), "Detached: it no longer follows its parent.")}>
                Detach from parent
              </DropdownMenuItem>
              <DropdownMenuItem onClick={() => setSnapshotsOpen(true)}>Manage snapshots ({snapshots.length})</DropdownMenuItem>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuGroup>
              <DropdownMenuItem disabled={!isSaved} className="text-destructive" onClick={() => setConfirmDelete(true)}>Delete scenario</DropdownMenuItem>
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
        <div className="flex items-center gap-2 ml-auto">
          <span className="text-xs text-muted-foreground">Compare with</span>
          <Select value={compareWith || "none"} onValueChange={(v) => onCompareWith(!v || v === "none" ? "" : v)}>
            <SelectTrigger className="h-8 w-56 text-xs" aria-label="Compare with"><SelectValue /></SelectTrigger>
            <SelectContent>
              <SelectItem value="none">Nothing</SelectItem>
              {isSaved && <SelectItem value="builtin">Baseline (built in)</SelectItem>}
              {scenarios.filter((s) => !s.unreadable && (!isSaved || s.id !== open.id)).map((s) => (
                <SelectItem key={`s${s.id}`} value={`scenario:${s.id}`}>Scenario: {s.name}</SelectItem>
              ))}
              {snapshots.filter((s) => !s.unreadable).map((s) => (
                <SelectItem key={`n${s.id}`} value={`snapshot:${s.id}`}>Snapshot: {s.name} ({new Date(s.createdAt).toLocaleDateString()})</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </div>
      </div>
      {variantNote && <p className="text-xs text-muted-foreground">{variantNote}</p>}
      {message && (
        <p className={`text-sm ${message.tone === "error" ? "text-destructive" : "text-emerald-700 dark:text-emerald-300"}`}>{message.text}</p>
      )}

      <Dialog open={nameDialog != null} onOpenChange={(o) => { if (!o) setNameDialog(null); }}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>{nameDialog === "saveAs" ? "Save as a new scenario" : nameDialog === "rename" ? "Rename scenario" : "Freeze this forecast"}</DialogTitle>
            {nameDialog === "freeze" && (
              <DialogDescription>Keeps today&apos;s numbers as they are, so you can compare later with an updated forecast or with what actually happened.</DialogDescription>
            )}
          </DialogHeader>
          <div className="space-y-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="sb-name">Name</Label>
              <Input id="sb-name" autoFocus value={nameValue} onChange={(e) => setNameValue(e.target.value)} onKeyDown={(e) => { if (e.key === "Enter") void submitName(); }} />
            </div>
            {nameDialog === "saveAs" && (
              <div className="space-y-1.5 text-sm">
                <label className="flex items-start gap-2">
                  <input type="radio" className="mt-1" checked={asVariant} onChange={() => setAsVariant(true)} />
                  <span><span className="font-medium">A variant of {open.name}</span>: stores only your changes, so later changes to {open.name} flow into it.</span>
                </label>
                <label className="flex items-start gap-2">
                  <input type="radio" className="mt-1" checked={!asVariant} onChange={() => setAsVariant(false)} />
                  <span><span className="font-medium">A full copy</span>: stands on its own.</span>
                </label>
              </div>
            )}
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setNameDialog(null)}>Cancel</Button>
            <Button onClick={submitName} disabled={!nameValue.trim() || hook.busy}>{nameDialog === "freeze" ? "Freeze" : "Save"}</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <Dialog open={historyOpen} onOpenChange={setHistoryOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>History of {open.name}</DialogTitle></DialogHeader>
          <ol className="space-y-1.5 max-h-80 overflow-y-auto">
            {revisions.map((r) => (
              <li key={r.version} className="flex items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-sm">
                <div className="min-w-0">
                  <p className="font-medium">Version {r.version}{r.updatedBy === "assistant" ? " · by your assistant" : ""}</p>
                  <p className="text-xs text-muted-foreground">{r.summary ?? "Saved"} · {new Date(r.createdAt).toLocaleString()}</p>
                </div>
                {isSaved && r.version !== open.version && (
                  <Button size="sm" variant="outline" className="h-7 text-xs" onClick={async () => {
                    const res = await hook.revert(r.version);
                    if ("config" in res && res.config) onOpened(res.config);
                    report(res, `Put version ${r.version} back.`);
                    setHistoryOpen(false);
                  }}>Put back</Button>
                )}
              </li>
            ))}
          </ol>
        </DialogContent>
      </Dialog>

      <Dialog open={snapshotsOpen} onOpenChange={setSnapshotsOpen}>
        <DialogContent className="sm:max-w-lg">
          <DialogHeader><DialogTitle>Snapshots</DialogTitle><DialogDescription>Frozen forecasts. Pick one under Compare with.</DialogDescription></DialogHeader>
          {snapshots.length === 0 ? <p className="text-sm text-muted-foreground">None yet. Use Freeze to keep one.</p> : (
            <ol className="space-y-1.5 max-h-80 overflow-y-auto">
              {snapshots.map((s) => (
                <li key={s.id} className="flex items-center justify-between gap-2 rounded border px-2.5 py-1.5 text-sm">
                  <div className="min-w-0">
                    <p className="font-medium">{s.unreadable ? "(can't be read with your key)" : s.name}</p>
                    <p className="text-xs text-muted-foreground">Data of {new Date(s.inputsAsOf).toLocaleDateString()}{s.months ? ` · ${s.months} months` : ""}{s.currency ? ` · ${s.currency}` : ""}</p>
                  </div>
                  <Button size="sm" variant="ghost" className="h-7 text-xs text-destructive" onClick={async () => {
                    const r = await hook.deleteSnapshot(s.id);
                    if (compareWith === `snapshot:${s.id}`) onCompareWith("");
                    report(r, "Snapshot deleted.");
                  }}>Delete</Button>
                </li>
              ))}
            </ol>
          )}
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={confirmDelete}
        onOpenChange={setConfirmDelete}
        title={`Delete ${open.name}?`}
        description="The scenario and its history are deleted. Snapshots made from it are kept."
        confirmLabel="Delete"
        onConfirm={async () => {
          report(await hook.remove(), "Scenario deleted.");
          setConfirmDelete(false);
          const r = await hook.openScenario("builtin");
          if ("config" in r) onOpened(r.config);
        }}
      />
      <ConfirmDialog
        open={pendingSwitch != null}
        onOpenChange={(o) => { if (!o) setPendingSwitch(null); }}
        title="Discard unsaved changes?"
        description="Your changes to this scenario aren't saved. Switching discards them."
        confirmLabel="Discard and switch"
        onConfirm={async () => {
          const v = pendingSwitch;
          setPendingSwitch(null);
          if (v) await doOpen(v);
        }}
      />
    </div>
  );
}
