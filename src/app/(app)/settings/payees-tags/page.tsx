"use client";

/**
 * /settings/payees-tags — clean up payees and tags (2026-11-24).
 *
 * Each tab lists every name with how many transactions use it, groups names
 * that look like duplicates (lib/names/likely-duplicates.ts), and offers
 * merge, rename and remove. Merge and rename change the text on TRANSACTIONS
 * (and split rows, for tags) only, never on bank rows or pending statement
 * files. Store: lib/names/manage.ts.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { PageSkeleton } from "@/components/page-skeleton";
import { ErrorState } from "@/components/error-state";
import { parseSaveError } from "@/lib/save-error";
import { clearPayeeOptionsCache } from "@/lib/hooks/usePayeeOptions";
import { clearTagOptionsCache } from "@/lib/hooks/useTagOptions";
import { Merge, Pencil, Search, StickyNote, Trash2, X } from "lucide-react";

type Kind = "payees" | "tags";

interface Item {
  key: string;
  name: string;
  count: number;
  lastDate: string | null;
  variants?: string[];
  suggestionId?: number | null;
}

interface ListState {
  items: Item[];
  groups: string[][];
  locked: boolean;
}

const KIND = {
  payees: {
    url: "/api/payees/manage",
    listKey: "payees",
    one: "payee",
    many: "payees",
  },
  tags: {
    url: "/api/transactions/tags/manage",
    listKey: "tags",
    one: "tag",
    many: "tags",
  },
} as const;

const HIDDEN_GROUPS_KEY = "pf-names-hidden-groups";

function readHidden(): Set<string> {
  try {
    const raw = localStorage.getItem(HIDDEN_GROUPS_KEY);
    return new Set(raw ? (JSON.parse(raw) as string[]) : []);
  } catch {
    return new Set();
  }
}
function writeHidden(s: Set<string>) {
  try {
    localStorage.setItem(HIDDEN_GROUPS_KEY, JSON.stringify([...s]));
  } catch {
    /* per-browser convenience only */
  }
}

const plural = (n: number, one: string, many: string) => `${n.toLocaleString()} ${n === 1 ? one : many}`;

export default function PayeesTagsPage() {
  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-lg font-semibold">Payees &amp; tags</h2>
        <p className="text-sm text-muted-foreground">
          Merge names that mean the same thing, rename them, move text that is not a payee into the
          note, or remove them. Changes apply to your transactions. What your bank sent (bank
          statement rows) is never changed.
        </p>
      </div>
      <Tabs defaultValue="payees">
        <TabsList>
          <TabsTrigger value="payees">Payees</TabsTrigger>
          <TabsTrigger value="tags">Tags</TabsTrigger>
        </TabsList>
        <TabsContent value="payees" className="mt-4">
          <NamesPanel kind="payees" />
        </TabsContent>
        <TabsContent value="tags" className="mt-4">
          <NamesPanel kind="tags" />
        </TabsContent>
      </Tabs>
    </div>
  );
}

