"use client";

/**
 * UploadDrawer — account-pre-scoped right-side drawer triggered from the
 * /inbox header.
 *
 * Phase 2 of the money-in consolidation: the drawer now performs the upload
 * IN PLACE instead of routing out to /import. It reuses ReconcileUploadCard
 * (with the account locked to the drawer's account) + ColumnMappingDialog and
 * POSTs to the same /api/import/staging/upload endpoint /import/reconcile uses.
 * On success it calls `onUploaded()` so the parent surface refreshes the
 * policy-appropriate tab — the user never leaves /inbox.
 *
 * The upload route branches on the account's POLICY server-side (auto/approve
 * → simplified path → bank_transactions; manual → per-template import_mode →
 * staging or bank). The "After upload" bullets below describe that policy
 * behavior so the user knows where the rows will land.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import { X, CheckCircle2, AlertCircle } from "lucide-react";
import { MODES, type Mode } from "./modes";
import { ReconcileUploadCard } from "@/components/reconcile/upload-card";
import type { AccountOption } from "@/components/reconcile/preview-table";
import {
  ColumnMappingDialog,
  type ReparseResult,
} from "@/app/(app)/import/components/column-mapping-dialog";
import {
  OfxConfirmDialog,
  type OfxPreviewRow,
} from "@/app/(app)/import/components/ofx-confirm-dialog";
import type { ColumnMapping, ImportTemplate } from "@/lib/import-templates";
import { autoDetectColumnMapping } from "@/lib/import-templates";
import { formatCurrency } from "@/lib/currency";

interface AfterUploadBullet {
  body: React.ReactNode;
}

function bulletsForPolicy(policy: Mode): AfterUploadBullet[] {
  if (policy === "auto") {
    return [
      {
        body: (
          <>
            Matched rules →{" "}
            <span className="font-medium text-foreground">Reconciled</span>
          </>
        ),
      },
      {
        body: (
          <>
            Unmatched →{" "}
            <span className="font-medium text-foreground">To categorize</span>
          </>
        ),
      },
    ];
  }
  if (policy === "approve") {
    return [
      {
        body: (
          <>
            Rows land in{" "}
            <span className="font-medium text-foreground">To approve</span>{" "}
            with suggestions
          </>
        ),
      },
    ];
  }
  return [
    {
      body: (
        <>
          Rows land in{" "}
          <span className="font-medium text-foreground">Staging</span>{" "}
          two-pane for parse review
        </>
      ),
    },
    {
      body: (
        <>
          Approved rows move to{" "}
          <span className="font-medium text-foreground">Reconcile</span>{" "}
          two-pane
        </>
      ),
    },
  ];
}

type DateFormatOverrideUi = "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";

interface UploadParams {
  file: File;
  accountId: number | null;
  tolerance: number;
  templateId: number | null;
  statementBalance: number | null;
  skipHeaderRows: number;
  skipFooterRows: number;
  dateFormatOverride: DateFormatOverrideUi;
  defaultCurrency: string | null;
  /** §A (2026-06-04) — OFX/QFX payee source. Undefined for CSV. */
  payeeSource?: "name" | "memo";
  /** §B (2026-06-04) — set after the user confirmed the column mapping in the
   *  dialog, so the route takes the parsed path instead of re-prompting. */
  confirmedMapping?: boolean;
  /** §A (2026-06-04) — set after the user confirmed the OFX/QFX field-mapping
   *  preview, so the route stages instead of returning the preview again. */
  confirmedImport?: boolean;
}

interface UploadResponse {
  stagedImportId: string;
  redirectTo: string;
  format: "csv" | "ofx" | "qfx";
  counts: {
    new?: number;
    existing?: number;
    probableDuplicate?: number;
    skippedDuplicate?: number;
    appended?: number;
    alreadyInBatch?: number;
    errors: number;
  };
  tolerance: number;
  merged?: boolean;
  /** At-upload statement snapshot (restores the old OFX-preview balance
   *  validation): statement balance + date range + parsed-row/anchor counts. */
  statement?: {
    balance: number | null;
    balanceDate: string | null;
    currency: string | null;
    rowCount: number;
    anchorCount: number;
    dateRange: { start: string; end: string } | null;
  };
}

