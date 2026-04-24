"use client";

import { useCallback, useEffect, useState } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import { AlertCircle, CheckCircle2, KeyRound, Loader2, Link as LinkIcon, RefreshCw } from "lucide-react";
import type { RawTransaction } from "@/lib/import-pipeline";
import { ImportPreviewDialog } from "./import-preview-dialog";
import { ConnectorMappingDialog, type MappingDialogState } from "./connector-mapping-dialog";
import { ConnectorReconciliationDialog } from "./connector-reconciliation-dialog";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

interface ProbeResponse {
  external: {
    accounts: Array<{ id: string; name: string; type: string; currency: string; groupName?: string }>;
    categories: Array<{ id: string; name: string; type: string; groupName?: string }>;
    sampleTransactions: unknown[];
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

interface PreviewResponse {
  preview: {
    valid: PreviewRow[];
    duplicates: PreviewRow[];
    errors: Array<{ rowIndex: number; message: string }>;
  };
  splits: Array<{ externalId: string; parent: RawTransaction; splits: unknown[] }>;
  transformErrors: Array<{ externalId: string; reason: string }>;
  externalTotal: number;
  confirmationToken: string;
  syncWatermark: string;
}

type Stage =
  | "loading"
  | "no-creds"
  | "saving-creds"
  | "has-creds"
  | "probing"
  | "mapping"
  | "previewing"
  | "preview-ready"
  | "executing"
  | "executed"
  | "reconciling";

export function ConnectorTab() {
  const [stage, setStage] = useState<Stage>("loading");
  const [apiKey, setApiKey] = useState("");
  const [errorMessage, setErrorMessage] = useState<string | null>(null);
  const [credsPresent, setCredsPresent] = useState<boolean | null>(null);
  const [probeData, setProbeData] = useState<ProbeResponse | null>(null);
  const [mappingState, setMappingState] = useState<MappingDialogState | null>(null);
  const [mappingOpen, setMappingOpen] = useState(false);
  const [previewResponse, setPreviewResponse] = useState<PreviewResponse | null>(null);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [executeSummary, setExecuteSummary] = useState<{
    imported: number;
    skipped: number;
    splitsInserted: number;
    splitInsertErrors: Array<{ externalId: string; reason: string }>;
    transformErrors: Array<{ externalId: string; reason: string }>;
  } | null>(null);
  const [reconcileOpen, setReconcileOpen] = useState(false);

  // On mount, check whether creds are saved.
  useEffect(() => {
    fetch("/api/import/connectors/wealthposition/credentials")
      .then((r) => r.json())
      .then((d) => {
        setCredsPresent(!!d.present);
        setStage(d.present ? "has-creds" : "no-creds");
      })
      .catch(() => {
        setCredsPresent(false);
        setStage("no-creds");
      });
  }, []);

  const saveApiKey = useCallback(async () => {
    setStage("saving-creds");
    setErrorMessage(null);
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
      setStage("has-creds");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Failed to save");
      setStage("no-creds");
    }
  }, [apiKey]);

  const deleteApiKey = useCallback(async () => {
    setErrorMessage(null);
    await fetch("/api/import/connectors/wealthposition/credentials", { method: "DELETE" });
    setCredsPresent(false);
    setStage("no-creds");
    setProbeData(null);
    setMappingState(null);
    setPreviewResponse(null);
    setExecuteSummary(null);
  }, []);

  const probe = useCallback(async () => {
    setStage("probing");
    setErrorMessage(null);
    try {
      const res = await fetch("/api/import/connectors/wealthposition/probe");
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as ProbeResponse;
      setProbeData(data);
      // Default mapping state: auto-create everything that isn't already mapped.
      setMappingState({
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
      setMappingOpen(true);
      setStage("mapping");
    } catch (err) {
      setErrorMessage(err instanceof Error ? err.message : "Probe failed");
      setStage("has-creds");
    }
  }, []);

  const runPreview = useCallback(
    async (state: MappingDialogState) => {
      if (!probeData) return;
      setMappingState(state);
      setMappingOpen(false);
      setStage("previewing");
      setErrorMessage(null);

      const accountsInput = probeData.external.accounts.map((a) => {
        const override = state.accountOverrides[a.id];
        if (override) return { externalId: a.id, finlynqId: override };
        if (state.accountAutoCreateByDefault) {
          return {
            externalId: a.id,
            autoCreate: {
              name: a.name,
              type: a.type,
              group: a.groupName ?? "",
              currency: a.currency,
            },
          };
        }
        return { externalId: a.id }; // unmapped; will error at transform time
      });
      const categoriesInput = probeData.external.categories.map((c) => {
        const override = state.categoryOverrides[c.id];
        if (override !== undefined) {
          if (override === null) return { externalId: c.id, uncategorized: true };
          return { externalId: c.id, finlynqId: override };
        }
        if (state.categoryAutoCreateByDefault) {
          return {
            externalId: c.id,
            autoCreate: {
              name: c.name,
              type: c.type,
              group: c.groupName ?? "",
            },
          };
        }
        return { externalId: c.id, uncategorized: true };
      });

      const body = {
        accounts: accountsInput,
        categories: categoriesInput,
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

      try {
        const res = await fetch("/api/import/connectors/wealthposition/preview", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as PreviewResponse;
        setPreviewResponse(data);
        setPreviewOpen(true);
        setStage("preview-ready");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Preview failed");
        setStage("has-creds");
      }
    },
    [probeData],
  );

  const runExecute = useCallback(
    async (_rows: RawTransaction[], forceImportIndices: number[]) => {
      if (!previewResponse || !mappingState || !probeData) return;
      setStage("executing");
      setPreviewOpen(false);
      setErrorMessage(null);

      // Rebuild the same mapping body as the preview.
      const accountsInput = probeData.external.accounts.map((a) => {
        const override = mappingState.accountOverrides[a.id];
        if (override) return { externalId: a.id, finlynqId: override };
        if (mappingState.accountAutoCreateByDefault)
          return {
            externalId: a.id,
            autoCreate: { name: a.name, type: a.type, group: a.groupName ?? "", currency: a.currency },
          };
        return { externalId: a.id };
      });
      const categoriesInput = probeData.external.categories.map((c) => {
        const override = mappingState.categoryOverrides[c.id];
        if (override !== undefined) {
          if (override === null) return { externalId: c.id, uncategorized: true };
          return { externalId: c.id, finlynqId: override };
        }
        if (mappingState.categoryAutoCreateByDefault)
          return { externalId: c.id, autoCreate: { name: c.name, type: c.type, group: c.groupName ?? "" } };
        return { externalId: c.id, uncategorized: true };
      });

      try {
        const res = await fetch("/api/import/connectors/wealthposition/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            confirmationToken: previewResponse.confirmationToken,
            forceImportIndices,
            mapping: {
              accounts: accountsInput,
              categories: categoriesInput,
              transferCategoryId: mappingState.transferCategoryId,
              transferCategoryAutoCreate:
                mappingState.transferCategoryId === null && mappingState.transferAutoCreateName
                  ? { name: mappingState.transferAutoCreateName, group: "Transfers" }
                  : undefined,
              openingBalanceCategoryId: mappingState.openingBalanceCategoryId,
              openingBalanceCategoryAutoCreate:
                mappingState.openingBalanceCategoryId === null &&
                mappingState.openingBalanceAutoCreateName
                  ? { name: mappingState.openingBalanceAutoCreateName, group: "System" }
                  : undefined,
              startDate: mappingState.startDate || undefined,
            },
          }),
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const data = await res.json();
        setExecuteSummary({
          imported: data.import.imported,
          skipped: data.import.skippedDuplicates,
          splitsInserted: data.splitsInserted,
          splitInsertErrors: data.splitInsertErrors ?? [],
          transformErrors: data.transformErrors ?? [],
        });
        setStage("executed");
      } catch (err) {
        setErrorMessage(err instanceof Error ? err.message : "Sync failed");
        setStage("preview-ready");
        setPreviewOpen(true);
      }
    },
    [mappingState, previewResponse, probeData],
  );

  if (stage === "loading") {
    return (
      <div className="flex items-center gap-2 p-6 text-sm text-muted-foreground">
        <Loader2 className="h-4 w-4 animate-spin" />
        Loading connector status…
      </div>
    );
  }

  return (
    <div className="space-y-4 mt-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <LinkIcon className="h-4 w-4" />
            WealthPosition
          </CardTitle>
          <CardDescription>
            Pull all of your WealthPosition transactions into Finlynq using your API key.
            Your key is encrypted at rest with your account password.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {errorMessage && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
              <div className="flex-1">{errorMessage}</div>
            </div>
          )}

          {stage === "no-creds" || stage === "saving-creds" ? (
            <div className="space-y-2">
              <Label htmlFor="wp-api-key" className="flex items-center gap-1.5">
                <KeyRound className="h-3.5 w-3.5" /> WealthPosition API key
              </Label>
              <Input
                id="wp-api-key"
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="Paste your key from wealthposition.com → Profile → Security → Developer API"
                disabled={stage === "saving-creds"}
              />
              <div className="flex gap-2">
                <Button onClick={saveApiKey} disabled={stage === "saving-creds" || !apiKey.trim()}>
                  {stage === "saving-creds" && <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />}
                  Save key
                </Button>
              </div>
            </div>
          ) : (
            <div className="flex flex-wrap items-center gap-2">
              <Badge variant="secondary">
                <CheckCircle2 className="h-3 w-3 mr-1" />
                API key on file
              </Badge>
              <Button
                variant="outline"
                size="sm"
                onClick={probe}
                disabled={stage === "probing" || stage === "previewing" || stage === "executing"}
              >
                {stage === "probing" ? (
                  <>
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" /> Probing…
                  </>
                ) : (
                  <>
                    <RefreshCw className="h-3.5 w-3.5 mr-1.5" />
                    {probeData ? "Re-probe" : "Connect & preview"}
                  </>
                )}
              </Button>
              <Button variant="ghost" size="sm" onClick={deleteApiKey}>
                Remove key
              </Button>
            </div>
          )}

          {probeData && (
            <div className="rounded-md border bg-muted/30 p-3 text-xs space-y-1 font-mono">
              <div>{probeData.external.accounts.length} WealthPosition accounts</div>
              <div>{probeData.external.categories.length} WealthPosition categories</div>
              {probeData.mapping.lastSyncedAt && (
                <div className="text-muted-foreground">
                  Last synced: {new Date(probeData.mapping.lastSyncedAt).toLocaleString()}
                </div>
              )}
            </div>
          )}

          {executeSummary && (
            <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 text-sm space-y-1">
              <div className="font-medium flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Sync complete
              </div>
              <div className="text-xs text-muted-foreground space-y-0.5 font-mono">
                <div>Imported: {executeSummary.imported}</div>
                <div>Skipped duplicates: {executeSummary.skipped}</div>
                <div>Splits inserted: {executeSummary.splitsInserted}</div>
                {executeSummary.splitInsertErrors.length > 0 && (
                  <div className="text-destructive">
                    Split insert errors: {executeSummary.splitInsertErrors.length}
                  </div>
                )}
                {executeSummary.transformErrors.length > 0 && (
                  <div className="text-amber-600 dark:text-amber-400">
                    Skipped exotic shapes: {executeSummary.transformErrors.length}
                  </div>
                )}
              </div>
              <div className="pt-2">
                <Button size="sm" variant="outline" onClick={() => setReconcileOpen(true)}>
                  Reconcile balances
                </Button>
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      {probeData && mappingState && (
        <ConnectorMappingDialog
          open={mappingOpen}
          onOpenChange={setMappingOpen}
          probe={probeData}
          state={mappingState}
          onConfirm={runPreview}
        />
      )}

      {previewResponse && (
        <ImportPreviewDialog
          open={previewOpen}
          onOpenChange={setPreviewOpen}
          validRows={previewResponse.preview.valid}
          duplicateRows={previewResponse.preview.duplicates}
          errorRows={previewResponse.preview.errors}
          onConfirm={runExecute}
          isImporting={stage === "executing"}
        />
      )}

      <ConnectorReconciliationDialog open={reconcileOpen} onOpenChange={setReconcileOpen} />
    </div>
  );
}