function NamesPanel({ kind }: { kind: Kind }) {
  const cfg = KIND[kind];
  const [state, setState] = useState<ListState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [hidden, setHidden] = useState<Set<string>>(new Set());
  const [merge, setMerge] = useState<{ keys: string[]; title: string } | null>(null);
  const [rename, setRename] = useState<Item | null>(null);
  const [remove, setRemove] = useState<Item | null>(null);
  const [toNote, setToNote] = useState<Item[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoadError(null);
    try {
      const res = await fetch(cfg.url);
      if (!res.ok) throw new Error(await parseSaveError(res, "Could not load the list."));
      const d = (await res.json()).data;
      setState({ items: d[cfg.listKey] ?? [], groups: d.groups ?? [], locked: !!d.locked });
    } catch (e) {
      setLoadError(e instanceof Error ? e.message : "Could not load the list.");
    }
  }, [cfg.url, cfg.listKey]);

  useEffect(() => {
    void load();
    setHidden(readHidden());
  }, [load]);

  const byKey = useMemo(() => new Map((state?.items ?? []).map((i) => [i.key, i])), [state]);
  const groupId = (keys: string[]) => `${kind}:${[...keys].sort().join("|")}`;
  const groups = useMemo(
    () =>
      (state?.groups ?? [])
        .filter((g) => !hidden.has(groupId(g)))
        .map((g) => g.map((k) => byKey.get(k)).filter((x): x is Item => !!x))
        .filter((g) => g.length > 1),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state, hidden, byKey],
  );
  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const items = state?.items ?? [];
    return q ? items.filter((i) => i.name.toLowerCase().includes(q)) : items;
  }, [state, query]);

  const afterChange = async (message: string) => {
    setNotice(message);
    setSelected(new Set());
    if (kind === "payees") clearPayeeOptionsCache();
    else clearTagOptionsCache();
    await load();
  };

  if (loadError) return <ErrorState message={loadError} onRetry={() => void load()} />;
  if (!state) return <PageSkeleton rows={6} />;
  if (state.locked) {
    return (
      <p className="text-sm text-muted-foreground">
        Your {cfg.many} are encrypted and your session is locked. Sign in again to manage them.
      </p>
    );
  }

  const shown = visible.slice(0, 500);
  const toggle = (key: string) =>
    setSelected((s) => {
      const n = new Set(s);
      if (n.has(key)) n.delete(key);
      else n.add(key);
      return n;
    });

  return (
    <div className="space-y-6">
      {notice && (
        <div className="flex items-start justify-between gap-3 rounded-md border border-emerald-200 bg-emerald-50 px-3 py-2 text-sm text-emerald-800 dark:border-emerald-900 dark:bg-emerald-950/40 dark:text-emerald-300">
          <span>{notice}</span>
          <button aria-label="Dismiss" onClick={() => setNotice(null)} className="shrink-0">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Likely duplicates</CardTitle>
          <CardDescription>
            Names that look like the same {cfg.one}: other case or spacing, one starting the other,
            singular and plural, or one typo. Nothing changes until you merge.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          {groups.length === 0 && (
            <p className="text-sm text-muted-foreground">No likely duplicates found.</p>
          )}
          {groups.slice(0, 50).map((g) => (
            <div key={groupId(g.map((i) => i.key))} className="flex flex-wrap items-center gap-2 rounded-md border p-2">
              <div className="flex min-w-0 flex-1 flex-wrap gap-1.5">
                {g.map((i) => (
                  <Badge key={i.key} variant="outline" className="max-w-full gap-1.5 font-normal">
                    <span className="truncate">{i.name}</span>
                    <span className="text-muted-foreground tabular-nums">{i.count}</span>
                  </Badge>
                ))}
              </div>
              <div className="flex shrink-0 gap-1">
                <Button size="sm" onClick={() => setMerge({ keys: g.map((i) => i.key), title: `Merge ${g.length} ${cfg.many}` })}>
                  <Merge className="mr-1 h-3.5 w-3.5" /> Merge
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    const n = new Set(hidden);
                    n.add(groupId(g.map((i) => i.key)));
                    setHidden(n);
                    writeHidden(n);
                  }}
                >
                  Not duplicates
                </Button>
              </div>
            </div>
          ))}
          {groups.length > 50 && (
            <p className="text-xs text-muted-foreground">Showing the 50 largest groups of {groups.length}.</p>
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">All {cfg.many}</CardTitle>
          <CardDescription>
            {plural(state.items.length, cfg.one, cfg.many)}. Tick two or more to merge them yourself.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="flex flex-wrap items-center gap-2">
            <div className="relative min-w-48 flex-1">
              <Search className="absolute left-2 top-2 h-4 w-4 text-muted-foreground" />
              <Input value={query} onChange={(e) => setQuery(e.target.value)} placeholder={`Search ${cfg.many}`} className="pl-8" />
            </div>
            <Button
              size="sm"
              disabled={selected.size < 2}
              onClick={() => setMerge({ keys: [...selected], title: `Merge ${selected.size} ${cfg.many}` })}
            >
              <Merge className="mr-1 h-3.5 w-3.5" /> Merge selected{selected.size ? ` (${selected.size})` : ""}
            </Button>
            {kind === "payees" && (
              <Button
                size="sm"
                variant="outline"
                disabled={selected.size < 1}
                onClick={() => setToNote([...selected].map((k) => byKey.get(k)).filter((x): x is Item => !!x))}
                title="For text that is not a payee, like transfer details"
              >
                <StickyNote className="mr-1 h-3.5 w-3.5" /> Move to note
              </Button>
            )}
          </div>
          <div className="overflow-x-auto rounded-md border">
            <table className="w-full text-sm">
              <thead className="bg-muted/40 text-left text-xs text-muted-foreground">
                <tr>
                  <th className="w-8 px-2 py-2" />
                  <th className="px-2 py-2 font-medium">Name</th>
                  <th className="px-2 py-2 text-right font-medium">Transactions</th>
                  <th className="hidden px-2 py-2 font-medium sm:table-cell">Last used</th>
                  <th className="px-2 py-2" />
                </tr>
              </thead>
              <tbody>
                {shown.map((i) => (
                  <tr key={i.key} className="border-t">
                    <td className="px-2 py-1.5">
                      <input
                        type="checkbox"
                        aria-label={`Select ${i.name}`}
                        checked={selected.has(i.key)}
                        onChange={() => toggle(i.key)}
                      />
                    </td>
                    <td className="min-w-0 px-2 py-1.5">
                      <div className="break-words">{i.name}</div>
                      {(i.variants?.length ?? 0) > 0 && (
                        <div className="text-xs text-muted-foreground">also written {i.variants!.join(", ")}</div>
                      )}
                      {kind === "payees" && i.suggestionId != null && (
                        <Badge variant="outline" className="mt-0.5 text-[10px] font-normal">suggested</Badge>
                      )}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums">{i.count.toLocaleString()}</td>
                    <td className="hidden px-2 py-1.5 text-muted-foreground sm:table-cell">{i.lastDate ?? "-"}</td>
                    <td className="whitespace-nowrap px-2 py-1.5 text-right">
                      <Button size="icon-sm" variant="ghost" aria-label={`Rename ${i.name}`} onClick={() => setRename(i)}>
                        <Pencil className="h-3.5 w-3.5" />
                      </Button>
                      {kind === "payees" && i.count > 0 && (
                        <Button
                          size="icon-sm"
                          variant="ghost"
                          aria-label={`Move ${i.name} to note`}
                          title="Move to note"
                          onClick={() => setToNote([i])}
                        >
                          <StickyNote className="h-3.5 w-3.5" />
                        </Button>
                      )}
                      {(kind === "tags" || i.suggestionId != null) && (
                        <Button size="icon-sm" variant="ghost" aria-label={`Remove ${i.name}`} onClick={() => setRemove(i)}>
                          <Trash2 className="h-3.5 w-3.5" />
                        </Button>
                      )}
                    </td>
                  </tr>
                ))}
                {shown.length === 0 && (
                  <tr>
                    <td colSpan={5} className="px-2 py-6 text-center text-muted-foreground">
                      No {cfg.many} {query ? "match your search" : "yet"}.
                    </td>
                  </tr>
                )}
              </tbody>
            </table>
          </div>
          {visible.length > shown.length && (
            <p className="text-xs text-muted-foreground">Showing 500 of {visible.length}. Search to find others.</p>
          )}
        </CardContent>
      </Card>

      {merge && (
        <MergeDialog
          kind={kind}
          title={merge.title}
          items={merge.keys.map((k) => byKey.get(k)).filter((x): x is Item => !!x)}
          onClose={() => setMerge(null)}
          onDone={afterChange}
        />
      )}
      {rename && (
        <MergeDialog
          kind={kind}
          title={`Rename ${cfg.one}`}
          items={[rename]}
          renameOnly
          existing={state.items}
          onClose={() => setRename(null)}
          onDone={afterChange}
        />
      )}
      <ConfirmDialog
        open={!!toNote}
        onOpenChange={(o) => !o && setToNote(null)}
        title="Move to note"
        description={
          toNote ? (
            <span>
              Move {toNote.length === 1 ? <>&ldquo;{toNote[0].name}&rdquo;</> : plural(toNote.length, "payee", "payees")} into
              the note of {plural(toNote.reduce((n, i) => n + i.count, 0), "transaction", "transactions")}{" "}and leave their
              payee empty. A note they already have is kept after it. Use this for text that is not a payee, like
              &ldquo;Transfer to Savings&rdquo;. Bank statement rows are not changed.
            </span>
          ) : (
            ""
          )
        }
        confirmLabel="Move to note"
        busy={busy}
        busyLabel="Moving…"
        onConfirm={async () => {
          if (!toNote) return;
          setBusy(true);
          try {
            const res = await fetch(cfg.url, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ action: "to_note", sources: toNote.map((i) => i.key) }),
            });
            if (!res.ok) throw new Error(await parseSaveError(res, "Could not move it."));
            const d = (await res.json()).data as { updated: number };
            setToNote(null);
            await afterChange(`Moved the payee into the note on ${plural(d.updated, "transaction", "transactions")}.`);
          } catch (e) {
            setNotice(e instanceof Error ? e.message : "Could not move it.");
          } finally {
            setBusy(false);
          }
        }}
      />
      <ConfirmDialog
        open={!!remove}
        onOpenChange={(o) => !o && setRemove(null)}
        title={kind === "tags" ? "Remove tag" : "Stop suggesting payee"}
        description={
          remove
            ? kind === "tags"
              ? `Remove the tag "${remove.name}" from ${plural(remove.count, "transaction", "transactions")}? The transactions stay; only the tag goes.`
              : `Take "${remove.name}" out of the Payee suggestions? Transactions keep their payee. Using it again adds it back.`
            : ""
        }
        confirmLabel="Remove"
        busy={busy}
        busyLabel="Removing…"
        onConfirm={async () => {
          if (!remove) return;
          setBusy(true);
          try {
            const res =
              kind === "tags"
                ? await fetch(cfg.url, {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ sources: [remove.key], target: null }),
                  })
                : await fetch("/api/payees", {
                    method: "DELETE",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ id: remove.suggestionId }),
                  });
            if (!res.ok) throw new Error(await parseSaveError(res, "Could not remove it."));
            const name = remove.name;
            setRemove(null);
            await afterChange(kind === "tags" ? `Removed the tag "${name}".` : `"${name}" is no longer suggested.`);
          } catch (e) {
            setNotice(e instanceof Error ? e.message : "Could not remove it.");
          } finally {
            setBusy(false);
          }
        }}
      />
    </div>
  );
}