export function UploadDrawer({
  open,
  onOpenChange,
  accountId,
  accountLabel,
  accountCurrency,
  policy,
  ofxPayeeSource = "name",
  // csvMappingMode is enforced server-side (the upload route reads the account
  // column + per-user default to decide confirm-vs-silent). The drawer reads it
  // so it can surface a reset affordance when the account is set to 'auto' —
  // otherwise the preview never reappears and there's no way back from here.
  csvMappingMode = "confirm",
  onUploaded,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  accountId: number;
  accountLabel: string;
  accountCurrency: string;
  policy: Mode;
  /** §A (2026-06-04) — the bound account's saved OFX payee source. Seeds the
   *  "Payee from: Name / Memo" radio on the card. */
  ofxPayeeSource?: "name" | "memo";
  /** §B (2026-06-04) — the bound account's CSV mapping mode. 'confirm' shows
   *  the column-mapping confirm dialog before staging; 'auto' applies the
   *  auto-detected mapping silently (the route enforces this — the prop is
   *  used here only to seed the "Don't ask again" checkbox default state). */
  csvMappingMode?: "confirm" | "auto";
  /** Called after a successful upload so the parent surface can refresh the
   *  policy-appropriate tab. The drawer stays open showing a result panel; the
   *  parent decides when to close it (the "View rows" button calls this). */
  onUploaded: () => void;
}) {
  const cfg = MODES[policy];
  const bullets = bulletsForPolicy(policy);

  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [accountNames, setAccountNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);
  const [result, setResult] = useState<UploadResponse | null>(null);

  // Column-mapping dialog state — mirrors /import/reconcile. Non-canonical
  // CSVs (IBKR etc.) need a column-mapping pass before staging can persist.
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [mappingHeaders, setMappingHeaders] = useState<string[]>([]);
  const [mappingSampleRows, setMappingSampleRows] = useState<
    Record<string, string>[]
  >([]);
  const [mappingSuggested, setMappingSuggested] = useState<ColumnMapping | null>(
    null,
  );
  const [mappingFileName, setMappingFileName] = useState<string>("");
  const [mappingSubmitting, setMappingSubmitting] = useState(false);
  const [pendingFile, setPendingFile] = useState<File | null>(null);
  const [pendingParams, setPendingParams] = useState<Omit<
    UploadParams,
    "file" | "templateId"
  > | null>(null);

  // §A (2026-06-04) — the account's saved OFX payee source, mirrored locally so
  // flipping the radio updates the seed immediately while the PATCH is in
  // flight. Re-seeded from the prop when the account changes.
  const [savedOfxPayeeSource, setSavedOfxPayeeSource] = useState<
    "name" | "memo"
  >(ofxPayeeSource);
  useEffect(() => {
    setSavedOfxPayeeSource(ofxPayeeSource);
  }, [ofxPayeeSource]);

  // Local mirror of the account's confirm/auto import mode so the in-drawer
  // reset (visible when 'auto') updates immediately without a page refetch.
  const [acctCsvMode, setAcctCsvMode] = useState<"confirm" | "auto">(
    csvMappingMode,
  );
  useEffect(() => {
    setAcctCsvMode(csvMappingMode);
  }, [csvMappingMode]);

  // §B (2026-06-04) — distinguishes the confirm-mapping dialog (the new
  // csv-confirm-mapping 422) from the needs-mapping dialog so the dialog can
  // show the "Don't ask again for this account" checkbox + an "Import with
  // this mapping" affordance only in the confirm case.
  const [mappingConfirmMode, setMappingConfirmMode] = useState(false);

  // §A (2026-06-04) — OFX/QFX field-mapping preview dialog state (the
  // `ofx-confirm` 422). Holds the parsed preview + the pending re-upload.
  const [ofxDialogOpen, setOfxDialogOpen] = useState(false);
  const [ofxSubmitting, setOfxSubmitting] = useState(false);
  const [ofxPreview, setOfxPreview] = useState<{
    fileName: string;
    account: string;
    currency: string;
    format: "ofx" | "qfx";
    rows: OfxPreviewRow[];
    rowCount: number;
    statementBalance: number | null;
    statementBalanceDate: string | null;
    payeeSource: "name" | "memo";
  } | null>(null);
  const [ofxPendingFile, setOfxPendingFile] = useState<File | null>(null);
  const [ofxPendingParams, setOfxPendingParams] = useState<Omit<
    UploadParams,
    "file" | "payeeSource" | "confirmedImport"
  > | null>(null);

  const lockedAccount: AccountOption = useMemo(
    () => ({
      id: accountId,
      name: accountLabel,
      currency: accountCurrency,
      isInvestment: false,
    }),
    [accountId, accountLabel, accountCurrency],
  );

  // Load templates + account names when the drawer opens. Account names feed
  // the ColumnMappingDialog's default-account picker; templates feed the card.
  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void Promise.all([
      fetch("/api/import/templates").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([tpls, accts]) => {
        if (cancelled) return;
        if (Array.isArray(tpls)) setTemplates(tpls);
        if (Array.isArray(accts)) {
          setAccountNames(accts.map((a: { name: string }) => a.name));
        }
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [open]);

  // Reset transient state each time the drawer opens or the account changes,
  // so a prior upload's result/error doesn't leak into a fresh session.
  useEffect(() => {
    if (open) {
      setResult(null);
      setError(null);
      setUploadLoading(false);
    }
  }, [open, accountId]);

  // ESC closes the drawer — matches the standard sheet/dialog interaction.
  // Skip while the mapping dialog is open so ESC dismisses the dialog first.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !mappingDialogOpen) onOpenChange(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onOpenChange, mappingDialogOpen]);

  const submitUpload = useCallback(
    async (params: UploadParams) => {
      const {
        file,
        tolerance,
        templateId,
        statementBalance,
        skipHeaderRows,
        skipFooterRows,
        dateFormatOverride,
        defaultCurrency,
        payeeSource,
        confirmedMapping,
        confirmedImport,
      } = params;
      setError(null);
      setUploadLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        // Account is always the drawer's account (locked).
        fd.append("accountId", String(accountId));
        if (templateId) fd.append("templateId", String(templateId));
        fd.append("tolerance", String(tolerance));
        if (statementBalance !== null) {
          fd.append("statementBalance", String(statementBalance));
        }
        if (skipHeaderRows > 0) fd.append("skipHeaderRows", String(skipHeaderRows));
        if (skipFooterRows > 0) fd.append("skipFooterRows", String(skipFooterRows));
        if (dateFormatOverride !== "auto") {
          fd.append("dateFormatOverride", dateFormatOverride);
        }
        if (defaultCurrency) fd.append("defaultCurrency", defaultCurrency);
        // §A — OFX/QFX payee source (server ignores it for CSV).
        if (payeeSource) fd.append("payeeSource", payeeSource);
        // §B — flag the re-fire after the user confirmed a column mapping so
        // the route doesn't re-prompt (belt-and-suspenders alongside templateId).
        if (confirmedMapping) fd.append("confirmedMapping", "1");
        // §A — flag the re-fire after the user confirmed the OFX/QFX preview.
        if (confirmedImport) fd.append("confirmedImport", "1");

        const res = await fetch("/api/import/staging/upload", {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        if (!res.ok) {
          // 422 ofx-confirm (§A) → open the OFX/QFX field-mapping preview.
          if (
            res.status === 422 &&
            json &&
            typeof json === "object" &&
            json.type === "ofx-confirm"
          ) {
            setOfxPreview({
              fileName:
                typeof json.fileName === "string" && json.fileName
                  ? json.fileName
                  : file.name,
              account: typeof json.account === "string" ? json.account : accountLabel,
              currency:
                typeof json.currency === "string" ? json.currency : accountCurrency,
              format: json.format === "qfx" ? "qfx" : "ofx",
              rows: Array.isArray(json.rows) ? (json.rows as OfxPreviewRow[]) : [],
              rowCount:
                typeof json.rowCount === "number"
                  ? json.rowCount
                  : Array.isArray(json.rows)
                    ? json.rows.length
                    : 0,
              statementBalance:
                typeof json.statementBalance === "number"
                  ? json.statementBalance
                  : null,
              statementBalanceDate:
                typeof json.statementBalanceDate === "string"
                  ? json.statementBalanceDate
                  : null,
              payeeSource: json.payeeSource === "memo" ? "memo" : "name",
            });
            setOfxPendingFile(file);
            setOfxPendingParams({
              accountId,
              tolerance,
              templateId,
              statementBalance,
              skipHeaderRows,
              skipFooterRows,
              dateFormatOverride,
              defaultCurrency,
            });
            setOfxDialogOpen(true);
            setUploadLoading(false);
            return;
          }
          // 422 csv-needs-mapping OR csv-confirm-mapping → open the
          // column-mapping dialog. needs-mapping: nothing matched, user must
          // build the mapping. confirm-mapping (§B): a mapping was detected
          // but the account is in 'confirm' mode, so pre-fill it for review.
          // Both flow through the same dialog → save as template → re-fire.
          if (
            res.status === 422 &&
            json &&
            typeof json === "object" &&
            (json.type === "csv-needs-mapping" ||
              json.type === "csv-confirm-mapping")
          ) {
            setMappingConfirmMode(json.type === "csv-confirm-mapping");
            setMappingHeaders(Array.isArray(json.headers) ? json.headers : []);
            setMappingSampleRows(
              Array.isArray(json.sampleRows) ? json.sampleRows : [],
            );
            setMappingSuggested(json.suggestedMapping ?? null);
            setMappingFileName(
              typeof json.fileName === "string" && json.fileName
                ? json.fileName
                : file.name,
            );
            setPendingFile(file);
            setPendingParams({
              accountId,
              tolerance,
              statementBalance,
              skipHeaderRows,
              skipFooterRows,
              dateFormatOverride,
              defaultCurrency,
              payeeSource,
            });
            setMappingDialogOpen(true);
            setUploadLoading(false);
            return;
          }
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const data = json as UploadResponse;
        setResult(data);
        setUploadLoading(false);
        // Tell the parent to refresh the policy-appropriate tab. The drawer
        // stays open showing the result; the user clicks "View rows" to close.
        onUploaded();
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setUploadLoading(false);
      }
    },
    [accountId, accountLabel, accountCurrency, onUploaded],
  );

  // §A/§B (2026-06-04) — persist a per-account import preference. Fire-and-
  // forget: a failed PATCH just means the next upload re-asks/re-defaults; we
  // don't block the upload on it.
  const patchImportPrefs = useCallback(
    async (prefs: {
      ofxPayeeSource?: "name" | "memo";
      csvMappingMode?: "confirm" | "auto";
    }) => {
      try {
        await fetch(`/api/accounts/${accountId}/import-prefs`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(prefs),
        });
      } catch {
        // ignore — non-blocking persistence
      }
    },
    [accountId],
  );

  // Re-detect columns for the column-mapping dialog when the user changes the
  // skip count. Uses the read-only /api/import/preview (noTemplate) so it
  // returns fresh headers/sample/suggestion for the trimmed file WITHOUT
  // staging any rows. Falls back to a client-side auto-detect when the trimmed
  // file now parses canonically (preview returns no suggestion in that case).
  const handleReparse = useCallback(
    async (skipHeaderRows: number, skipFooterRows: number): Promise<ReparseResult> => {
      if (!pendingFile) throw new Error("No file to re-read");
      const fd = new FormData();
      fd.append("file", pendingFile);
      fd.append("noTemplate", "1");
      fd.append("skipHeaderRows", String(skipHeaderRows));
      fd.append("skipFooterRows", String(skipFooterRows));
      const res = await fetch("/api/import/preview", { method: "POST", body: fd });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);
      const headers: string[] = Array.isArray(data.headers) ? data.headers : [];
      const sampleRows: Record<string, string>[] = Array.isArray(data.sampleRows)
        ? data.sampleRows
        : [];
      const suggestedMapping: ColumnMapping | null =
        data.suggestedMapping ?? autoDetectColumnMapping(headers) ?? null;
      return { headers, sampleRows, suggestedMapping };
    },
    [pendingFile],
  );

  const handleMappingConfirm = useCallback(
    async (params: {
      mapping: ColumnMapping;
      defaultAccount: string | null;
      templateName: string;
      skipHeaderRows: number;
      skipFooterRows: number;
      defaultCurrency: string | null;
      dateFormatOverride: string | null;
      headers: string[];
      /** §B — "Don't ask again for this account" → flip csv_mapping_mode to
       *  'auto' so subsequent uploads to this account apply silently. */
      dontAskAgain?: boolean;
    }) => {
      if (!pendingFile || !pendingParams) {
        setMappingDialogOpen(false);
        return;
      }
      setMappingSubmitting(true);
      // §B — persist the per-account auto-vs-ask choice before re-firing
      // (fire-and-forget). The radio is a true setting: 'auto' applies silently
      // next time, 'confirm' keeps showing the preview.
      void patchImportPrefs({
        csvMappingMode: params.dontAskAgain ? "auto" : "confirm",
      });
      try {
        // The dialog's skip / date-format / currency / headers WIN over the
        // upload card's values — the user set them here after seeing the
        // columns, so they're authoritative for both the saved template and
        // the re-fired upload.
        const tplRes = await fetch("/api/import/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: params.templateName,
            fileHeaders: params.headers,
            columnMapping: params.mapping,
            defaultAccount: params.defaultAccount ?? undefined,
            skipHeaderRows: params.skipHeaderRows,
            skipFooterRows: params.skipFooterRows,
            dateFormatOverride: params.dateFormatOverride,
            defaultCurrency: params.defaultCurrency,
          }),
        });
        const saved = await tplRes.json();
        if (!tplRes.ok || !saved?.id) {
          throw new Error(
            (saved && typeof saved.error === "string" ? saved.error : null) ??
              "Failed to save template",
          );
        }
        setTemplates((prev) =>
          prev.find((t) => t.id === saved.id) ? prev : [...prev, saved],
        );

        setMappingDialogOpen(false);
        const file = pendingFile;
        const carried = pendingParams;
        setPendingFile(null);
        setPendingParams(null);

        await submitUpload({
          file,
          accountId: carried.accountId,
          tolerance: carried.tolerance,
          templateId: saved.id as number,
          statementBalance: carried.statementBalance,
          skipHeaderRows: params.skipHeaderRows,
          skipFooterRows: params.skipFooterRows,
          dateFormatOverride: (params.dateFormatOverride ?? "auto") as DateFormatOverrideUi,
          defaultCurrency: params.defaultCurrency,
          payeeSource: carried.payeeSource,
          // The saved template takes the parsed path; the flag is belt-and-
          // suspenders so the route never re-prompts on this re-fire.
          confirmedMapping: true,
        });
      } catch (err) {
        setError(err instanceof Error ? err.message : "Failed to save template");
        setMappingDialogOpen(false);
      } finally {
        setMappingSubmitting(false);
      }
    },
    [pendingFile, pendingParams, submitUpload, patchImportPrefs],
  );

  // §A — the user confirmed the OFX/QFX field-mapping preview. Persist the
  // chosen payee source (+ flip to 'auto' if they opted out of future prompts),
  // then re-upload with confirmedImport=1 so the route stages this time.
  const handleOfxConfirm = useCallback(
    async (confirmParams: {
      payeeSource: "name" | "memo";
      dontAskAgain: boolean;
    }) => {
      if (!ofxPendingFile || !ofxPendingParams) {
        setOfxDialogOpen(false);
        return;
      }
      setOfxSubmitting(true);
      // Persist the chosen payee source + the per-account auto-vs-ask choice.
      setSavedOfxPayeeSource(confirmParams.payeeSource);
      void patchImportPrefs({
        ofxPayeeSource: confirmParams.payeeSource,
        csvMappingMode: confirmParams.dontAskAgain ? "auto" : "confirm",
      });
      const file = ofxPendingFile;
      const carried = ofxPendingParams;
      setOfxDialogOpen(false);
      setOfxPendingFile(null);
      setOfxPendingParams(null);
      try {
        await submitUpload({
          ...carried,
          file,
          payeeSource: confirmParams.payeeSource,
          confirmedImport: true,
        });
      } finally {
        setOfxSubmitting(false);
      }
    },
    [ofxPendingFile, ofxPendingParams, submitUpload, patchImportPrefs],
  );

  const templateOptions = useMemo(
    () =>
      templates.map((t) => ({
        id: t.id,
        name: t.name,
        skipHeaderRows: t.skipHeaderRows,
        skipFooterRows: t.skipFooterRows,
        dateFormatOverride: t.dateFormatOverride,
        defaultCurrency: t.defaultCurrency,
        defaultAccount: t.defaultAccount ?? null,
      })),
    [templates],
  );

  if (!open) return null;

  const c = result?.counts;
  const newCount = (c?.new ?? c?.appended ?? 0) as number;

  return (
    <>
      <div
        className="fixed inset-0 z-40 bg-black/40 backdrop-blur-sm"
        onClick={() => onOpenChange(false)}
      />
      <div className="fixed right-0 top-0 z-50 h-full w-full max-w-md border-l bg-background shadow-2xl flex flex-col">
        <div className="flex items-center justify-between border-b px-5 py-4">
          <div>
            <h2 className="text-base font-semibold">Upload to {accountLabel}</h2>
            <p className="text-xs text-muted-foreground">
              Policy: {cfg.label} · {cfg.gates} gate
              {cfg.gates !== 1 ? "s" : ""}
            </p>
          </div>
          <Button
            size="sm"
            variant="ghost"
            className="h-8 w-8 p-0"
            onClick={() => onOpenChange(false)}
            aria-label="Close upload drawer"
          >
            <X className="h-4 w-4" />
          </Button>
        </div>

        <div className="p-5 space-y-5 flex-1 overflow-y-auto">
          {result ? (
            <div className="space-y-4">
              <div className="rounded-lg border border-emerald-200 bg-emerald-50/40 dark:bg-emerald-950/10 px-4 py-4 text-center">
                <CheckCircle2 className="mx-auto h-7 w-7 text-emerald-600" />
                <p className="mt-2 text-sm font-medium">Upload complete</p>
                <p className="text-xs text-muted-foreground mt-1">
                  {newCount} row{newCount === 1 ? "" : "s"} from your{" "}
                  {result.format.toUpperCase()} added to {accountLabel}
                  {c?.skippedDuplicate
                    ? ` · ${c.skippedDuplicate} duplicate${c.skippedDuplicate === 1 ? "" : "s"} skipped`
                    : ""}
                  {c?.errors ? ` · ${c.errors} error${c.errors === 1 ? "" : "s"}` : ""}
                </p>
              </div>
              {result.statement && (
                <div className="rounded-md border px-3 py-2.5 text-xs space-y-1">
                  <p className="font-medium">Statement snapshot</p>
                  <dl className="space-y-0.5 text-muted-foreground">
                    {result.statement.balance != null && (
                      <div className="flex justify-between gap-3">
                        <dt>Statement balance</dt>
                        <dd className="font-medium text-foreground text-right">
                          {formatCurrency(
                            result.statement.balance,
                            result.statement.currency ?? accountCurrency,
                          )}
                          {result.statement.balanceDate
                            ? ` · ${result.statement.balanceDate}`
                            : ""}
                        </dd>
                      </div>
                    )}
                    {result.statement.dateRange && (
                      <div className="flex justify-between gap-3">
                        <dt>Date range</dt>
                        <dd className="text-right">
                          {result.statement.dateRange.start} →{" "}
                          {result.statement.dateRange.end}
                        </dd>
                      </div>
                    )}
                    <div className="flex justify-between gap-3">
                      <dt>Rows parsed</dt>
                      <dd className="text-right">{result.statement.rowCount}</dd>
                    </div>
                    {result.statement.anchorCount > 0 && (
                      <div className="flex justify-between gap-3">
                        <dt>Balance anchors</dt>
                        <dd className="text-right">
                          {result.statement.anchorCount}
                        </dd>
                      </div>
                    )}
                  </dl>
                </div>
              )}
              <div className={`rounded-md border px-3 py-2.5 text-xs ${cfg.tone}`}>
                <p className="font-medium">Where they landed — {cfg.label}:</p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
                  {bullets.map((b, i) => (
                    <li key={i}>{b.body}</li>
                  ))}
                </ul>
              </div>
            </div>
          ) : (
            <>
              {acctCsvMode === "auto" && (
                <div className="rounded-md border border-amber-200 bg-amber-50/60 dark:bg-amber-950/10 px-3 py-2.5 text-xs">
                  <p className="font-medium text-amber-800 dark:text-amber-300">
                    This account imports automatically
                  </p>
                  <p className="mt-0.5 text-muted-foreground">
                    No field-mapping preview is shown — rows are staged silently
                    using the detected mapping.
                  </p>
                  <Button
                    size="sm"
                    variant="outline"
                    className="mt-2 h-7"
                    onClick={() => {
                      setAcctCsvMode("confirm");
                      void patchImportPrefs({ csvMappingMode: "confirm" });
                    }}
                  >
                    Switch to confirm-first
                  </Button>
                </div>
              )}
              <ReconcileUploadCard
                accounts={[lockedAccount]}
                templates={templateOptions}
                loading={uploadLoading}
                lockedAccount={lockedAccount}
                ofxPayeeSource={savedOfxPayeeSource}
                onOfxPayeeSourceChange={(value) => {
                  setSavedOfxPayeeSource(value);
                  void patchImportPrefs({ ofxPayeeSource: value });
                }}
                onUpload={(params) => void submitUpload(params)}
              />
              {error && (
                <div className="flex items-start gap-2 rounded-md border border-rose-200 bg-rose-50 p-3 text-xs text-rose-800">
                  <AlertCircle className="h-4 w-4 mt-0.5 shrink-0" />
                  <div className="flex-1">{error}</div>
                </div>
              )}
              <div className={`rounded-md border px-3 py-2.5 text-xs ${cfg.tone}`}>
                <p className="font-medium">After upload — {cfg.label}:</p>
                <ul className="mt-1.5 space-y-0.5 text-muted-foreground list-disc pl-4">
                  {bullets.map((b, i) => (
                    <li key={i}>{b.body}</li>
                  ))}
                </ul>
              </div>
            </>
          )}
        </div>

        <div className="border-t bg-background px-5 py-3 flex justify-end gap-2">
          {result ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                onClick={() => setResult(null)}
              >
                Upload another
              </Button>
              <Button size="sm" onClick={() => onOpenChange(false)}>
                View rows
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          )}
        </div>
      </div>

      <ColumnMappingDialog
        open={mappingDialogOpen}
        onOpenChange={(o) => {
          setMappingDialogOpen(o);
          if (!o) {
            setPendingFile(null);
            setPendingParams(null);
            setUploadLoading(false);
            setMappingConfirmMode(false);
          }
        }}
        fileName={mappingFileName}
        headers={mappingHeaders}
        sampleRows={mappingSampleRows}
        suggestedMapping={mappingSuggested}
        accounts={accountNames}
        onReparse={handleReparse}
        onConfirm={handleMappingConfirm}
        submitting={mappingSubmitting}
        // §B — in confirm mode the dialog is pre-filled with a DETECTED mapping
        // (not a blank one); show the "Don't ask again for this account"
        // checkbox + confirm-tailored copy.
        confirmMode={mappingConfirmMode}
      />

      {ofxPreview && (
        <OfxConfirmDialog
          open={ofxDialogOpen}
          onOpenChange={(o) => {
            setOfxDialogOpen(o);
            if (!o) {
              setOfxPendingFile(null);
              setOfxPendingParams(null);
              setUploadLoading(false);
            }
          }}
          fileName={ofxPreview.fileName}
          account={ofxPreview.account}
          currency={ofxPreview.currency}
          format={ofxPreview.format}
          rows={ofxPreview.rows}
          rowCount={ofxPreview.rowCount}
          statementBalance={ofxPreview.statementBalance}
          statementBalanceDate={ofxPreview.statementBalanceDate}
          initialPayeeSource={ofxPreview.payeeSource}
          submitting={ofxSubmitting}
          onConfirm={(p) => void handleOfxConfirm(p)}
        />
      )}
    </>
  );
}
