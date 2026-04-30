"use client";

/**
 * /settings/dropdown-order — manage per-user pinning order for the four
 * Combobox dropdowns (category, account, holding, currency).
 *
 * Backed by the existing `/api/settings/dropdown-order` endpoint
 * introduced in issue #21 (Section B). The endpoint stores the entire
 * `{ version: 1, lists: { category, account, holding, currency } }`
 * shape on every PUT, so this page reads-then-writes the union.
 *
 * Reorder UX is dependency-free: native HTML5 drag-and-drop on the row
 * grip, plus up/down arrow buttons for keyboard + touch parity. No new
 * package dependency just for ordering — that lines up with the Section
 * B comment ("Add a Section G page that consumes this provider").
 *
 * Items not yet in the saved order appear in a separate "Unpinned"
 * section in alphabetical order; clicking "Pin" appends them to the end
 * of the pinned list.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { ArrowLeft, GripVertical, ArrowUp, ArrowDown, X, RefreshCw, Save, RotateCcw } from "lucide-react";
import {
  EMPTY_DROPDOWN_ORDER,
  parseDropdownOrder,
  type DropdownKind,
  type DropdownOrder,
  type DropdownOrderEntry,
} from "@/lib/dropdown-order";
import { SUPPORTED_FIAT_CURRENCIES, currencyLabel } from "@/lib/fx/supported-currencies";

type Item = { key: DropdownOrderEntry; label: string; subLabel?: string };

const KIND_OPTIONS: ReadonlyArray<{ value: DropdownKind; label: string; description: string }> = [
  { value: "category", label: "Category", description: "Used in transaction + budget pickers." },
  { value: "account", label: "Account", description: "Used in transaction + transfer pickers." },
  { value: "holding", label: "Holding", description: "Used in the Add Transaction holding picker." },
  { value: "currency", label: "Currency", description: "Used in transaction + account currency pickers." },
];

const KIND_LABELS: Record<DropdownKind, string> = Object.fromEntries(
  KIND_OPTIONS.map((o) => [o.value, o.label]),
) as Record<DropdownKind, string>;

export default function DropdownOrderPage() {
  const [kind, setKind] = useState<DropdownKind>("category");
  const [order, setOrder] = useState<DropdownOrder>(EMPTY_DROPDOWN_ORDER);
  const [items, setItems] = useState<Item[]>([]);
  const [pinned, setPinned] = useState<DropdownOrderEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const fetchOrder = useCallback(async () => {
    try {
      const res = await fetch("/api/settings/dropdown-order");
      if (!res.ok) return EMPTY_DROPDOWN_ORDER;
      const data = await res.json();
      const parsed = parseDropdownOrder(data);
      return parsed ?? EMPTY_DROPDOWN_ORDER;
    } catch {
      return EMPTY_DROPDOWN_ORDER;
    }
  }, []);

  const fetchItems = useCallback(async (k: DropdownKind): Promise<Item[]> => {
    if (k === "category") {
      const res = await fetch("/api/categories");
      if (!res.ok) throw new Error("Failed to load categories");
      const rows: Array<{ id: number; name: string; group: string; type: string }> = await res.json();
      return rows.map((c) => ({
        key: c.id,
        label: c.name,
        subLabel: c.group ? `${c.group} · ${c.type}` : c.type,
      }));
    }
    if (k === "account") {
      const res = await fetch("/api/accounts?includeArchived=1");
      if (!res.ok) throw new Error("Failed to load accounts");
      const rows: Array<{ id: number; name: string; type: string; currency: string; archived?: boolean }> = await res.json();
      return rows.map((a) => ({
        key: a.id,
        label: a.name + (a.archived ? " (archived)" : ""),
        subLabel: `${a.type} · ${a.currency}`,
      }));
    }
    if (k === "holding") {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error("Failed to load holdings");
      const rows: Array<{ id: number; name: string; symbol: string | null; currency: string; accountName?: string }> = await res.json();
      return rows.map((h) => ({
        key: h.id,
        label: h.symbol?.trim() ? `${h.symbol} — ${h.name}` : h.name,
        subLabel: h.accountName ? `${h.accountName} · ${h.currency}` : h.currency,
      }));
    }
    // currency: union of supported fiat + active currencies (so XAU,
    // user-defined ISO codes etc. show up).
    const res = await fetch("/api/settings/active-currencies");
    let active: string[] = [];
    if (res.ok) {
      const data: { active?: string[] } = await res.json();
      if (Array.isArray(data.active)) active = data.active;
    }
    const all = Array.from(new Set([...SUPPORTED_FIAT_CURRENCIES, ...active])).sort();
    return all.map((code) => ({
      key: code.toUpperCase(),
      label: code.toUpperCase(),
      subLabel: currencyLabel(code) ?? undefined,
    }));
  }, []);

  const reload = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [ord, list] = await Promise.all([fetchOrder(), fetchItems(kind)]);
      setOrder(ord);
      setItems(list);
      setPinned([...(ord.lists[kind] ?? [])]);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, [kind, fetchOrder, fetchItems]);

  useEffect(() => {
    reload();
  }, [reload]);

  const itemMap = useMemo(() => {
    const m = new Map<string, Item>();
    for (const i of items) m.set(String(i.key), i);
    return m;
  }, [items]);

  const pinnedItems: Item[] = useMemo(() => {
    return pinned
      .map((k) => itemMap.get(String(k)))
      .filter((x): x is Item => Boolean(x));
  }, [pinned, itemMap]);

  const unpinnedItems: Item[] = useMemo(() => {
    const pinnedSet = new Set(pinned.map(String));
    return items
      .filter((i) => !pinnedSet.has(String(i.key)))
      .sort((a, z) => a.label.localeCompare(z.label));
  }, [items, pinned]);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 3500);
  }

  function move(idx: number, dir: -1 | 1) {
    const target = idx + dir;
    if (target < 0 || target >= pinned.length) return;
    const next = [...pinned];
    [next[idx], next[target]] = [next[target], next[idx]];
    setPinned(next);
  }

  function unpin(key: DropdownOrderEntry) {
    setPinned(pinned.filter((k) => String(k) !== String(key)));
  }

  function pin(key: DropdownOrderEntry) {
    if (pinned.some((k) => String(k) === String(key))) return;
    setPinned([...pinned, key]);
  }

  function resetCurrent() {
    setPinned([]);
  }

  // HTML5 drag-and-drop reorder. We track the dragged index in component
  // state because dataTransfer is awkward to round-trip type-safely and
  // we only support dragging within this list.
  const [dragIdx, setDragIdx] = useState<number | null>(null);

  function onDragStart(idx: number, e: React.DragEvent<HTMLDivElement>) {
    setDragIdx(idx);
    e.dataTransfer.effectAllowed = "move";
    // Required for Firefox to actually fire the drag.
    e.dataTransfer.setData("text/plain", String(idx));
  }

  function onDragOver(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
  }

  function onDrop(toIdx: number, e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault();
    if (dragIdx === null || dragIdx === toIdx) return;
    const next = [...pinned];
    const [moved] = next.splice(dragIdx, 1);
    next.splice(toIdx, 0, moved);
    setPinned(next);
    setDragIdx(null);
  }

  async function save() {
    setSaving(true);
    try {
      const nextOrder: DropdownOrder = {
        version: 1,
        lists: { ...order.lists, [kind]: pinned },
      };
      const res = await fetch("/api/settings/dropdown-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(nextOrder),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to save");
      }
      const data = await res.json();
      const parsed = parseDropdownOrder(data) ?? nextOrder;
      setOrder(parsed);
      showToast("success", `${KIND_LABELS[kind]} order saved`);
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Save failed");
    } finally {
      setSaving(false);
    }
  }

  const dirty = useMemo(() => {
    const saved = order.lists[kind] ?? [];
    if (saved.length !== pinned.length) return true;
    for (let i = 0; i < saved.length; i += 1) {
      if (String(saved[i]) !== String(pinned[i])) return true;
    }
    return false;
  }, [pinned, order, kind]);

  return (
    <div className="max-w-3xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/settings" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Settings
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Dropdown Ordering</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Pin frequently-used items to the top of each Combobox. The
            rest fall back to alphabetical order. New items added later
            appear unpinned automatically.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={reload} disabled={loading || saving}>
          <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
          Refresh
        </Button>
      </div>

      {toast && (
        <Card className={toast.type === "success" ? "border-emerald-200 bg-emerald-50/30" : "border-rose-200 bg-rose-50/30"}>
          <CardContent className="py-3 text-sm">{toast.msg}</CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Which dropdown</CardTitle>
          <CardDescription>{KIND_OPTIONS.find((o) => o.value === kind)?.description}</CardDescription>
        </CardHeader>
        <CardContent>
          <Select value={kind} onValueChange={(v) => setKind(((v ?? "category") as DropdownKind))}>
            <SelectTrigger className="w-64"><SelectValue /></SelectTrigger>
            <SelectContent>
              {KIND_OPTIONS.map((o) => (
                <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>
              ))}
            </SelectContent>
          </Select>
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-start justify-between gap-3">
            <div>
              <CardTitle className="text-base">Pinned</CardTitle>
              <CardDescription>
                {pinnedItems.length === 0
                  ? "Nothing pinned. Items below will fall back to alphabetical order."
                  : `Drag the grip handle, or use the arrow buttons, to reorder.`}
              </CardDescription>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={resetCurrent} disabled={pinnedItems.length === 0 || saving}>
                <RotateCcw className="h-3.5 w-3.5 mr-1" />
                Clear pins
              </Button>
              <Button size="sm" onClick={save} disabled={!dirty || saving}>
                <Save className="h-3.5 w-3.5 mr-1" />
                {saving ? "Saving…" : "Save"}
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          {loading && pinnedItems.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">Loading…</p>
          )}
          {!loading && pinnedItems.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              No pinned items yet. Pin one from the list below.
            </p>
          )}
          {pinnedItems.length > 0 && (
            <div className="space-y-1">
              {pinnedItems.map((item, idx) => (
                <div
                  key={String(item.key)}
                  draggable
                  onDragStart={(e) => onDragStart(idx, e)}
                  onDragOver={onDragOver}
                  onDrop={(e) => onDrop(idx, e)}
                  className="flex items-center gap-2 border rounded-md px-2 py-1.5 bg-muted/20 hover:bg-muted/40 transition-colors"
                >
                  <GripVertical className="h-4 w-4 text-muted-foreground cursor-grab shrink-0" />
                  <Badge variant="outline" className="font-mono text-[10px] shrink-0">
                    {idx + 1}
                  </Badge>
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{item.label}</div>
                    {item.subLabel && (
                      <div className="text-[11px] text-muted-foreground truncate">{item.subLabel}</div>
                    )}
                  </div>
                  <div className="flex gap-0.5 shrink-0">
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => move(idx, -1)} disabled={idx === 0} title="Move up">
                      <ArrowUp className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => move(idx, 1)} disabled={idx === pinnedItems.length - 1} title="Move down">
                      <ArrowDown className="h-3.5 w-3.5" />
                    </Button>
                    <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => unpin(item.key)} title="Unpin">
                      <X className="h-3.5 w-3.5" />
                    </Button>
                  </div>
                </div>
              ))}
            </div>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Unpinned ({unpinnedItems.length})</CardTitle>
          <CardDescription>Click an item to pin it to the bottom of the list above.</CardDescription>
        </CardHeader>
        <CardContent>
          {!loading && unpinnedItems.length === 0 && (
            <p className="text-sm text-muted-foreground text-center py-4">
              All items are already pinned.
            </p>
          )}
          {unpinnedItems.length > 0 && (
            <div className="space-y-1 max-h-[480px] overflow-auto">
              {unpinnedItems.map((item) => (
                <button
                  key={String(item.key)}
                  type="button"
                  onClick={() => pin(item.key)}
                  className="w-full flex items-center gap-2 border rounded-md px-2 py-1.5 text-left hover:bg-muted/30 transition-colors"
                >
                  <div className="min-w-0 flex-1">
                    <div className="text-sm font-medium truncate">{item.label}</div>
                    {item.subLabel && (
                      <div className="text-[11px] text-muted-foreground truncate">{item.subLabel}</div>
                    )}
                  </div>
                  <span className="text-[11px] text-muted-foreground shrink-0">Pin</span>
                </button>
              ))}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
