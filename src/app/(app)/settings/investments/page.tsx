"use client";

/**
 * /settings/investments — investment-related settings.
 *
 * Issue #100: this page now hosts a full holding-CRUD surface (add /
 * edit / delete portfolio_holdings) using the SAME shared
 * <HoldingEditForm> mounted on /portfolio. Surface drift between the
 * two is structurally impossible — both pages import the same
 * component from src/components/holdings/holding-edit-form.tsx.
 *
 * The Holding ↔ Account Map sub-page is a separate surface (issue #26 /
 * Section G) and stays linked at the bottom — that page manages the
 * many-to-many `holding_accounts` join table, which this form does NOT
 * touch (the POST /api/portfolio handler creates the primary pairing
 * implicitly; secondary pairings live there).
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Briefcase, Plus, Pencil, ArrowRight } from "lucide-react";
import {
  HoldingEditForm,
  type HoldingEditFormHolding,
} from "@/components/holdings/holding-edit-form";

type Holding = {
  id: number;
  accountId: number | null;
  accountName: string | null;
  name: string | null;
  symbol: string | null;
  currency: string;
  isCrypto?: number | null;
  note?: string | null;
};

type DialogState =
  | { mode: "edit"; holding: Holding }
  | { mode: "create" }
  | null;

function holdingDisplayName(h: Holding): string {
  if (h.symbol && h.symbol.trim()) return h.symbol.trim();
  return h.name?.trim() || "(unnamed)";
}

export default function InvestmentsSettingsPage() {
  const [holdings, setHoldings] = useState<Holding[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dialogState, setDialogState] = useState<DialogState>(null);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const load = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/portfolio");
      if (!res.ok) throw new Error("Failed to load holdings");
      const rows = (await res.json()) as Holding[];
      setHoldings(rows);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  function showToast(type: "success" | "error", msg: string) {
    setToast({ type, msg });
    setTimeout(() => setToast(null), 4000);
  }

  // Group holdings by account for a tidy display, mirroring the layout
  // of /settings/holding-accounts. Holdings with no account land in
  // "Unassigned".
  const grouped = useMemo(() => {
    if (!holdings) return [];
    const map = new Map<string, { accountName: string; rows: Holding[] }>();
    for (const h of holdings) {
      const key = h.accountName ?? "(unassigned)";
      if (!map.has(key)) map.set(key, { accountName: key, rows: [] });
      map.get(key)!.rows.push(h);
    }
    return Array.from(map.values()).sort((a, b) =>
      a.accountName.localeCompare(b.accountName),
    );
  }, [holdings]);

  function toFormHolding(h: Holding): HoldingEditFormHolding {
    return {
      id: h.id,
      accountId: h.accountId,
      name: h.name,
      symbol: h.symbol,
      currency: h.currency,
      isCrypto: h.isCrypto ?? null,
      note: h.note ?? null,
    };
  }

  return (
    <div className="max-w-4xl space-y-6">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Investments</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Manage portfolio holdings and per-account pairings
          </p>
        </div>
        <Button onClick={() => setDialogState({ mode: "create" })} size="sm">
          <Plus className="h-4 w-4 mr-1.5" /> Add holding
        </Button>
      </div>

      {error && (
        <div className="rounded-lg border border-destructive/30 bg-destructive/5 p-3 text-sm text-destructive">
          {error}
        </div>
      )}

      {toast && (
        <div
          className={`rounded-lg border p-3 text-sm ${
            toast.type === "success"
              ? "border-emerald-300 bg-emerald-50 text-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-200 dark:border-emerald-900"
              : "border-rose-300 bg-rose-50 text-rose-800 dark:bg-rose-950/40 dark:text-rose-200 dark:border-rose-900"
          }`}
        >
          {toast.msg}
        </div>
      )}

      <Card>
        <CardHeader>
          <CardTitle className="text-base">Holdings</CardTitle>
          <CardDescription>
            Edit name / symbol / currency / note on individual portfolio
            holdings. The same form is used on the Portfolio page.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-6">
          {holdings === null ? (
            <p className="text-sm text-muted-foreground">Loading…</p>
          ) : holdings.length === 0 ? (
            <p className="text-sm text-muted-foreground">
              No holdings yet. Click <strong>Add holding</strong> to create your first.
            </p>
          ) : (
            grouped.map((group) => (
              <div key={group.accountName} className="space-y-2">
                <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  {group.accountName}
                </div>
                <div className="rounded-md border overflow-x-auto">
                  <Table>
                    <TableHeader>
                      <TableRow>
                        <TableHead>Name</TableHead>
                        <TableHead>Symbol</TableHead>
                        <TableHead>Currency</TableHead>
                        <TableHead className="text-right" />
                      </TableRow>
                    </TableHeader>
                    <TableBody>
                      {group.rows.map((h) => (
                        <TableRow key={h.id}>
                          <TableCell className="text-sm font-medium">
                            {holdingDisplayName(h)}
                          </TableCell>
                          <TableCell className="text-sm font-mono">
                            {h.symbol?.trim() || (
                              <span className="text-muted-foreground">--</span>
                            )}
                          </TableCell>
                          <TableCell className="text-sm">
                            <Badge variant="outline" className="font-mono text-[10px]">
                              {h.currency}
                            </Badge>
                            {h.isCrypto === 1 && (
                              <Badge variant="outline" className="ml-1.5 text-[10px]">
                                crypto
                              </Badge>
                            )}
                          </TableCell>
                          <TableCell className="text-right">
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() =>
                                setDialogState({ mode: "edit", holding: h })
                              }
                            >
                              <Pencil className="h-3.5 w-3.5 mr-1" /> Edit
                            </Button>
                          </TableCell>
                        </TableRow>
                      ))}
                    </TableBody>
                  </Table>
                </div>
              </div>
            ))
          )}
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <div className="flex items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-cyan-100 text-cyan-600">
                <Briefcase className="h-5 w-5" />
              </div>
              <div>
                <CardTitle className="text-base">Holding ↔ Account Map</CardTitle>
                <CardDescription>
                  Track the same security across multiple accounts with per-pairing qty + cost basis
                </CardDescription>
              </div>
            </div>
            <Link href="/settings/holding-accounts">
              <Button variant="outline" size="sm">
                Open <ArrowRight className="h-3.5 w-3.5 ml-1" />
              </Button>
            </Link>
          </div>
        </CardHeader>
      </Card>

      {/* Shared edit/create dialog — wraps <HoldingEditForm> in a v4
          base-ui Dialog. Same component as /portfolio mounts; identical
          submit handler, identical fields. */}
      <Dialog
        open={dialogState !== null}
        onOpenChange={(open) => {
          if (!open) setDialogState(null);
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>
              {dialogState?.mode === "edit" ? "Edit Holding" : "Add Holding"}
            </DialogTitle>
          </DialogHeader>
          {dialogState !== null && (
            <HoldingEditForm
              holdingId={
                dialogState.mode === "edit" ? dialogState.holding.id : undefined
              }
              initialHolding={
                dialogState.mode === "edit"
                  ? toFormHolding(dialogState.holding)
                  : undefined
              }
              onCancel={() => setDialogState(null)}
              onSave={(result) => {
                setDialogState(null);
                if (result.kind === "saved") {
                  showToast("success", "Holding saved");
                } else {
                  showToast(
                    "success",
                    result.unlinkedTransactions > 0
                      ? `Holding deleted (${result.unlinkedTransactions} transaction${result.unlinkedTransactions === 1 ? "" : "s"} unlinked)`
                      : "Holding deleted",
                  );
                }
                load();
              }}
            />
          )}
        </DialogContent>
      </Dialog>
    </div>
  );
}
