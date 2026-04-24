"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  AlertCircle,
  CheckCircle2,
  FileArchive,
  KeyRound,
  Loader2,
  Link as LinkIcon,
  Upload,
} from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";
import { ImportPreviewDialog } from "./import-preview-dialog";
import { ConnectorMappingDialog, type MappingDialogState } from "./connector-mapping-dialog";
import { ConnectorReconciliationDialog } from "./connector-reconciliation-dialog";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

interface ZipProbeResponse {
  external: {
    accounts: Array<{ id: string; name: string; type: string; currency: string; groupName?: string }>;
    categories: Array<{ id: string; name: string; type: string; groupName?: string }>;
    portfolio: Array<{ holding: string; brokerageAccount: string; symbol: string | null; currency: string }>;
    sampleTransactions: unknown[];
    transactionsTotal: number;
  };
  finlynq: {
    accounts: Array<{ id: number; name: string; type: string; currency: string; group: string }>;
    categories: Array<{ id: number; name: string; type: string; group: string }>;
  };
  mapping: {
    accountMap: Record<string, number>;
    categoryMap: Record<string, number | null>;
    transferCategoryId: number | null;
    openingBalanceCategoryId: number | null;
    lastSyncedAt: string | null;
  };
}

interface ZipPreviewResponse {
  preview: {
    valid: PreviewRow[];
    duplicates: PreviewRow[];
    errors: Array<{ rowIndex: number; message: string }>;
  };
  splits: Array<{ externalId: string; parent: RawTransaction; splits: unknown[] }>;
  transformErrors: Array<{ externalId: string; reason: string }>;
  externalTotal: number;
  confirmationToken: string;
}

type ZipStage = "idle" | "probing" | "mapping" | "previewing" | "preview-ready" | "executing" | "executed";

