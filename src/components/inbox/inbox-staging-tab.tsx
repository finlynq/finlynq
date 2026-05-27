"use client";

/**
 * InboxStagingTab — Manual-lens Staging tab body for /inbox.
 *
 * Lists the user's pending staged imports for the selected account and
 * deep-links each one into the existing two-pane review surface at
 * /import/pending?id=<id>&account=<accountId>. The two-pane experience
 * (FilePane + DbPane + ReconciliationCallout + UnresolvedCategoriesBanner
 * + BalanceWarningBanner + Approve/Discard/Re-apply rules footer + the
 * per-row delete + the SuggestionsGroup) stays at /import/pending so we
 * keep one canonical implementation of the parse-review experience.
 *
 * The /api/import/staged list endpoint doesn't carry account info on each
 * row, so this tab fetches the lightweight list, then resolves the
 * account binding by fetching each batch's detail and reading
 * `staged.boundAccountId`. The detail fetch is hot-cached server-side and
 * returns quickly; deferring this work into a second pass keeps the list
 * fetch snappy for the badge/count case.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { Card, CardContent } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Clock, Inbox, Mail, RefreshCw, Upload } from "lucide-react";

interface StagedRow {
  id: string;
  source: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  totalRowCount: number;
  duplicateCount: number;
  expiresAt: string;
  originalFilename?: string | null;
  fileFormat?: string | null;
}

function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

export function InboxStagingTab({ accountId }: { accountId: number }) {
  const [list, setList] = useState<StagedRow[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  /** Map from staged_import id → account id (resolved via detail fetch). */
  const [bindings, setBindings] = useState<Record<string, number | null>>({});

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

  useEffect(() => {
    void loadList();
  }, [loadList]);

  // Resolve each batch's bound-account in parallel so we can filter the
  // list down to the currently-selected account. Skip refetches for
  // batches we've already resolved this session.
  useEffect(() => {
    if (!list || list.length === 0) return;
    const unresolved = list.filter((r) => !(r.id in bindings));
    if (unresolved.length === 0) return;
    let cancelled = false;
    void (async () => {
      const next: Record<string, number | null> = {};
      await Promise.all(
        unresolved.map(async (row) => {
          try {
            const res = await fetch(`/api/import/staged/${row.id}`);
            if (!res.ok) {
              next[row.id] = null;
              return;
            }
            const detail = await res.json();
            next[row.id] = detail?.staged?.boundAccountId ?? null;
          } catch {
            next[row.id] = null;
          }
        }),
      );
      if (cancelled) return;
      setBindings((prev) => ({ ...prev, ...next }));
    })();
    return () => {
      cancelled = true;
    };
  }, [list, bindings]);

  const filtered = useMemo(() => {
    if (!list) return null;
    // Batches whose bound account hasn't resolved yet are also surfaced
    // (null binding) — better to over-include than hide pending work.
    return list.filter((r) => {
      const b = bindings[r.id];
      return b === undefined || b === null || b === accountId;
    });
  }, [list, bindings, accountId]);

  if (loading && !list) {
    return (
      <Card>
        <CardContent className="py-8 text-sm text-muted-foreground text-center">
          Loading staged imports…
        </CardContent>
      </Card>
    );
  }

  if (error) {
    return (
      <div className="rounded-md border border-rose-200 bg-rose-50 p-3 text-sm text-rose-800">
        {error}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <div className="rounded-md border border-amber-500/30 bg-amber-500/5 px-3 py-2.5 text-xs flex items-center justify-between gap-2">
        <span>
          Staged imports waiting for parse review. Click a batch to open the
          two-pane staging surface for approve / discard / re-apply rules.
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

      {filtered && filtered.length === 0 && (
        <Card>
          <CardContent className="py-12 text-center space-y-3">
            <Inbox className="h-10 w-10 text-muted-foreground mx-auto" />
            <div>
              <p className="text-sm font-medium">Nothing staged for this account</p>
              <p className="text-xs text-muted-foreground mt-1">
                Upload a CSV/OFX/QFX statement or forward a bank statement to
                your import address — both land here for review.
              </p>
            </div>
          </CardContent>
        </Card>
      )}

      {filtered && filtered.length > 0 && (
        <div className="space-y-3">
          {filtered.map((row) => {
            const isUpload = row.source === "upload";
            const Icon = isUpload ? Upload : Mail;
            const headline = isUpload
              ? row.originalFilename || "Uploaded file"
              : row.subject || "(no subject)";
            const subline = isUpload
              ? `${(row.fileFormat ?? "file").toUpperCase()} upload · ${new Date(
                  row.receivedAt,
                ).toLocaleString()}`
              : `from ${row.fromAddress || "(unknown)"} · received ${new Date(
                  row.receivedAt,
                ).toLocaleString()}`;
            return (
              <Link
                key={row.id}
                href={`/import/pending?id=${encodeURIComponent(row.id)}&account=${accountId}`}
                className="block"
              >
                <Card className="cursor-pointer hover:border-primary/50 transition-colors">
                  <CardContent className="py-4">
                    <div className="flex items-start justify-between gap-4">
                      <div className="flex-1 min-w-0">
                        <div className="flex items-center gap-2 mb-1">
                          <Icon className="h-4 w-4 text-muted-foreground shrink-0" />
                          <p className="text-sm font-medium truncate">
                            {headline}
                          </p>
                        </div>
                        <p className="text-xs text-muted-foreground truncate">
                          {subline}
                        </p>
                      </div>
                      <div className="flex items-center gap-2 shrink-0">
                        <Badge variant="outline" className="font-mono">
                          {row.totalRowCount}{" "}
                          {row.totalRowCount === 1 ? "row" : "rows"}
                        </Badge>
                        {row.duplicateCount > 0 && (
                          <Badge
                            variant="outline"
                            className="bg-amber-50 text-amber-700 border-amber-200"
                          >
                            {row.duplicateCount} dupe
                            {row.duplicateCount === 1 ? "" : "s"}
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
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
