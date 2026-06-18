"use client";

/**
 * ManageGroupsDialog — rename / reorder / merge-into-Other account groups
 * (FINLYNQ-179).
 *
 * Groups are scoped per account type (A=Asset, L=Liability). The dialog reads
 * the live set of groups from the accounts already loaded by the parent page,
 * and the saved display order from /api/settings/account-group-order.
 *
 *  - Rename  → owner-scoped bulk UPDATE via PATCH /api/accounts/groups
 *  - Merge   → same PATCH with to:"Other" (gated behind the shared ConfirmDialog)
 *  - Reorder → up/down buttons persisted via PUT /api/settings/account-group-order
 *
 * "Other" is the catch-all bucket and is not itself renamable/mergeable/movable.
 */

import { useEffect, useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { ConfirmDialog } from "@/components/ui/confirm-dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  OTHER_GROUP,
  orderGroups,
  parseGroupOrder,
  type AccountGroupOrder,
  type AccountGroupType,
} from "@/lib/accounts/groups";
import { ArrowDown, ArrowUp, Check, Pencil, Merge, X } from "lucide-react";

const TYPE_LABELS: Record<AccountGroupType, string> = {
  A: "Asset groups",
  L: "Liability groups",
};

export function ManageGroupsDialog({
  open,
  onOpenChange,
  /** Map of account type → the group names currently in use for that type. */
  groupsByType,
  onChanged,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  groupsByType: Record<AccountGroupType, string[]>;
  onChanged: () => void;
}) {
  const [savedOrder, setSavedOrder] = useState<AccountGroupOrder>({ A: [], L: [] });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  // Inline rename state
  const [editing, setEditing] = useState<{ type: AccountGroupType; name: string } | null>(null);
  const [editValue, setEditValue] = useState("");

  // Merge-into-Other confirm
  const [mergeTarget, setMergeTarget] = useState<{ type: AccountGroupType; name: string } | null>(null);

  useEffect(() => {
    if (!open) return;
    setError("");
    fetch("/api/settings/account-group-order")
      .then((r) => (r.ok ? r.json() : null))
      .then((d) => {
        if (d?.order) setSavedOrder(parseGroupOrder(JSON.stringify(d.order)));
      })
      .catch(() => {});
  }, [open]);

  const ordered = useMemo(() => {
    const forType = (t: AccountGroupType) =>
      orderGroups(groupsByType[t] ?? [], savedOrder[t] ?? []);
    return { A: forType("A"), L: forType("L") };
  }, [groupsByType, savedOrder]);

  async function persistOrder(next: AccountGroupOrder) {
    setSavedOrder(next);
    try {
      await fetch("/api/settings/account-group-order", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ order: next }),
      });
    } catch {
      // Non-fatal — local order already applied; surface a soft error.
      setError("Couldn't save the new order — it may not persist on reload.");
    }
  }

  // Move a group up/down within its type. We persist the FULL ordered list for
  // that type (excluding "Other", which is always sunk last) so the saved order
  // is self-describing even for groups that didn't have an explicit rank.
  function move(type: AccountGroupType, name: string, dir: -1 | 1) {
    const list = ordered[type].filter((g) => g.toLowerCase() !== OTHER_GROUP.toLowerCase());
    const i = list.findIndex((g) => g.toLowerCase() === name.toLowerCase());
    const j = i + dir;
    if (i < 0 || j < 0 || j >= list.length) return;
    [list[i], list[j]] = [list[j], list[i]];
    void persistOrder({ ...savedOrder, [type]: list });
  }

  async function renameGroup(type: AccountGroupType, from: string, to: string) {
    const target = to.trim();
    if (!target || target.toLowerCase() === from.toLowerCase()) {
      setEditing(null);
      return;
    }
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/accounts/groups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from, to: target, type }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Failed to rename group");
        return;
      }
      // Carry the saved order entry over to the new name so order survives.
      const list = (savedOrder[type] ?? []).map((g) =>
        g.toLowerCase() === from.toLowerCase() ? target : g,
      );
      await persistOrder({ ...savedOrder, [type]: list });
      setEditing(null);
      onChanged();
    } catch {
      setError("Failed to rename group");
    } finally {
      setBusy(false);
    }
  }

  async function mergeIntoOther(type: AccountGroupType, name: string) {
    setBusy(true);
    setError("");
    try {
      const res = await fetch("/api/accounts/groups", {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ from: name, to: OTHER_GROUP, type }),
      });
      if (!res.ok) {
        const data = await res.json().catch(() => ({}));
        setError(data?.error ?? "Failed to merge group");
        return;
      }
      const list = (savedOrder[type] ?? []).filter(
        (g) => g.toLowerCase() !== name.toLowerCase(),
      );
      await persistOrder({ ...savedOrder, [type]: list });
      setMergeTarget(null);
      onChanged();
    } catch {
      setError("Failed to merge group");
    } finally {
      setBusy(false);
    }
  }

  function renderType(type: AccountGroupType) {
    const list = ordered[type];
    const movable = list.filter((g) => g.toLowerCase() !== OTHER_GROUP.toLowerCase());
    return (
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          {TYPE_LABELS[type]}
        </Label>
        {list.length === 0 ? (
          <p className="text-sm text-muted-foreground">No groups in use yet.</p>
        ) : (
          <div className="space-y-1">
            {list.map((g) => {
              const isOther = g.toLowerCase() === OTHER_GROUP.toLowerCase();
              const isEditing = editing?.type === type && editing?.name === g;
              const movableIndex = movable.findIndex(
                (m) => m.toLowerCase() === g.toLowerCase(),
              );
              return (
                <div
                  key={g}
                  className="flex items-center gap-2 rounded-lg border border-input px-2 py-1.5"
                >
                  {isEditing ? (
                    <>
                      <Input
                        value={editValue}
                        onChange={(e) => setEditValue(e.target.value)}
                        className="h-7 flex-1"
                        autoFocus
                        onKeyDown={(e) => {
                          if (e.key === "Enter") {
                            e.preventDefault();
                            void renameGroup(type, g, editValue);
                          } else if (e.key === "Escape") {
                            setEditing(null);
                          }
                        }}
                      />
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        disabled={busy}
                        title="Save"
                        aria-label="Save group name"
                        onClick={() => void renameGroup(type, g, editValue)}
                      >
                        <Check className="h-3.5 w-3.5" />
                      </Button>
                      <Button
                        type="button"
                        size="icon"
                        variant="ghost"
                        className="h-7 w-7"
                        title="Cancel"
                        aria-label="Cancel rename"
                        onClick={() => setEditing(null)}
                      >
                        <X className="h-3.5 w-3.5" />
                      </Button>
                    </>
                  ) : (
                    <>
                      <span className="flex-1 truncate text-sm">{g}</span>
                      {!isOther && (
                        <>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy || movableIndex <= 0}
                            title="Move up"
                            aria-label={`Move ${g} up`}
                            onClick={() => move(type, g, -1)}
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy || movableIndex < 0 || movableIndex >= movable.length - 1}
                            title="Move down"
                            aria-label={`Move ${g} down`}
                            onClick={() => move(type, g, 1)}
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7"
                            disabled={busy}
                            title="Rename group"
                            aria-label={`Rename ${g}`}
                            onClick={() => {
                              setEditing({ type, name: g });
                              setEditValue(g);
                            }}
                          >
                            <Pencil className="h-3.5 w-3.5" />
                          </Button>
                          <Button
                            type="button"
                            size="icon"
                            variant="ghost"
                            className="h-7 w-7 text-muted-foreground hover:text-destructive"
                            disabled={busy}
                            title="Merge into Other"
                            aria-label={`Merge ${g} into Other`}
                            onClick={() => setMergeTarget({ type, name: g })}
                          >
                            <Merge className="h-3.5 w-3.5" />
                          </Button>
                        </>
                      )}
                    </>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </div>
    );
  }

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="sm:max-w-md">
          <DialogHeader>
            <DialogTitle>Manage account groups</DialogTitle>
          </DialogHeader>
          <p className="text-sm text-muted-foreground">
            Rename a group across all its accounts, reorder how groups appear, or
            merge a group into &quot;Other&quot;. Groups are kept separate for assets
            and liabilities.
          </p>
          <div className="space-y-4">
            {renderType("A")}
            {renderType("L")}
          </div>
          {error && <p className="text-sm text-destructive">{error}</p>}
          <div className="flex justify-end pt-1">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          </div>
        </DialogContent>
      </Dialog>

      <ConfirmDialog
        open={mergeTarget !== null}
        onOpenChange={(o) => {
          if (!o) setMergeTarget(null);
        }}
        title="Merge into Other"
        description={
          mergeTarget
            ? `Move every account in "${mergeTarget.name}" into "Other"? This can't be undone automatically, but you can rename the accounts back later.`
            : ""
        }
        confirmLabel="Merge"
        busyLabel="Merging…"
        busy={busy}
        onConfirm={() => {
          if (mergeTarget) void mergeIntoOther(mergeTarget.type, mergeTarget.name);
        }}
      />
    </>
  );
}