export function ConnectorTab() {
  // ---------- ZIP flow state ----------
  const [zipFile, setZipFile] = useState<File | null>(null);
  const [zipStage, setZipStage] = useState<ZipStage>("idle");
  const [zipError, setZipError] = useState<string | null>(null);
  const [zipProbe, setZipProbe] = useState<ZipProbeResponse | null>(null);
  const [zipMapping, setZipMapping] = useState<MappingDialogState | null>(null);
  const [zipMappingOpen, setZipMappingOpen] = useState(false);
  const [zipPreview, setZipPreview] = useState<ZipPreviewResponse | null>(null);
  const [zipPreviewOpen, setZipPreviewOpen] = useState(false);
  const [zipSummary, setZipSummary] = useState<{
    imported: number; skipped: number; splitsInserted: number;
    splitInsertErrors: Array<{ externalId: string; reason: string }>;
    transformErrors: Array<{ externalId: string; reason: string }>;
    portfolioHoldingsInserted: number;
    reconciliation: {
      date: string;
      rows: Array<{ accountName: string; currency: string; wpBalance: number; pfBalance: number; diff: number; matches: boolean; finlynqAccountId: number }>;
      unmatchedExternal: string[];
    } | null;
    reconciliationError: string | null;
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // ---------- API-key flow state (for reconciliation) ----------
  const [credsPresent, setCredsPresent] = useState<boolean | null>(null);
  const [apiKey, setApiKey] = useState("");
  const [credsBusy, setCredsBusy] = useState(false);
  const [credsError, setCredsError] = useState<string | null>(null);

  const [reconcileOpen, setReconcileOpen] = useState(false);

  useEffect(() => {
    fetch("/api/import/connectors/wealthposition/credentials")
      .then((r) => r.json())
      .then((d) => setCredsPresent(!!d.present))
      .catch(() => setCredsPresent(false));
  }, []);

  // -----------------------------------------------------------
  // ZIP path
  // -----------------------------------------------------------

  const onFileChosen = useCallback((file: File | null) => {
    setZipFile(file);
    setZipError(null);
    setZipProbe(null);
    setZipPreview(null);
    setZipSummary(null);
    setZipStage("idle");
  }, []);

  const runZipProbe = useCallback(async () => {
    if (!zipFile) return;
    setZipStage("probing");
    setZipError(null);
    try {
      const fd = new FormData();
      fd.append("file", zipFile);
      const res = await fetch("/api/import/connectors/wealthposition/zip-probe", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ZipProbeResponse;
      setZipProbe(data);
      setZipMapping({
        accountAutoCreateByDefault: true,
        categoryAutoCreateByDefault: true,
        accountOverrides: { ...data.mapping.accountMap },
        categoryOverrides: { ...data.mapping.categoryMap },
        transferCategoryId: data.mapping.transferCategoryId,
        transferAutoCreateName: "Transfers",
        openingBalanceCategoryId: data.mapping.openingBalanceCategoryId,
        openingBalanceAutoCreateName: "Opening Balance",
        startDate: "",
      });
      setZipMappingOpen(true);
      setZipStage("mapping");
    } catch (err) {
      setZipError(err instanceof Error ? err.message : "Probe failed");
      setZipStage("idle");
    }
  }, [zipFile]);

  const buildMappingBody = useCallback((state: MappingDialogState, probe: ZipProbeResponse) => {
    const accounts = probe.external.accounts.map((a) => {
      const override = state.accountOverrides[a.id];
      if (override) return { externalId: a.id, finlynqId: override };
      if (state.accountAutoCreateByDefault) {
        return {
          externalId: a.id,
          autoCreate: { name: a.name, type: a.type, group: a.groupName ?? "", currency: a.currency },
        };
      }
      return { externalId: a.id };
    });
    const categories = probe.external.categories.map((c) => {
      const override = state.categoryOverrides[c.id];
      if (override !== undefined) {
        if (override === null) return { externalId: c.id, uncategorized: true };
        return { externalId: c.id, finlynqId: override };
      }
      if (state.categoryAutoCreateByDefault) {
        return { externalId: c.id, autoCreate: { name: c.name, type: c.type, group: c.groupName ?? "" } };
      }
      return { externalId: c.id, uncategorized: true };
    });
    return {
      accounts,
      categories,
      transferCategoryId: state.transferCategoryId,
      transferCategoryAutoCreate:
        state.transferCategoryId === null && state.transferAutoCreateName
          ? { name: state.transferAutoCreateName, group: "Transfers" }
          : undefined,
      openingBalanceCategoryId: state.openingBalanceCategoryId,
      openingBalanceCategoryAutoCreate:
        state.openingBalanceCategoryId === null && state.openingBalanceAutoCreateName
          ? { name: state.openingBalanceAutoCreateName, group: "System" }
          : undefined,
      startDate: state.startDate || undefined,
    };
  }, []);

  const runZipPreview = useCallback(
    async (state: MappingDialogState) => {
      if (!zipProbe || !zipFile) return;
      setZipMapping(state);
      setZipMappingOpen(false);
      setZipStage("previewing");
      setZipError(null);
      try {
        const fd = new FormData();
        fd.append("file", zipFile);
        fd.append("mapping", JSON.stringify(buildMappingBody(state, zipProbe)));
        const res = await fetch("/api/import/connectors/wealthposition/zip-preview", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as ZipPreviewResponse;
        setZipPreview(data);
        setZipPreviewOpen(true);
        setZipStage("preview-ready");
      } catch (err) {
        setZipError(err instanceof Error ? err.message : "Preview failed");
        setZipStage("idle");
      }
    },
    [zipFile, zipProbe, buildMappingBody],
  );

  const runZipExecute = useCallback(
    async (_rows: RawTransaction[], forceImportIndices: number[]) => {
      if (!zipPreview || !zipMapping || !zipProbe || !zipFile) return;
      setZipStage("executing");
      setZipPreviewOpen(false);
      setZipError(null);
      try {
        const fd = new FormData();
        fd.append("file", zipFile);
        fd.append(
          "payload",
          JSON.stringify({
            confirmationToken: zipPreview.confirmationToken,
            forceImportIndices,
            mapping: buildMappingBody(zipMapping, zipProbe),
          }),
        );
        const res = await fetch("/api/import/connectors/wealthposition/zip-execute", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        setZipSummary({
          imported: data.import.imported,
          skipped: data.import.skippedDuplicates,
          splitsInserted: data.splitsInserted,
          splitInsertErrors: data.splitInsertErrors ?? [],
          transformErrors: data.transformErrors ?? [],
          portfolioHoldingsInserted: data.portfolioHoldingsInserted ?? 0,
          reconciliation: data.reconciliation ?? null,
          reconciliationError: data.reconciliationError ?? null,
        });
        setZipStage("executed");
      } catch (err) {
        setZipError(err instanceof Error ? err.message : "Sync failed");
        setZipStage("preview-ready");
        setZipPreviewOpen(true);
      }
    },
    [zipFile, zipMapping, zipPreview, zipProbe, buildMappingBody],
  );

  // -----------------------------------------------------------
  // API-key flow (for reconciliation only in the new UX)
  // -----------------------------------------------------------

  const saveApiKey = useCallback(async () => {
    setCredsBusy(true);
    setCredsError(null);
    try {
      const res = await fetch("/api/import/connectors/wealthposition/credentials", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ apiKey: apiKey.trim() }),
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      setCredsPresent(true);
      setApiKey("");
    } catch (err) {
      setCredsError(err instanceof Error ? err.message : "Failed to save key");
    } finally {
      setCredsBusy(false);
    }
  }, [apiKey]);

  const deleteApiKey = useCallback(async () => {
    await fetch("/api/import/connectors/wealthposition/credentials", { method: "DELETE" });
    setCredsPresent(false);
  }, []);

  // -----------------------------------------------------------
  // Render
  // -----------------------------------------------------------

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4" />
            WealthPosition
          </CardTitle>
          <CardDescription>
            Migrate your WealthPosition data to Finlynq. Upload your export ZIP
            to import transactions, then (optionally) save an API key for
            balance reconciliation.
          </CardDescription>
        </CardHeader>

        <CardContent className="space-y-6">
          {/* ---------------- Section 1: ZIP Upload ---------------- */}
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <FileArchive className="h-4 w-4" />
              <h3 className="text-sm font-medium">1. Import your transactions</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Download your export from{" "}
              <span className="font-mono">wealthposition.com → Profile → Export</span>{" "}
              and upload the ZIP here. Every transaction is imported with its
              holding / quantity preserved — no rate limits, no API key needed.
            </p>

            {zipError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                <div className="flex-1">{zipError}</div>
              </div>
            )}

            <div className="flex flex-wrap items-center gap-2">
              <input
                ref={fileInputRef}
                type="file"
                accept=".zip,application/zip"
                className="hidden"
                onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
              />
              <Button variant="outline" size="sm" onClick={() => fileInputRef.current?.click()}>
                <Upload className="h-3.5 w-3.5 mr-1.5" />
                {zipFile ? "Choose a different file" : "Choose ZIP file"}
              </Button>
              {zipFile && (
                <>
                  <Badge variant="secondary" className="font-mono text-xs">
                    {zipFile.name} ({Math.round(zipFile.size / 1024)} KB)
                  </Badge>
                  <Button
                    size="sm"
                    onClick={runZipProbe}
                    disabled={zipStage === "probing" || zipStage === "previewing" || zipStage === "executing"}
                  >
                    {zipStage === "probing" && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    {zipStage === "previewing" && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    {zipStage === "executing" && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                    {zipStage === "executed" ? "Re-import" : "Preview import"}
                  </Button>
                </>
              )}
            </div>

            {zipProbe && (
              <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1 font-mono">
                <div>{zipProbe.external.accounts.length} accounts · {zipProbe.external.categories.length} categories · {zipProbe.external.portfolio.length} portfolio holdings</div>
                <div>{zipProbe.external.transactionsTotal.toLocaleString()} transactions</div>
              </div>
            )}

            {zipSummary && (
              <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 text-sm space-y-3">
                <div>
                  <div className="font-medium flex items-center gap-1.5">
                    <CheckCircle2 className="h-4 w-4 text-green-600" />
                    Import complete
                  </div>
                  <div className="text-xs text-muted-foreground space-y-0.5 font-mono mt-1">
                    <div>Imported: {zipSummary.imported}</div>
                    <div>Skipped duplicates: {zipSummary.skipped}</div>
                    <div>Splits inserted: {zipSummary.splitsInserted}</div>
                    <div>Portfolio holdings added: {zipSummary.portfolioHoldingsInserted}</div>
                    {zipSummary.splitInsertErrors.length > 0 && (
                      <div className="text-destructive">Split insert errors: {zipSummary.splitInsertErrors.length}</div>
                    )}
                    {zipSummary.transformErrors.length > 0 && (
                      <div className="text-amber-600 dark:text-amber-400">
                        Transform warnings: {zipSummary.transformErrors.length}
                      </div>
                    )}
                  </div>
                </div>

                {zipSummary.reconciliation && (
                  <div className="pt-2 border-t border-green-500/20 space-y-2">
                    <div className="text-xs font-medium">Balance reconciliation (as of {zipSummary.reconciliation.date})</div>
                    <div className="max-h-56 overflow-y-auto">
                      <table className="w-full text-xs font-mono">
                        <thead className="text-muted-foreground text-left">
                          <tr>
                            <th className="pb-1">Account</th>
                            <th className="pb-1 text-right">WP</th>
                            <th className="pb-1 text-right">Finlynq</th>
                            <th className="pb-1 text-right">Diff</th>
                          </tr>
                        </thead>
                        <tbody>
                          {zipSummary.reconciliation.rows.map((r) => (
                            <tr key={r.finlynqAccountId} className={r.matches ? "" : "text-amber-700 dark:text-amber-400"}>
                              <td className="py-0.5 pr-2">{r.accountName} <span className="text-muted-foreground">{r.currency}</span></td>
                              <td className="py-0.5 text-right">{r.wpBalance.toFixed(2)}</td>
                              <td className="py-0.5 text-right">{r.pfBalance.toFixed(2)}</td>
                              <td className="py-0.5 text-right">{r.matches ? "✓" : r.diff.toFixed(2)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                    <div className="pt-1">
                      <Button size="sm" variant="outline" onClick={() => setReconcileOpen(true)}>
                        Open reconciliation dialog (adjust opening balances)
                      </Button>
                    </div>
                  </div>
                )}
                {!zipSummary.reconciliation && !zipSummary.reconciliationError && (
                  <div className="pt-2 border-t border-green-500/20 text-xs text-muted-foreground">
                    Save your API key below to reconcile balances against WealthPosition&rsquo;s live data.
                  </div>
                )}
                {zipSummary.reconciliationError && (
                  <div className="pt-2 border-t border-green-500/20 text-xs text-amber-700 dark:text-amber-400">
                    Reconciliation failed: {zipSummary.reconciliationError}
                  </div>
                )}
              </div>
            )}
          </div>

          {/* ---------------- Section 2: API key for reconciliation ---------------- */}
          <div className="space-y-3 pt-2 border-t">
            <div className="flex items-center gap-2">
              <KeyRound className="h-4 w-4" />
              <h3 className="text-sm font-medium">2. Save API key for balance reconciliation (optional)</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              The export ZIP doesn&rsquo;t include opening balances. After
              importing, save your WealthPosition API key to reconcile each
              account&rsquo;s Finlynq sum against WP&rsquo;s live balance.
            </p>

            {credsError && (
              <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
                <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
                <div className="flex-1">{credsError}</div>
              </div>
            )}

            {credsPresent ? (
              <div className="flex flex-wrap items-center gap-2">
                <Badge variant="secondary">
                  <CheckCircle2 className="h-3 w-3 mr-1" />
                  API key on file
                </Badge>
                <Button size="sm" variant="outline" onClick={() => setReconcileOpen(true)} disabled={!zipSummary}>
                  Reconcile balances
                </Button>
                <Button size="sm" variant="ghost" onClick={deleteApiKey}>
                  Remove key
                </Button>
                {!zipSummary && (
                  <span className="text-xs text-muted-foreground">Import transactions first.</span>
                )}
              </div>
            ) : (
              <div className="space-y-2">
                <Label htmlFor="wp-api-key" className="text-xs">API key</Label>
                <Input
                  id="wp-api-key"
                  type="password"
                  value={apiKey}
                  onChange={(e) => setApiKey(e.target.value)}
                  placeholder="Paste your key from wealthposition.com → Profile → Security → Developer API"
                  disabled={credsBusy}
                />
                <Button onClick={saveApiKey} disabled={credsBusy || !apiKey.trim()} size="sm">
                  {credsBusy && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save key
                </Button>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {zipProbe && zipMapping && (
        <ConnectorMappingDialog
          open={zipMappingOpen}
          onOpenChange={setZipMappingOpen}
          probe={zipProbe}
          state={zipMapping}
          onConfirm={runZipPreview}
        />
      )}

      {zipPreview && (
        <ImportPreviewDialog
          open={zipPreviewOpen}
          onOpenChange={setZipPreviewOpen}
          validRows={zipPreview.preview.valid}
          duplicateRows={zipPreview.preview.duplicates}
          errorRows={zipPreview.preview.errors}
          onConfirm={runZipExecute}
          isImporting={zipStage === "executing"}
        />
      )}

      <ConnectorReconciliationDialog open={reconcileOpen} onOpenChange={setReconcileOpen} />
    </div>
  );
}
