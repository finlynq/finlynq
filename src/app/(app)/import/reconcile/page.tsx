"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  AlertCircle,
  ArrowLeft,
  CheckCircle2,
  RefreshCw,
  Sparkles,
} from "lucide-react";
import { ReconcileUploadCard } from "@/components/reconcile/upload-card";
import {
  ReconcilePreviewTable,
  type AccountOption,
  type CategoryOption,
  type HoldingOption,
  type ReconcileRow,
} from "@/components/reconcile/preview-table";

interface PreviewResponse {
  format: "csv" | "ofx";
  rows: ReconcileRow[];
  errors: Array<{ rowIndex: number; message: string }>;
  counts: { new: number; existing: number; probableDuplicate: number; errors: number };
  tolerance: number;
}

interface CommitResponse {
  total: number;
  imported: number;
  errors: string[];
}

export default function ReconcilePage() {
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [categories, setCategories] = useState<CategoryOption[]>([]);
  const [holdings, setHoldings] = useState<HoldingOption[]>([]);
  const [preview, setPreview] = useState<PreviewResponse | null>(null);
  const [rows, setRows] = useState<ReconcileRow[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [previewLoading, setPreviewLoading] = useState(false);
  const [commitLoading, setCommitLoading] = useState(false);
  const [commitResult, setCommitResult] = useState<CommitResponse | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/categories").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/portfolio").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([accts, cats, hldgs]) => {
        if (Array.isArray(accts)) {
          setAccounts(
            accts.map((a: { id: number; name: string; currency: string; isInvestment?: boolean }) => ({
              id: a.id,
              name: a.name,
              currency: a.currency,
              isInvestment: !!a.isInvestment,
            })),
          );
        }
        if (Array.isArray(cats)) {
          setCategories(
            cats.map((c: { id: number; name: string; group: string }) => ({
              id: c.id,
              name: c.name,
              group: c.group,
            })),
          );
        }
        if (Array.isArray(hldgs)) {
          setHoldings(
            hldgs.map((h: { id: number; name: string; symbol: string | null; accountId: number | null }) => ({
              id: h.id,
              name: h.name,
              symbol: h.symbol,
              accountId: h.accountId,
            })),
          );
        }
      })
      .catch(() => {});
  }, []);

  const handleUpload = useCallback(
    async ({
      file,
      accountId,
      tolerance,
    }: {
      file: File;
      accountId: number | null;
      tolerance: number;
    }) => {
      setError(null);
      setCommitResult(null);
      setPreview(null);
      setRows([]);
      setPreviewLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        if (accountId) fd.append("accountId", String(accountId));
        fd.append("tolerance", String(tolerance));
        const res = await fetch("/api/import/reconcile/preview", {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        if (!res.ok) {
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        setPreview(json as PreviewResponse);
        setRows((json as PreviewResponse).rows);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Preview failed");
      } finally {
        setPreviewLoading(false);
      }
    },
    [],
  );

  const handleRowChange = useCallback(
    (rowIndex: number, patch: Partial<ReconcileRow>) => {
      setRows((prev) =>
        prev.map((r) => (r.rowIndex === rowIndex ? { ...r, ...patch } : r)),
      );
    },
    [],
  );

  // What will the commit submit?
  //   - All NEW rows whose accountId is resolved
  //   - PROBABLE_DUPLICATE rows ONLY when row.forceCommit === true
  //   - EXISTING rows are never submitted
  const commitable = useMemo(
    () =>
      rows.filter((r) => {
        if (r.accountId === null) return false;
        if (r.status === "existing") return false;
        if (r.status === "probable_duplicate") return !!r.forceCommit;
        return true; // NEW
      }),
    [rows],
  );

  const blockedReasons = useMemo(() => {
    const reasons: string[] = [];
    const investmentSet = new Set(
      accounts.filter((a) => a.isInvestment).map((a) => a.id),
    );
    const unresolvedAccount = rows.filter(
      (r) => r.status !== "existing" && r.accountId === null,
    ).length;
    if (unresolvedAccount > 0) {
      reasons.push(
        `${unresolvedAccount} row${unresolvedAccount === 1 ? "" : "s"} need an account picked.`,
      );
    }
    const missingHolding = commitable.filter(
      (r) =>
        r.accountId !== null &&
        investmentSet.has(r.accountId) &&
        (r.portfolioHoldingId == null || r.portfolioHoldingId === 0),
    ).length;
    if (missingHolding > 0) {
      reasons.push(
        `${missingHolding} row${missingHolding === 1 ? "" : "s"} on investment accounts need a holding.`,
      );
    }
    return reasons;
  }, [rows, commitable, accounts]);

  const handleCommit = useCallback(async () => {
    if (commitable.length === 0) return;
    setCommitLoading(true);
    setError(null);
    try {
      const payload = {
        rows: commitable.map((r) => ({
          rowIndex: r.rowIndex,
          date: r.date,
          accountId: r.accountId!,
          amount: r.amount,
          payee: r.payee,
          categoryId: r.categoryId ?? null,
          currency: r.currency,
          portfolioHoldingId: r.portfolioHoldingId ?? null,
          fitId: r.fitId,
        })),
        acceptProbableDuplicates: commitable.some(
          (r) => r.status === "probable_duplicate",
        ),
      };
      const res = await fetch("/api/import/reconcile/commit", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const json = (await res.json()) as CommitResponse;
      if (!res.ok && json.imported === 0) {
        throw new Error(
          (json.errors && json.errors[0]) ?? `HTTP ${res.status}`,
        );
      }
      setCommitResult(json);
      // Drop the just-committed rows from the active table so the user can
      // re-classify the remainder without a stale view.
      setRows((prev) =>
        prev.map((r) => {
          if (
            commitable.find((c) => c.rowIndex === r.rowIndex) !== undefined
          ) {
            return { ...r, status: "existing" as const };
          }
          return r;
        }),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : "Commit failed");
    } finally {
      setCommitLoading(false);
    }
  }, [commitable]);

  const handleReset = useCallback(() => {
    setPreview(null);
    setRows([]);
    setCommitResult(null);
    setError(null);
  }, []);

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reconciliation Mode</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Upload a statement and review every row before any write. Each
            row is classified as <strong>New</strong>,{" "}
            <strong>Existing</strong>, or <strong>Probable duplicate</strong>{" "}
            against your current Finlynq state. Commit is atomic — partial
            failures roll back.
          </p>
        </div>
        <Link
          href="/import"
          className="text-xs text-muted-foreground inline-flex items-center hover:underline"
        >
          <ArrowLeft className="h-3 w-3 mr-1" /> Back to Import
        </Link>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-lg border border-destructive/40 bg-destructive/10 p-3 text-sm">
          <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
          <div className="flex-1">{error}</div>
        </div>
      )}

      {commitResult && commitResult.imported > 0 && (
        <div className="flex items-start gap-2 rounded-lg border border-emerald-300 bg-emerald-50 p-3 text-sm">
          <CheckCircle2 className="h-4 w-4 mt-0.5 shrink-0 text-emerald-600" />
          <div className="flex-1">
            Imported <strong>{commitResult.imported}</strong> of{" "}
            <strong>{commitResult.total}</strong> rows.
            {commitResult.errors.length > 0 && (
              <ul className="mt-1 text-xs text-rose-700 list-disc pl-4">
                {commitResult.errors.map((e, i) => (
                  <li key={i}>{e}</li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}

      {!preview && (
        <Card>
          <CardHeader>
            <CardTitle>Upload statement</CardTitle>
            <CardDescription>
              Supported: CSV (with <code>Date,Account,Amount,Payee</code>{" "}
              headers or a saved template) and OFX/QFX (single-account
              statements — pick the destination Finlynq account below).
            </CardDescription>
          </CardHeader>
          <CardContent>
            <ReconcileUploadCard
              accounts={accounts}
              loading={previewLoading}
              onUpload={handleUpload}
            />
          </CardContent>
        </Card>
      )}

      {preview && (
        <Card>
          <CardHeader>
            <div className="flex flex-wrap items-center gap-2">
              <CardTitle className="flex-1">Preview</CardTitle>
              <Button variant="outline" size="sm" onClick={handleReset}>
                <RefreshCw className="h-3.5 w-3.5 mr-1.5" /> Upload another
              </Button>
            </div>
            <CardDescription className="flex flex-wrap gap-2 pt-2">
              <Badge className="bg-emerald-600 text-white">
                <Sparkles className="h-3 w-3 mr-1" />
                {preview.counts.new} new
              </Badge>
              <Badge variant="secondary" className="bg-amber-100 text-amber-800">
                {preview.counts.probableDuplicate} probable duplicate
                {preview.counts.probableDuplicate === 1 ? "" : "s"}
              </Badge>
              <Badge variant="secondary" className="bg-slate-200 text-slate-700">
                {preview.counts.existing} existing
              </Badge>
              {preview.counts.errors > 0 && (
                <Badge variant="destructive">
                  {preview.counts.errors} error
                  {preview.counts.errors === 1 ? "" : "s"}
                </Badge>
              )}
              <span className="text-[11px] text-muted-foreground self-center">
                Probable-duplicate window: ±{preview.tolerance} days
              </span>
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <ReconcilePreviewTable
              rows={rows}
              accounts={accounts}
              categories={categories}
              holdings={holdings}
              onChange={handleRowChange}
            />

            {preview.errors.length > 0 && (
              <div className="rounded-lg border border-rose-200 bg-rose-50/50 p-3 text-xs space-y-1">
                <div className="font-medium text-rose-700">
                  Row-level errors ({preview.errors.length})
                </div>
                {preview.errors.slice(0, 10).map((e) => (
                  <div key={`${e.rowIndex}-${e.message}`} className="text-rose-600">
                    Row {e.rowIndex + 1}: {e.message}
                  </div>
                ))}
                {preview.errors.length > 10 && (
                  <div className="text-rose-500">
                    …and {preview.errors.length - 10} more
                  </div>
                )}
              </div>
            )}

            {blockedReasons.length > 0 && (
              <div className="rounded-lg border border-amber-300 bg-amber-50 p-3 text-xs text-amber-800 space-y-0.5">
                {blockedReasons.map((r) => (
                  <div key={r}>· {r}</div>
                ))}
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2 pt-2 border-t">
              <div className="text-sm flex-1">
                Ready to commit <strong>{commitable.length}</strong> row
                {commitable.length === 1 ? "" : "s"}
                {commitable.some((r) => r.status === "probable_duplicate") && (
                  <span className="ml-1 text-amber-700">
                    (includes probable duplicates you confirmed)
                  </span>
                )}
              </div>
              <Button
                onClick={handleCommit}
                disabled={
                  commitLoading ||
                  commitable.length === 0 ||
                  blockedReasons.length > 0
                }
              >
                {commitLoading ? "Committing…" : `Commit ${commitable.length}`}
              </Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  );
}
