"use client";

/**
 * /import/pending — review queue for email-delivered transactions.
 *
 * Shows staged imports that came in via Resend Inbound and are waiting for
 * the user's approval. Click a row to see the parsed transactions with
 * per-row checkboxes, then Approve (materializes into the encrypted
 * transactions table with the user's DEK) or Reject (deletes).
 *
 * Rows auto-expire after 14 days regardless of action.
 */

import { useCallback, useEffect, useState } from "react";
import Link from "next/link";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { ArrowLeft, Inbox, Mail, Clock, Check, X, RefreshCw } from "lucide-react";
import { formatCurrency } from "@/lib/currency";

interface StagedRow {
  id: string;
  source: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  totalRowCount: number;
  duplicateCount: number;
  expiresAt: string;
}

interface StagedDetail {
  staged: StagedRow & { status: string };
  rows: Array<{
    id: string;
    date: string;
    amount: number;
    currency: string | null;
    payee: string | null;
    category: string | null;
    accountName: string | null;
    note: string | null;
    rowIndex: number;
    isDuplicate: boolean;
  }>;
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export default function PendingImportsPage() {
  const [list, setList] = useState<StagedRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [openId, setOpenId] = useState<string | null>(null);
  const [detail, setDetail] = useState<StagedDetail | null>(null);
  const [detailLoading, setDetailLoading] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [acting, setActing] = useState(false);
  const [toast, setToast] = useState<{ type: "success" | "error"; msg: string } | null>(null);

  const loadList = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/import/staged");
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Failed to load");
      setList(data);
    } catch (e) {
      setError(e instanceof Error ? e.message : "Failed to load");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { loadList(); }, [loadList]);

  const openDetail = useCallback(async (id: string) => {
    setOpenId(id);
    setDetail(null);
    setDetailLoading(true);
    try {
      const res = await fetch(`/api/import/staged/${id}`);
      const data: StagedDetail = await res.json();
      if (!res.ok) throw new Error((data as unknown as { error?: string }).error || "Failed to load");
      setDetail(data);
      // Default selection = all non-duplicate rows.
      setSelected(new Set(data.rows.filter((r) => !r.isDuplicate).map((r) => r.id)));
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Failed to load" });
      setOpenId(null);
    } finally {
      setDetailLoading(false);
    }
  }, []);

  const closeDetail = useCallback(() => {
    setOpenId(null);
    setDetail(null);
    setSelected(new Set());
  }, []);

