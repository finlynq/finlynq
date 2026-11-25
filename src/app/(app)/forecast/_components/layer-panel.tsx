"use client";

/**
 * The layer stack editor (plan section 5): ordered list with on/off, move,
 * edit, remove, and "Add layer". Edits a full ScenarioConfig; the page
 * re-runs the engine on every change.
 */
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu, DropdownMenuContent, DropdownMenuGroup, DropdownMenuItem, DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { layerSchema, type ForecastLayer, type LayerKind } from "@/lib/forecast/config";
import type { ForecastLineDef } from "@/lib/forecast/types";
import { ArrowDown, ArrowUp, Pencil, Plus, Trash2, Bot } from "lucide-react";

export const KIND_LABEL: Record<LayerKind, string> = {
  budget: "Budget",
  history: "Your history",
  budget_realism: "Budget realism",
  scheduled: "Scheduled payments",
  growth: "Growth / inflation",
  manual: "Manual change",
};

const KIND_HELP: Record<LayerKind, string> = {
  budget: "Your budgets and budget rules. Lines with no budget stay blank.",
  history: "What you actually spent or received per line in recent months.",
  budget_realism: "Scales a line by what you really spent against its budget lately.",
  scheduled: "Subscriptions and recurring payments on their real dates.",
  growth: "Grows amounts by a yearly rate (blank rate = the scenario's inflation).",
  manual: "Your own amount or factor for chosen lines and months.",
};

const OP_LABEL: Record<string, string> = {
  fill: "Fill blanks only",
  set: "Replace",
  add: "Add",
  scale: "Multiply by",
  floor: "At least",
  cap: "At most",
  grow: "Grow",
};

const OPS_FOR: Record<LayerKind, string[]> = {
  budget: ["fill", "set"],
  history: ["fill", "set", "floor"],
  budget_realism: ["scale"],
  scheduled: ["floor", "fill", "add", "set"],
  growth: ["grow"],
  manual: ["set", "add", "scale", "floor", "cap", "fill"],
};

function newLayer(kind: LayerKind): ForecastLayer {
  const id = `${kind}-${Math.random().toString(36).slice(2, 8)}`;
  const base = { id, label: KIND_LABEL[kind], enabled: true, scope: {}, updatedBy: "user" as const };
  const raw =
    kind === "budget" ? { ...base, kind, op: "fill", params: { carryForwardBeyondHorizon: true } }
    : kind === "history" ? { ...base, kind, op: "fill", params: { lookbackMonths: 6, method: "average", seasonal: false } }
    : kind === "budget_realism" ? { ...base, kind, op: "scale", params: { lookbackMonths: 6, minMonths: 2 } }
    : kind === "scheduled" ? { ...base, kind, op: "floor", params: {} }
    : kind === "growth" ? { ...base, kind, op: "grow", scope: { lineTypes: ["expense"] }, params: { ratePct: null, appliesTo: "all" } }
    : { ...base, kind, op: "add", params: { amount: 0 } };
  return layerSchema.parse(raw);
}

function describe(l: ForecastLayer): string {
  const scope = l.scope?.lineKeys?.length
    ? `${l.scope.lineKeys.length} line${l.scope.lineKeys.length === 1 ? "" : "s"}`
    : l.scope?.lineTypes?.length === 1 ? (l.scope.lineTypes[0] === "income" ? "income" : "spending")
    : "all lines";
  const when = l.from || l.to ? `, ${l.from ?? "start"} to ${l.to ?? "end"}` : "";
  let what = OP_LABEL[l.op] ?? l.op;
  if (l.kind === "history") what = `${OP_LABEL[l.op]}: ${l.params.method} of ${l.params.lookbackMonths} months${l.params.seasonal ? ", seasonal" : ""}`;
  if (l.kind === "budget_realism") what = `last ${l.params.lookbackMonths} months`;
  if (l.kind === "growth") what = `${l.params.ratePct == null ? "inflation" : `${l.params.ratePct}%`} a year${l.params.appliesTo === "carried" ? " (carried and history amounts)" : ""}`;
  if (l.kind === "manual") what = `${OP_LABEL[l.op]} ${l.params.amount}`;
  return `${what}, ${scope}${when}`;
}