function MergeDialog({
  kind,
  title,
  items,
  renameOnly,
  existing,
  onClose,
  onDone,
}: {
  kind: Kind;
  title: string;
  items: Item[];
  renameOnly?: boolean;
  existing?: Item[];
  onClose: () => void;
  onDone: (message: string) => Promise<void>;
}) {
  const cfg = KIND[kind];
  const ordered = useMemo(() => [...items].sort((a, b) => b.count - a.count), [items]);
  const [included, setIncluded] = useState<Set<string>>(() => new Set(items.map((i) => i.key)));
  const [target, setTarget] = useState(ordered[0]?.name ?? "");
  const [addRules, setAddRules] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");

  const chosen = ordered.filter((i) => included.has(i.key));
  const affected = chosen.reduce((s, i) => s + i.count, 0);
  const trimmed = target.trim();
  // A rename onto a name that already exists folds the two together.
  const clash =
    renameOnly && existing
      ? existing.find((e) => e.key !== items[0]?.key && e.name.toLowerCase() === trimmed.toLowerCase())
      : undefined;
  const canSave = !saving && trimmed !== "" && (renameOnly ? true : chosen.length >= 2) && !(kind === "tags" && trimmed.includes(","));

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      const body =
        kind === "payees"
          ? { action: "merge", sources: chosen.map((i) => i.key), target: trimmed, addImportRules: addRules }
          : { sources: chosen.map((i) => i.key), target: trimmed };
      const res = await fetch(cfg.url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!res.ok) {
        setError(await parseSaveError(res, "Could not save the change."));
        return;
      }
      const d = (await res.json()).data as { updated: number; rulesAdded?: number };
      const rules = d.rulesAdded ? ` Added ${plural(d.rulesAdded, "rule", "rules")} for future imports.` : "";
      onClose();
      await onDone(`Updated ${plural(d.updated, "transaction", "transactions")} to "${trimmed}".${rules}`);
    } catch {
      setError("Could not save the change. Check your connection and try again.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <Dialog open onOpenChange={(o) => !o && !saving && onClose()}>
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>
            Changes the {cfg.one} on your transactions. Bank statement rows keep what the bank sent.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          {!renameOnly && (
            <div className="space-y-1.5">
              <Label>Merge these</Label>
              <div className="max-h-56 space-y-1 overflow-y-auto rounded-md border p-2">
                {ordered.map((i) => (
                  <label key={i.key} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      checked={included.has(i.key)}
                      onChange={() =>
                        setIncluded((s) => {
                          const n = new Set(s);
                          if (n.has(i.key)) n.delete(i.key);
                          else n.add(i.key);
                          return n;
                        })
                      }
                    />
                    <button type="button" className="min-w-0 flex-1 truncate text-left hover:underline" onClick={() => setTarget(i.name)} title="Use this name">
                      {i.name}
                    </button>
                    <span className="text-xs text-muted-foreground tabular-nums">{i.count}</span>
                  </label>
                ))}
              </div>
              <p className="text-xs text-muted-foreground">Click a name to keep it, or type a new one below.</p>
            </div>
          )}
          <div className="space-y-1.5">
            <Label htmlFor="name-target">{renameOnly ? "New name" : "Keep as"}</Label>
            <Input id="name-target" value={target} onChange={(e) => setTarget(e.target.value)} autoFocus={false} />
            {clash && (
              <p className="text-xs text-amber-700 dark:text-amber-400">
                You already have &ldquo;{clash.name}&rdquo;. Renaming will put both under one name.
              </p>
            )}
          </div>
          {kind === "payees" && (
            <label className="flex items-start gap-2 text-sm">
              <input type="checkbox" className="mt-0.5" checked={addRules} onChange={(e) => setAddRules(e.target.checked)} />
              <span>
                Also rename these on future imports
                <span className="block text-xs text-muted-foreground">
                  Adds a rule for each old spelling (Settings → Rules). Rules apply to rows coming from bank feeds and statements.
                </span>
              </span>
            </label>
          )}
          <p className="text-sm">
            {plural(affected, "transaction", "transactions")} will get the {cfg.one} &ldquo;{trimmed || "…"}&rdquo;.
          </p>
          {error && <p className="text-sm text-destructive">{error}</p>}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={saving}>
            Cancel
          </Button>
          <Button onClick={() => void save()} disabled={!canSave}>
            {saving ? "Saving…" : renameOnly ? "Rename" : "Merge"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
