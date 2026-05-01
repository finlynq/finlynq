"use client";

/**
 * /settings/holding-accounts — manage many-to-many holding ↔ account
 * pairings. Issue #26 (Section G).
 *
 * Each holding is a row with an inner table of its account pairings:
 * (account, qty, cost basis, primary?). The legacy
 * `portfolio_holdings.account_id` column still drives every aggregator
 * read (issue #25 / Section F migrates the consumers); the row here
 * whose `is_primary=true` mirrors it.
 *
 * The Add/Edit-holding dialog on the Portfolio page still owns the
 * first pairing — this page only manages the second-and-beyond cases.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Briefcase, Plus, Trash2, Star, RefreshCw, Pencil, Check, X } from "lucide-react";

type Pairing = {
  holdingId: number;
  accountId: number;
  qty: number;
  costBasis: number;
  isPrimary: boolean;
  createdAt: string;
  holdingName: string | null;
  holdingSymbol: string | null;
  holdingCurrency: string;
  accountName: string | null;
  accountIsInvestment: boolean;
};

type Account = {
  id: number;
  name: string;
  type: string;
  currency: string;
  isInvestment: boolean;
  archived?: boolean;
};

type Holding = {
  id: number;
  name: string;
  symbol: string | null;
  currency: string;
};

type HoldingGroup = {
  holding: { id: number; displayName: string; symbol: string | null; currency: string };
  pairings: Pairing[];
};

function holdingDisplay(p: { holdingName: string | null; holdingSymbol: string | null }): string {
  if (p.holdingSymbol && p.holdingSymbol.trim()) return p.holdingSymbol.trim();
  return p.holdingName ?? "(unnamed)";
}

export default function HoldingAccountsPage() {
  const [pairings, setPairings] = useState<Pairing[] | null>(null);
  const [accounts, setAccounts] = useState<Account[]>([]);
  const [holdings, setHoldings] = useState<Holding[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  // Add-pairing dialog state.
  const [addOpen, setAddOpen] = useState(false);
  const [addHoldingId, setAddHoldingId] = useState<number | null>(null);
  const [addAccountId, setAddAccountId] = useState<string>("");
  const [addQty, setAddQty] = useState("");
  const [addCostBasis, setAddCostBasis] = useState("");
  const [addIsPrimary, setAddIsPrimary] = useState(false);
  const [addErrors, setAddErrors] = useState<Record<string, string>>({});
  const [addSubmitting, setAddSubmitting] = useState(false);

  // Edit-pairing inline state.
  const [editingKey, setEditingKey] = useState<string | null>(null);
  const [editQty, setEditQty] = useState("");
  const [editCostBasis, setEditCostBasis] = useState("");
  const [editError, setEditError] = useState("");
  const [editSubmitting, setEditSubmitting] = useState(false);

  const loadAll = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [pRes, aRes, hRes] = await Promise.all([
        fetch("/api/holding-accounts"),
        fetch("/api/accounts?includeArchived=1"),
        fetch("/api/portfolio"),
      ]);
      if (!pRes.ok) throw new Error("Failed to load pairings");
      if (!aRes.ok) throw new Error("Failed to load accounts");
      if (!hRes.ok) throw new Error("Failed to load holdings");
      const [p, a, h] = await Promise.all([pRes.json(), aRes.json(), hRes.json()]);
      setPairings(p);
      setAccounts(a);
      setHoldings(h);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    loadAll();
  }, [loadAll]);

  const groups: HoldingGroup[] = useMemo(() => {
    if (!pairings) return [];
    const map = new Map<number, HoldingGroup>();
    for (const p of pairings) {
      let group = map.get(p.holdingId);
      if (!group) {
        group = {
          holding: {
            id: p.holdingId,
            displayName: holdingDisplay(p),
            symbol: p.holdingSymbol,
            currency: p.holdingCurrency,
          },
          pairings: [],
        };
        map.set(p.holdingId, group);
      }
      group.pairings.push(p);
    }
    // Holdings with no pairings yet: synth a single empty group from
    // /api/portfolio so the user can add the first pairing here too.
    for (const h of holdings) {
      if (map.has(h.id)) continue;
      map.set(h.id, {
        holding: {
          id: h.id,
          displayName: h.symbol?.trim() || h.name || "(unnamed)",
          symbol: h.symbol,
          currency: h.currency,
        },
        pairings: [],
      });
    }
    // Sort: pinned-pairings first (count desc) then by display name.
    return Array.from(map.values()).sort((a, b) => {
      const cmp = b.pairings.length - a.pairings.length;
      if (cmp !== 0) return cmp;
      return a.holding.displayName.localeCompare(b.holding.displayName);
    });
  }, [pairings, holdings]);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  }

  function openAddFor(holdingId: number) {
    setAddHoldingId(holdingId);
    setAddAccountId("");
    setAddQty("");
    setAddCostBasis("");
    setAddIsPrimary(false);
    setAddErrors({});
    setAddOpen(true);
  }

  async function submitAdd() {
    if (!addHoldingId) return;
    const errs: Record<string, string> = {};
    const accountId = parseInt(addAccountId, 10);
    if (!Number.isFinite(accountId) || accountId <= 0) errs.account = "Account is required";
    const qtyNum = addQty.trim() ? Number(addQty) : 0;
    if (!Number.isFinite(qtyNum) || qtyNum < 0) errs.qty = "Qty must be a number ≥ 0";
    const costNum = addCostBasis.trim() ? Number(addCostBasis) : 0;
    if (!Number.isFinite(costNum) || costNum < 0) errs.costBasis = "Cost basis must be a number ≥ 0";
    setAddErrors(errs);
    if (Object.keys(errs).length > 0) return;

    setAddSubmitting(true);
    try {
      const res = await fetch("/api/holding-accounts", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdingId: addHoldingId,
          accountId,
          qty: qtyNum,
          costBasis: costNum,
          isPrimary: addIsPrimary,
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to add pairing");
      }
      setAddOpen(false);
      showToast("success", "Pairing added");
      await loadAll();
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Add failed");
    } finally {
      setAddSubmitting(false);
    }
  }

  function startEdit(p: Pairing) {
    setEditingKey(`${p.holdingId}-${p.accountId}`);
    setEditQty(String(p.qty ?? 0));
    setEditCostBasis(String(p.costBasis ?? 0));
    setEditError("");
  }

  async function saveEdit(p: Pairing) {
    const qtyNum = Number(editQty);
    const costNum = Number(editCostBasis);
    if (!Number.isFinite(qtyNum) || qtyNum < 0 || !Number.isFinite(costNum) || costNum < 0) {
      setEditError("Qty and cost basis must be numbers ≥ 0");
      return;
    }
    setEditSubmitting(true);
    try {
      const res = await fetch("/api/holding-accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdingId: p.holdingId,
          accountId: p.accountId,
          qty: qtyNum,
          costBasis: costNum,
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to save");
      }
      setEditingKey(null);
      showToast("success", "Pairing updated");
      await loadAll();
    } catch (e) {
      setEditError(e instanceof Error ? e.message : "Save failed");
    } finally {
      setEditSubmitting(false);
    }
  }

  async function setPrimary(p: Pairing) {
    if (p.isPrimary) return;
    try {
      const res = await fetch("/api/holding-accounts", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          holdingId: p.holdingId,
          accountId: p.accountId,
          isPrimary: true,
        }),
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to set primary");
      }
      showToast("success", "Primary pairing updated");
      await loadAll();
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Failed");
    }
  }

  async function deletePairing(p: Pairing) {
    if (!confirm(`Remove ${p.accountName ?? "(account)"} from ${holdingDisplay(p)}?`)) return;
    try {
      const params = new URLSearchParams({
        holdingId: String(p.holdingId),
        accountId: String(p.accountId),
      });
      const res = await fetch(`/api/holding-accounts?${params.toString()}`, {
        method: "DELETE",
      });
      if (!res.ok) {
        const data: { error?: string } = await res.json().catch(() => ({}));
        throw new Error(data?.error || "Failed to remove pairing");
      }
      showToast("success", "Pairing removed");
      await loadAll();
    } catch (e) {
      showToast("error", e instanceof Error ? e.message : "Delete failed");
    }
  }

  const accountsById = useMemo(() => {
    const map = new Map<number, Account>();
    for (const a of accounts) map.set(a.id, a);
    return map;
  }, [accounts]);

  const eligibleAccountsForAdd = useMemo(() => {
    if (!addHoldingId || !pairings) return accounts;
    const taken = new Set(
      pairings.filter((p) => p.holdingId === addHoldingId).map((p) => p.accountId),
    );
    return accounts.filter((a) => !taken.has(a.id) && !a.archived);
  }, [addHoldingId, pairings, accounts]);

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Holding ↔ Account Map</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            The same security can sit in multiple accounts. Each pairing
            tracks its own quantity and cost basis. The primary pairing
            is the one the legacy aggregator + investment-account
            constraint checks read today.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadAll} disabled={loading}>
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

      {loading && !pairings && (
        <Card><CardContent className="py-8 text-sm text-muted-foreground text-center">Loading…</CardContent></Card>
      )}

      {pairings && groups.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Briefcase className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">No holdings yet</p>
              <p className="text-xs text-muted-foreground mt-1">
                Add a holding from the <Link href="/portfolio" className="underline">Portfolio</Link> page first.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {pairings && groups.length > 0 && (
        <div className="space-y-4">
          {groups.map((g) => (
            <Card key={g.holding.id}>
              <CardHeader>
                <div className="flex items-start justify-between gap-3">
                  <div>
                    <CardTitle className="text-base inline-flex items-center gap-2">
                      <Briefcase className="h-4 w-4 text-cyan-500" />
                      {g.holding.displayName}
                      <Badge variant="outline" className="text-[10px] font-mono">{g.holding.currency}</Badge>
                    </CardTitle>
                    <CardDescription>
                      {g.pairings.length === 0
                        ? "No account pairings yet."
                        : `${g.pairings.length} ${g.pairings.length === 1 ? "account" : "accounts"} hold this position.`}
                    </CardDescription>
                  </div>
                  <Button variant="outline" size="sm" onClick={() => openAddFor(g.holding.id)}>
                    <Plus className="h-3.5 w-3.5 mr-1" />
                    Add account
                  </Button>
                </div>
              </CardHeader>
              {g.pairings.length > 0 && (
                <CardContent>
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Account</TableHead>
                        <TableHead className="text-right">Qty</TableHead>
                        <TableHead className="text-right">Cost basis</TableHead>
                        <TableHead className="w-24">Primary</TableHead>
                        <TableHead className="w-32 text-right">Actions</TableHead>
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {g.pairings.map((p) => {
                        const key = `${p.holdingId}-${p.accountId}`;
                        const editing = editingKey === key;
                        const acct = accountsById.get(p.accountId);
                        return (
                          <TableRow key={key}>
                            <TableCell>
                              <div className="font-medium text-sm">{p.accountName ?? acct?.name ?? `#${p.accountId}`}</div>
                              {acct && !acct.isInvestment && (
                                <div className="text-[10px] text-amber-600 mt-0.5">Non-investment account</div>
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {editing ? (
                                <Input
                                  className="w-24 inline-block text-right"
                                  type="number"
                                  step="any"
                                  min="0"
                                  value={editQty}
                                  onChange={(e) => setEditQty(e.target.value)}
                                />
                              ) : (
                                p.qty.toLocaleString(undefined, { maximumFractionDigits: 6 })
                              )}
                            </TableCell>
                            <TableCell className="text-right font-mono text-sm">
                              {editing ? (
                                <Input
                                  className="w-28 inline-block text-right"
                                  type="number"
                                  step="any"
                                  min="0"
                                  value={editCostBasis}
                                  onChange={(e) => setEditCostBasis(e.target.value)}
                                />
                              ) : (
                                p.costBasis.toLocaleString(undefined, { maximumFractionDigits: 2 })
                              )}
                            </TableCell>
                            <TableCell>
                              {p.isPrimary ? (
                                <Badge variant="outline" className="text-xs bg-amber-50 text-amber-700 border-amber-200">
                                  <Star className="h-3 w-3 mr-1 fill-current" /> Primary
                                </Badge>
                              ) : (
                                <Button variant="ghost" size="sm" className="h-7 px-2 text-xs" onClick={() => setPrimary(p)}>
                                  Make primary
                                </Button>
                              )}
                            </TableCell>
                            <TableCell className="text-right">
                              {editing ? (
                                <div className="inline-flex gap-1">
                                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => saveEdit(p)} disabled={editSubmitting} title="Save">
                                    <Check className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button variant="outline" size="icon" className="h-7 w-7" onClick={() => setEditingKey(null)} title="Cancel">
                                    <X className="h-3.5 w-3.5" />
                                  </Button>
                                </div>
                              ) : (
                                <div className="inline-flex gap-1">
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => startEdit(p)} title="Edit">
                                    <Pencil className="h-3.5 w-3.5" />
                                  </Button>
                                  <Button variant="ghost" size="icon" className="h-7 w-7" onClick={() => deletePairing(p)} title="Remove">
                                    <Trash2 className="h-3.5 w-3.5 text-rose-500" />
                                  </Button>
                                </div>
                              )}
                            </TableCell>
                          </TableRow>
                        );
                      })}
                    </TableBody>
                  </Table>
                  {editingKey && editError && (
                    <p className="text-xs text-rose-600 mt-2">{editError}</p>
                  )}
                </CardContent>
              )}
            </Card>
          ))}
        </div>
      )}

      <Dialog open={addOpen} onOpenChange={setAddOpen}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Add account pairing</DialogTitle>
            <DialogDescription>
              Pick an account this holding sits in. Quantity and cost basis are optional; leave them at 0 if you only want to record the link.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-3">
            <div>
              <Label>Account</Label>
              <Select value={addAccountId} onValueChange={(v) => setAddAccountId(v ?? "")}>
                <SelectTrigger><SelectValue placeholder="Choose an account" /></SelectTrigger>
                <SelectContent>
                  {eligibleAccountsForAdd.length === 0 ? (
                    <SelectItem value="__none__" disabled>No eligible accounts</SelectItem>
                  ) : (
                    eligibleAccountsForAdd.map((a) => (
                      <SelectItem key={a.id} value={String(a.id)}>
                        {a.name} <span className="text-muted-foreground">({a.currency})</span>
                      </SelectItem>
                    ))
                  )}
                </SelectContent>
              </Select>
              {addErrors.account && <p className="text-xs text-rose-600 mt-1">{addErrors.account}</p>}
            </div>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <Label>Qty</Label>
                <Input
                  type="number"
                  step="any"
                  min="0"
                  value={addQty}
                  onChange={(e) => setAddQty(e.target.value)}
                  placeholder="0"
                />
                {addErrors.qty && <p className="text-xs text-rose-600 mt-1">{addErrors.qty}</p>}
              </div>
              <div>
                <Label>Cost basis</Label>
                <Input
                  type="number"
                  step="any"
                  min="0"
                  value={addCostBasis}
                  onChange={(e) => setAddCostBasis(e.target.value)}
                  placeholder="0"
                />
                {addErrors.costBasis && <p className="text-xs text-rose-600 mt-1">{addErrors.costBasis}</p>}
              </div>
            </div>
            <label className="flex items-center gap-2 text-sm cursor-pointer">
              <input
                type="checkbox"
                checked={addIsPrimary}
                onChange={(e) => setAddIsPrimary(e.target.checked)}
              />
              Make this the primary pairing
            </label>
            <p className="text-xs text-muted-foreground">
              The primary pairing mirrors <code>portfolio_holdings.account_id</code>.
              Setting this one as primary will demote the existing primary for this holding.
            </p>
          </div>
          <DialogFooter>
            <Button variant="outline" onClick={() => setAddOpen(false)} disabled={addSubmitting}>Cancel</Button>
            <Button onClick={submitAdd} disabled={addSubmitting}>
              {addSubmitting ? "Saving…" : "Add pairing"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