export function LayerPanel({
  layers,
  lines,
  onChange,
}: {
  layers: ForecastLayer[];
  lines: ForecastLineDef[];
  onChange: (layers: ForecastLayer[]) => void;
}) {
  const [editing, setEditing] = useState<ForecastLayer | null>(null);
  const [isNew, setIsNew] = useState(false);

  const move = (i: number, d: number) => {
    const next = [...layers];
    const j = i + d;
    if (j < 0 || j >= next.length) return;
    [next[i], next[j]] = [next[j], next[i]];
    onChange(next);
  };

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <div><h3 className="text-sm font-semibold">Where amounts come from</h3><p className="text-xs text-muted-foreground">Applied top to bottom: later ones change earlier ones.</p></div>
        <DropdownMenu>
          <DropdownMenuTrigger render={<Button variant="outline" size="sm" className="h-7 text-xs"><Plus className="h-3.5 w-3.5 mr-1" /> Add layer</Button>} />
          <DropdownMenuContent align="end" className="min-w-56">
            <DropdownMenuGroup>
              {(["history", "budget_realism", "scheduled", "growth", "manual", "budget"] as LayerKind[]).map((k) => (
                <DropdownMenuItem key={k} onClick={() => { setEditing(newLayer(k)); setIsNew(true); }}>
                  <div>
                    <div className="text-sm">{KIND_LABEL[k]}</div>
                    <div className="text-xs text-muted-foreground">{KIND_HELP[k]}</div>
                  </div>
                </DropdownMenuItem>
              ))}
            </DropdownMenuGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {layers.length === 0 && <p className="text-sm text-muted-foreground">No layers: every line is blank. Add one.</p>}
      <ol className="space-y-1.5">
        {layers.map((l, i) => (
          <li key={l.id} className={`flex items-start gap-2 rounded-md border px-2.5 py-2 ${l.enabled ? "" : "opacity-60"}`}>
            <input
              type="checkbox"
              className="mt-1"
              aria-label={`Use ${l.label || KIND_LABEL[l.kind]}`}
              checked={l.enabled}
              onChange={(e) => onChange(layers.map((x) => (x.id === l.id ? { ...x, enabled: e.target.checked } : x)))}
            />
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium flex items-center gap-1.5">
                {l.label || KIND_LABEL[l.kind]}
                {l.updatedBy === "assistant" && <Bot className="h-3.5 w-3.5 text-muted-foreground" aria-label="Changed by your assistant" />}
              </p>
              <p className="text-xs text-muted-foreground">{KIND_LABEL[l.kind]}: {describe(l)}</p>
            </div>
            <div className="flex shrink-0">
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Move up" disabled={i === 0} onClick={() => move(i, -1)}><ArrowUp className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Move down" disabled={i === layers.length - 1} onClick={() => move(i, 1)}><ArrowDown className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-7 w-7" aria-label="Edit layer" onClick={() => { setEditing(l); setIsNew(false); }}><Pencil className="h-3.5 w-3.5" /></Button>
              <Button variant="ghost" size="icon" className="h-7 w-7 text-destructive" aria-label="Remove layer" onClick={() => onChange(layers.filter((x) => x.id !== l.id))}><Trash2 className="h-3.5 w-3.5" /></Button>
            </div>
          </li>
        ))}
      </ol>
      {editing && (
        <LayerDialog
          layer={editing}
          lines={lines}
          title={isNew ? `Add ${KIND_LABEL[editing.kind].toLowerCase()} layer` : `Edit ${editing.label || KIND_LABEL[editing.kind]}`}
          onCancel={() => setEditing(null)}
          onSave={(saved) => {
            onChange(isNew ? [...layers, saved] : layers.map((x) => (x.id === saved.id ? saved : x)));
            setEditing(null);
          }}
        />
      )}
    </div>
  );
}

