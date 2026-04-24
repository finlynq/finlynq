"use client";

import { useMemo, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";

export interface MappingDialogState {
  accountAutoCreateByDefault: boolean;
  categoryAutoCreateByDefault: boolean;
  /** externalAccountId → Finlynq accounts.id. Absent = fall back to default (auto-create if enabled). */
  accountOverrides: Record<string, number>;
  /** externalCategoryId → Finlynq categories.id | null. null = uncategorized. */
  categoryOverrides: Record<string, number | null>;
  transferCategoryId: number | null;
  transferAutoCreateName: string;
  openingBalanceCategoryId: number | null;
  openingBalanceAutoCreateName: string;
  /** ISO YYYY-MM-DD or empty string. */
  startDate: string;
}

interface ProbeSummary {
  external: {
    accounts: Array<{ id: string; name: string; type: string; currency: string; groupName?: string }>;
    categories: Array<{ id: string; name: string; type: string; groupName?: string }>;
  };
  finlynq: {
    accounts: Array<{ id: number; name: string; type: string; currency: string; group: string }>;
    categories: Array<{ id: number; name: string; type: string; group: string }>;
  };
}

interface ConnectorMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  probe: ProbeSummary;
  state: MappingDialogState;
  onConfirm: (state: MappingDialogState) => void;
}

export function ConnectorMappingDialog({ open, onOpenChange, probe, state, onConfirm }: ConnectorMappingDialogProps) {
  const [s, setS] = useState<MappingDialogState>(state);
  const [showAdvanced, setShowAdvanced] = useState(false);

  const finlynqAccountOptions = useMemo(
    () => probe.finlynq.accounts.map((a) => ({ id: a.id, label: `${a.name} (${a.currency})` })),
    [probe.finlynq.accounts],
  );
  const finlynqCategoryOptions = useMemo(
    () => probe.finlynq.categories.map((c) => ({ id: c.id, label: `${c.name} (${c.type})` })),
    [probe.finlynq.categories],
  );

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-3xl max-h-[85vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>Map WealthPosition to Finlynq</DialogTitle>
          <DialogDescription>
            Every WealthPosition account and category needs a Finlynq counterpart. By default,
            missing ones will be auto-created for you — you can override any mapping below.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          {/* Defaults */}
          <div className="space-y-3 rounded-md border p-3 bg-muted/30">
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="accts-auto" className="text-sm">
                Auto-create missing accounts ({probe.external.accounts.length} total)
              </Label>
              <input
                id="accts-auto"
                type="checkbox"
                checked={s.accountAutoCreateByDefault}
                onChange={(e) => setS({ ...s, accountAutoCreateByDefault: e.target.checked })}
              />
            </div>
            <div className="flex items-center justify-between gap-2">
              <Label htmlFor="cats-auto" className="text-sm">
                Auto-create missing categories ({probe.external.categories.length} total)
              </Label>
              <input
                id="cats-auto"
                type="checkbox"
                checked={s.categoryAutoCreateByDefault}
                onChange={(e) => setS({ ...s, categoryAutoCreateByDefault: e.target.checked })}
              />
            </div>
          </div>

          {/* System categories */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Transfer category (for 2-account transfers)</Label>
              <Select
                value={s.transferCategoryId === null ? "__auto" : String(s.transferCategoryId)}
                onValueChange={(v) => {
                  if (!v || v === "__auto") setS({ ...s, transferCategoryId: null });
                  else setS({ ...s, transferCategoryId: Number(v) });
                }}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto">Auto-create &ldquo;Transfers&rdquo;</SelectItem>
                  {finlynqCategoryOptions.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Opening-balance category (for reconciliation adjustments)</Label>
              <Select
                value={s.openingBalanceCategoryId === null ? "__auto" : String(s.openingBalanceCategoryId)}
                onValueChange={(v) => {
                  if (!v || v === "__auto") setS({ ...s, openingBalanceCategoryId: null });
                  else setS({ ...s, openingBalanceCategoryId: Number(v) });
                }}
              >
                <SelectTrigger className="h-9 text-sm">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectItem value="__auto">Auto-create &ldquo;Opening Balance&rdquo;</SelectItem>
                  {finlynqCategoryOptions.map((c) => (
                    <SelectItem key={c.id} value={String(c.id)}>
                      {c.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Start date (optional — leave blank to pull everything)</Label>
            <Input
              type="date"
              value={s.startDate}
              onChange={(e) => setS({ ...s, startDate: e.target.value })}
              className="h-9 text-sm"
            />
          </div>

          {/* Advanced per-row mapping */}
          <div>
            <button
              type="button"
              className="text-xs text-muted-foreground underline"
              onClick={() => setShowAdvanced((v) => !v)}
            >
              {showAdvanced ? "Hide" : "Show"} per-entity mapping overrides
            </button>
          </div>

          {showAdvanced && (
            <div className="space-y-4">
              <div>
                <h3 className="text-sm font-medium mb-2">Accounts</h3>
                <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border p-2">
                  {probe.external.accounts.map((a) => (
                    <div key={a.id} className="flex items-center gap-2 text-xs">
                      <div className="w-1/2 truncate" title={a.name}>
                        {a.name}{" "}
                        <span className="text-muted-foreground">
                          ({a.type}/{a.currency})
                        </span>
                      </div>
                      <Select
                        value={
                          s.accountOverrides[a.id] !== undefined
                            ? String(s.accountOverrides[a.id])
                            : s.accountAutoCreateByDefault
                              ? "__auto"
                              : "__skip"
                        }
                        onValueChange={(v) => {
                          const overrides = { ...s.accountOverrides };
                          if (!v || v === "__auto" || v === "__skip") {
                            delete overrides[a.id];
                          } else {
                            overrides[a.id] = Number(v);
                          }
                          setS({ ...s, accountOverrides: overrides });
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto">Auto-create</SelectItem>
                          {finlynqAccountOptions.map((o) => (
                            <SelectItem key={o.id} value={String(o.id)}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
              <div>
                <h3 className="text-sm font-medium mb-2">Categories</h3>
                <div className="space-y-1 max-h-64 overflow-y-auto rounded-md border p-2">
                  {probe.external.categories.map((c) => (
                    <div key={c.id} className="flex items-center gap-2 text-xs">
                      <div className="w-1/2 truncate" title={c.name}>
                        {c.name}{" "}
                        <span className="text-muted-foreground">({c.type})</span>
                      </div>
                      <Select
                        value={
                          s.categoryOverrides[c.id] === null
                            ? "__none"
                            : s.categoryOverrides[c.id] !== undefined
                              ? String(s.categoryOverrides[c.id])
                              : s.categoryAutoCreateByDefault
                                ? "__auto"
                                : "__none"
                        }
                        onValueChange={(v) => {
                          const overrides = { ...s.categoryOverrides };
                          if (!v || v === "__auto") delete overrides[c.id];
                          else if (v === "__none") overrides[c.id] = null;
                          else overrides[c.id] = Number(v);
                          setS({ ...s, categoryOverrides: overrides });
                        }}
                      >
                        <SelectTrigger className="h-7 text-xs flex-1">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectItem value="__auto">Auto-create</SelectItem>
                          <SelectItem value="__none">Leave uncategorized</SelectItem>
                          {finlynqCategoryOptions.map((o) => (
                            <SelectItem key={o.id} value={String(o.id)}>
                              {o.label}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button onClick={() => onConfirm(s)}>Preview sync</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