  const toggleRow = (id: string) => {
    setSelected((s) => {
      const next = new Set(s);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleAll = () => {
    if (!detail) return;
    setSelected((s) =>
      s.size === detail.rows.length
        ? new Set()
        : new Set(detail.rows.map((r) => r.id)),
    );
  };

  const approve = useCallback(async () => {
    if (!openId || selected.size === 0) return;
    setActing(true);
    try {
      const res = await fetch(`/api/import/staged/${openId}/approve`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rowIds: Array.from(selected) }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Approve failed");
      setToast({
        type: "success",
        msg: `Imported ${data.imported ?? 0} transactions (${data.skippedDuplicates ?? 0} dupes skipped)`,
      });
      closeDetail();
      loadList();
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Approve failed" });
    } finally {
      setActing(false);
    }
  }, [openId, selected, closeDetail, loadList]);

  const reject = useCallback(async () => {
    if (!openId) return;
    if (!confirm("Discard this staged import? The rows will be deleted.")) return;
    setActing(true);
    try {
      const res = await fetch(`/api/import/staged/${openId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error || "Reject failed");
      setToast({ type: "success", msg: "Staged import discarded" });
      closeDetail();
      loadList();
    } catch (e) {
      setToast({ type: "error", msg: e instanceof Error ? e.message : "Reject failed" });
    } finally {
      setActing(false);
    }
  }, [openId, closeDetail, loadList]);

  return (
    <div className="max-w-5xl space-y-6">
      <div className="flex items-center gap-3">
        <Link href="/import" className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1">
          <ArrowLeft className="h-4 w-4" />
          Back to Import
        </Link>
      </div>

      <div className="flex items-start justify-between gap-4">
        <div>
          <h1 className="text-2xl font-bold tracking-tight">Pending Imports</h1>
          <p className="text-sm text-muted-foreground mt-0.5">
            Transactions that arrived via email and are waiting for your review.
            Rows auto-expire after 14 days.
          </p>
        </div>
        <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
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

      {loading && !list && (
        <Card><CardContent className="py-8 text-sm text-muted-foreground text-center">Loading…</CardContent></Card>
      )}

      {list && list.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">Nothing pending</p>
              <p className="text-xs text-muted-foreground mt-1">
                Forward a bank statement or CSV to your import address and it&apos;ll land here for review.
              </p>
            </div>
            <Link href="/import" className="inline-block">
              <Button variant="outline" size="sm">View import address</Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {list && list.length > 0 && (
        <div className="space-y-3">
          {list.map((row) => (
            <Card key={row.id} className="cursor-pointer hover:border-primary/50 transition-colors" onClick={() => openDetail(row.id)}>
              <CardContent className="py-4">
                <div className="flex items-start justify-between gap-4">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-2 mb-1">
                      <Mail className="h-4 w-4 text-muted-foreground shrink-0" />
                      <p className="text-sm font-medium truncate">{row.subject || "(no subject)"}</p>
                    </div>
                    <p className="text-xs text-muted-foreground truncate">
                      from {row.fromAddress || "(unknown)"} · received {new Date(row.receivedAt).toLocaleString()}
                    </p>
                  </div>
                  <div className="flex items-center gap-2 shrink-0">
                    <Badge variant="outline" className="font-mono">
                      {row.totalRowCount} {row.totalRowCount === 1 ? "row" : "rows"}
                    </Badge>
                    {row.duplicateCount > 0 && (
                      <Badge variant="outline" className="bg-amber-50 text-amber-700 border-amber-200">
                        {row.duplicateCount} dupe{row.duplicateCount === 1 ? "" : "s"}
                      </Badge>
                    )}
                    <Badge variant="outline" className="bg-muted/60 text-xs">
                      <Clock className="h-3 w-3 mr-1" />
                      {daysUntil(row.expiresAt)}d left
                    </Badge>
                  </div>
                </div>
              </CardContent>
            </Card>
          ))}
        </div>
      )}

      <Dialog open={!!openId} onOpenChange={(v) => { if (!v) closeDetail(); }}>
        <DialogContent className="max-w-4xl max-h-[85vh] flex flex-col">
          <DialogHeader>
            <DialogTitle>Review transactions</DialogTitle>
            <DialogDescription>
              {detail ? (
                <>
                  From <span className="font-medium">{detail.staged.fromAddress || "(unknown)"}</span>
                  {detail.staged.subject && <> · {detail.staged.subject}</>}
                </>
              ) : "Loading…"}
            </DialogDescription>
          </DialogHeader>

          <div className="flex-1 overflow-auto border rounded-lg">
            {detailLoading && <p className="p-6 text-sm text-muted-foreground text-center">Loading rows…</p>}
            {detail && (
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead className="w-10">
                      <input
                        type="checkbox"
                        checked={detail.rows.length > 0 && selected.size === detail.rows.length}
                        onChange={toggleAll}
                        aria-label="Select all"
                      />
                    </TableHead>
                    <TableHead>Date</TableHead>
                    <TableHead>Account</TableHead>
                    <TableHead>Payee</TableHead>
                    <TableHead>Category</TableHead>
                    <TableHead className="text-right">Amount</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {detail.rows.map((r) => (
                    <TableRow key={r.id} className={r.isDuplicate ? "opacity-60" : ""}>
                      <TableCell>
                        <input
                          type="checkbox"
                          checked={selected.has(r.id)}
                          onChange={() => toggleRow(r.id)}
                          aria-label={`Select row ${r.rowIndex}`}
                        />
                      </TableCell>
                      <TableCell className="font-mono text-xs">{r.date}</TableCell>
                      <TableCell className="text-xs">{r.accountName || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-xs truncate max-w-[200px]">{r.payee || <span className="text-muted-foreground">—</span>}</TableCell>
                      <TableCell className="text-xs">
                        {r.category || <span className="text-muted-foreground">—</span>}
                        {r.isDuplicate && <Badge variant="outline" className="ml-2 text-[10px]">dupe</Badge>}
                      </TableCell>
                      <TableCell className="text-right font-mono text-xs">
                        {formatCurrency(r.amount, r.currency || "CAD")}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            )}
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={reject} disabled={acting} className="text-rose-700 hover:text-rose-800 hover:bg-rose-50">
              <X className="h-4 w-4 mr-1.5" />
              Discard all
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={closeDetail} disabled={acting}>Cancel</Button>
              <Button onClick={approve} disabled={acting || selected.size === 0}>
                <Check className="h-4 w-4 mr-1.5" />
                Import {selected.size > 0 && `(${selected.size})`}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
