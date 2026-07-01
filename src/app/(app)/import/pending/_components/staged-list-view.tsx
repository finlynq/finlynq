"use client";

/**
 * Pending-imports list view (FINLYNQ-118 Phase 4).
 *
 * The `openId == null` branch — pending batches; click a card to open the
 * two-pane reconciliation view. Extracted verbatim from import/pending/page.tsx.
 */

import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  ArrowLeft, Inbox, Mail, Upload, Clock, RefreshCw, Hourglass, CheckCircle2, Landmark,
} from "lucide-react";
import { RecentUploadsPanel } from "@/components/reconcile/recent-uploads-panel";
import { daysUntil, type StagedRow } from "../_types";

export function StagedListView({
  list,
  loading,
  error,
  toast,
  loadList,
  openDetail,
  embedded = false,
  accountScope = null,
  onOpenLoadedBatch,
}: {
  list: StagedRow[] | null;
  loading: boolean;
  error: string | null;
  toast: { type: "success" | "error"; msg: string } | null;
  loadList: () => void;
  openDetail: (id: string) => void;
  /** When embedded inside the /import Staging tab, drop the standalone-page
   *  chrome (Back-to-Import link + big "Pending Imports" h1) and show a
   *  lighter inline strip instead — the surrounding tab already provides the
   *  page header + account context. */
  embedded?: boolean;
  /** The account this embedded surface is scoped to. Drives the
   *  "pending to be loaded" summary + the Loaded (processed) section below
   *  the pending list. Null in route mode (cross-account /import/pending) —
   *  the Loaded section is suppressed there since it needs a single account. */
  accountScope?: number | null;
  /** Clicking a loaded (already-processed) batch calls this with the batch's
   *  source `staged_import_id` (null for simplified/auto batches). The surface
   *  re-opens the staging two-pane review for that import — where the imported
   *  rows persist, highlighted. */
  onOpenLoadedBatch?: (stagedImportId: string | null) => void;
}) {
  // Summary over the (already account-filtered by the parent) pending list.
  // "Rows to load" = the rows that will materialize into the bank ledger on
  // approve — non-duplicate rows. Duplicates are surfaced separately since
  // they can still be force-approved but default to skipped.
  const pending = list ?? [];
  const pendingBatches = pending.length;
  const pendingTotalRows = pending.reduce((s, r) => s + (r.totalRowCount ?? 0), 0);
  const pendingDupes = pending.reduce((s, r) => s + (r.duplicateCount ?? 0), 0);
  const rowsToLoad = pending.reduce(
    (s, r) => s + Math.max(0, (r.totalRowCount ?? 0) - (r.duplicateCount ?? 0)),
    0,
  );

  return (
    <div className={embedded ? "space-y-3" : "space-y-6"}>
      {!embedded && (
        <div className="flex items-center gap-3">
          <Link
            href="/import"
            className="text-sm text-muted-foreground hover:text-foreground inline-flex items-center gap-1"
          >
            <ArrowLeft className="h-4 w-4" />
            Back to Import
          </Link>
        </div>
      )}

      {embedded ? (
        <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs flex items-center justify-between gap-2">
          <span>
            Staged imports for this account waiting for parse review. Click a
            batch to open the two-pane staging surface for approve / discard /
            re-apply rules.
          </span>
          <Button
            variant="outline"
            size="sm"
            onClick={loadList}
            disabled={loading}
            className="h-7"
          >
            <RefreshCw
              className={`h-3.5 w-3.5 mr-1.5 ${loading ? "animate-spin" : ""}`}
            />
            Refresh
          </Button>
        </div>
      ) : (
        <div className="flex items-start justify-between gap-4">
          <div>
            <h1 className="text-2xl font-bold tracking-tight">Pending Imports</h1>
            <p className="text-sm text-muted-foreground mt-0.5">
              Transactions from email forwards or file uploads (CSV / OFX /
              QFX), waiting for your review. Rows auto-expire after 60 days.
            </p>
          </div>
          <Button variant="outline" size="sm" onClick={loadList} disabled={loading}>
            <RefreshCw className={`h-4 w-4 mr-1.5 ${loading ? "animate-spin" : ""}`} />
            Refresh
          </Button>
        </div>
      )}

      {toast && (
        <Card
          className={
            toast.type === "success"
              ? "border-emerald-200 bg-emerald-50/30"
              : "border-rose-200 bg-rose-50/30"
          }
        >
          <CardContent className="py-3 text-sm">{toast.msg}</CardContent>
        </Card>
      )}

      {error && (
        <Card className="border-rose-200 bg-rose-50/30">
          <CardContent className="py-3 text-sm text-rose-700">{error}</CardContent>
        </Card>
      )}

      {/* Pending summary — embedded (account-scoped) Staging tab only. Gives
          the "pending to be loaded" count the route-mode page doesn't need
          (it spans every account). */}
      {embedded && list && (
        <div className="flex flex-wrap items-center gap-2 text-xs">
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1">
            <Hourglass className="h-3.5 w-3.5 text-amber-600" />
            <span className="font-medium">{pendingBatches}</span>
            <span className="text-muted-foreground">
              batch{pendingBatches === 1 ? "" : "es"} pending review
            </span>
          </span>
          <span className="inline-flex items-center gap-1.5 rounded-md border bg-card px-2.5 py-1">
            <span className="font-medium">{rowsToLoad}</span>
            <span className="text-muted-foreground">
              row{rowsToLoad === 1 ? "" : "s"} pending to be loaded
            </span>
          </span>
          {pendingDupes > 0 && (
            <span className="inline-flex items-center gap-1.5 rounded-md border border-amber-200 bg-amber-50 px-2.5 py-1 text-amber-700">
              <span className="font-medium">{pendingDupes}</span>
              <span>duplicate{pendingDupes === 1 ? "" : "s"} (skipped by default)</span>
            </span>
          )}
          {pendingTotalRows !== rowsToLoad && (
            <span className="text-muted-foreground">
              · {pendingTotalRows} total parsed
            </span>
          )}
        </div>
      )}

      {loading && !list && (
        <Card>
          <CardContent className="py-8 text-sm text-muted-foreground text-center">
            Loading…
          </CardContent>
        </Card>
      )}

      {!embedded && list && list.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">Nothing pending</p>
              <p className="text-xs text-muted-foreground mt-1">
                Upload a CSV/OFX/QFX statement from the{" "}
                <Link href="/import" className="underline">
                  Import
                </Link>{" "}
                page, or forward a bank statement to your import address — both
                land here for review.
              </p>
            </div>
            <Link href="/import" className="inline-block">
              <Button variant="outline" size="sm">
                View import options
              </Button>
            </Link>
          </CardContent>
        </Card>
      )}

      {/* Embedded empty pending — a light inline note instead of the big
          route-mode card, so the Loaded section below stays visible. */}
      {embedded && list && list.length === 0 && (
        <div className="rounded-md border border-dashed bg-muted/20 px-3 py-4 text-center text-xs text-muted-foreground">
          No imports waiting for review. Processed uploads appear below.
        </div>
      )}

      {list && list.length > 0 && (
        <div className="space-y-3">
          {list.map((row) => {
            // 'connector' (live bank feed, e.g. SimpleFIN) is labeled by its
            // originalFilename ("SimpleFIN — <account>") like an upload — NOT the
            // email subject/from (which are null for a feed → "(no subject)").
            const isEmail = row.source === "email";
            const isConnector = row.source === "connector";
            const Icon = isConnector ? Landmark : isEmail ? Mail : Upload;
            const receivedStr = new Date(row.receivedAt).toLocaleString();
            const headline = isEmail
              ? row.subject || "(no subject)"
              : row.originalFilename || (isConnector ? "Bank feed" : "Uploaded file");
            const subline = isEmail
              ? `from ${row.fromAddress || "(unknown)"} · received ${receivedStr}`
              : isConnector
                ? `Bank feed · synced ${receivedStr}`
                : `${(row.fileFormat ?? "file").toUpperCase()} upload · ${receivedStr}`;
            return (
              <Card
                key={row.id}
                className="cursor-pointer hover:border-primary/50 transition-colors"
                onClick={() => openDetail(row.id)}
              >
                <CardContent className="py-4">
                  <div className="flex items-start justify-between gap-4">
                    <div className="flex-1 min-w-0">
                      <div className="flex items-center gap-2 mb-1">
                        <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                        <p className="text-sm font-medium truncate">{headline}</p>
                      </div>
                      <p className="text-xs text-muted-foreground truncate">{subline}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <Badge variant="outline" className="font-mono">
                        {row.totalRowCount} {row.totalRowCount === 1 ? "row" : "rows"}
                      </Badge>
                      {row.duplicateCount > 0 && (
                        <Badge
                          variant="outline"
                          className="bg-amber-50 text-amber-700 border-amber-200"
                        >
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
            );
          })}
        </div>
      )}

      {/* Loaded (processed) section — embedded Staging tab only. Reuses the
          bank_upload_batches list (every upload that landed rows in the bank
          ledger: simplified-direct OR detailed-via-approve), so a batch the
          user already processed stays visible here instead of vanishing from
          the pending list. Carries its own per-batch summary (rows / anchors /
          current count) + the batch-undo action. */}
      {embedded && accountScope != null && (
        <div className="pt-1">
          <div className="mb-2 flex items-center gap-1.5 text-xs text-muted-foreground">
            <CheckCircle2 className="h-3.5 w-3.5 text-emerald-600" />
            Already processed into the bank ledger
          </div>
          <RecentUploadsPanel
            accountId={accountScope}
            title="Loaded into the bank ledger"
            emptyLabel="No imports have been loaded into the bank ledger for this account yet."
            onChange={loadList}
            onOpenBatch={onOpenLoadedBatch}
          />
        </div>
      )}
    </div>
  );
}