function LayerDialog({
  layer,
  lines,
  title,
  onCancel,
  onSave,
}: {
  layer: ForecastLayer;
  lines: ForecastLineDef[];
  title: string;
  onCancel: () => void;
  onSave: (l: ForecastLayer) => void;
}) {
  // Edited as loose JSON; validated by the layer schema on save.
  const [draft, setDraft] = useState<Record<string, unknown>>(() => JSON.parse(JSON.stringify(layer)));
  const [error, setError] = useState("");
  const params = (draft.params ?? {}) as Record<string, unknown>;
  const scope = (draft.scope ?? {}) as { lineTypes?: string[]; lineKeys?: string[] };
  const setParam = (k: string, v: unknown) => setDraft({ ...draft, params: { ...params, [k]: v } });
  const scopeMode = scope.lineKeys?.length ? "lines" : scope.lineTypes?.length === 1 ? scope.lineTypes[0] : "all";
  const editable = lines.filter((l) => l.type !== "debt");
  const kind = layer.kind;

  const save = () => {
    const cleaned = { ...draft, from: draft.from || undefined, to: draft.to || undefined, updatedBy: "user" };
    const parsed = layerSchema.safeParse(cleaned);
    if (!parsed.success) {
      setError("Check the values: some aren't valid (months as YYYY-MM).");
      return;
    }
    onSave(parsed.data);
  };

  const num = (v: string) => (v.trim() === "" ? null : Number(v));

  return (
    <Dialog open onOpenChange={(o) => { if (!o) onCancel(); }}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader><DialogTitle>{title}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <p className="text-xs text-muted-foreground">{KIND_HELP[kind]}</p>
          <div className="space-y-1">
            <Label className="text-xs" htmlFor="ld-label">Name</Label>
            <Input id="ld-label" className="h-8" value={String(draft.label ?? "")} onChange={(e) => setDraft({ ...draft, label: e.target.value })} />
          </div>
          {OPS_FOR[kind].length > 1 && (
            <div className="space-y-1">
              <Label className="text-xs">How it combines with the layers above</Label>
              <Select value={String(draft.op)} onValueChange={(v) => setDraft({ ...draft, op: v ?? "" })}>
                <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                <SelectContent>{OPS_FOR[kind].map((o) => <SelectItem key={o} value={o}>{OP_LABEL[o]}</SelectItem>)}</SelectContent>
              </Select>
            </div>
          )}
          {kind === "budget" && (
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={params.carryForwardBeyondHorizon !== false} onChange={(e) => setParam("carryForwardBeyondHorizon", e.target.checked)} />
              Carry budgets past the end of your budget months
            </label>
          )}
          {(kind === "history" || kind === "budget_realism") && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs">Months to look back</Label>
                <Select value={String(params.lookbackMonths ?? 6)} onValueChange={(v) => setParam("lookbackMonths", Number(v))}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>{[3, 6, 12, 24].map((n) => <SelectItem key={n} value={String(n)}>{n} months</SelectItem>)}</SelectContent>
                </Select>
              </div>
              {kind === "history" ? (
                <div className="space-y-1">
                  <Label className="text-xs">Use</Label>
                  <Select value={String(params.method ?? "average")} onValueChange={(v) => setParam("method", v)}>
                    <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                    <SelectContent>
                      <SelectItem value="average">Average</SelectItem>
                      <SelectItem value="median">Median (ignores one-offs)</SelectItem>
                    </SelectContent>
                  </Select>
                </div>
              ) : (
                <div className="space-y-1">
                  <Label className="text-xs" htmlFor="ld-min">Budgeted months needed</Label>
                  <Input id="ld-min" type="number" min={1} max={24} className="h-8" value={String(params.minMonths ?? 2)} onChange={(e) => setParam("minMonths", Number(e.target.value))} />
                </div>
              )}
              {kind === "history" && (
                <label className="flex items-center gap-2 text-sm col-span-2">
                  <input type="checkbox" checked={!!params.seasonal} onChange={(e) => setParam("seasonal", e.target.checked)} />
                  Seasonal: use the same month last year (needs 12+ months)
                </label>
              )}
            </div>
          )}
          {kind === "growth" && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1">
                <Label className="text-xs" htmlFor="ld-rate">Rate, % a year (blank = inflation)</Label>
                <Input id="ld-rate" type="number" step="0.1" className="h-8" value={params.ratePct == null ? "" : String(params.ratePct)} onChange={(e) => setParam("ratePct", num(e.target.value))} />
              </div>
              <div className="space-y-1">
                <Label className="text-xs">Grows</Label>
                <Select value={String(params.appliesTo ?? "all")} onValueChange={(v) => setParam("appliesTo", v)}>
                  <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
                  <SelectContent>
                    <SelectItem value="all">Every month, from the layer start</SelectItem>
                    <SelectItem value="carried">Only carried budgets and history amounts</SelectItem>
                  </SelectContent>
                </Select>
              </div>
            </div>
          )}
          {kind === "manual" && (
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ld-amount">{draft.op === "scale" ? "Factor (1.1 = 10% more)" : "Amount per month"}</Label>
              <Input id="ld-amount" type="number" step="any" className="h-8" value={String(params.amount ?? 0)} onChange={(e) => setParam("amount", Number(e.target.value))} />
            </div>
          )}

          <div className="space-y-1">
            <Label className="text-xs">Applies to</Label>
            <Select
              value={scopeMode}
              onValueChange={(v) => setDraft({ ...draft, scope: v === "all" ? {} : v === "lines" ? { lineKeys: scope.lineKeys ?? [] } : { lineTypes: [v] } })}
            >
              <SelectTrigger className="h-8 text-xs"><SelectValue /></SelectTrigger>
              <SelectContent>
                <SelectItem value="all">All lines</SelectItem>
                <SelectItem value="income">Income lines</SelectItem>
                <SelectItem value="expense">Spending lines</SelectItem>
                <SelectItem value="lines">Chosen lines</SelectItem>
              </SelectContent>
            </Select>
            {scopeMode === "lines" && (
              <div className="max-h-40 overflow-y-auto rounded border p-2 space-y-1">
                {editable.map((l) => (
                  <label key={l.key} className="flex items-center gap-2 text-xs">
                    <input
                      type="checkbox"
                      checked={scope.lineKeys?.includes(l.key) ?? false}
                      onChange={(e) => {
                        const cur = new Set(scope.lineKeys ?? []);
                        if (e.target.checked) cur.add(l.key); else cur.delete(l.key);
                        setDraft({ ...draft, scope: { lineKeys: [...cur] } });
                      }}
                    />
                    {l.label} <span className="text-muted-foreground">({l.type === "income" ? "income" : l.group || "spending"})</span>
                  </label>
                ))}
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ld-from">From month (optional)</Label>
              <Input id="ld-from" type="month" className="h-8" value={String(draft.from ?? "")} onChange={(e) => setDraft({ ...draft, from: e.target.value })} />
            </div>
            <div className="space-y-1">
              <Label className="text-xs" htmlFor="ld-to">To month (optional)</Label>
              <Input id="ld-to" type="month" className="h-8" value={String(draft.to ?? "")} onChange={(e) => setDraft({ ...draft, to: e.target.value })} />
            </div>
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onCancel}>Cancel</Button>
          <Button onClick={save}>Save layer</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
