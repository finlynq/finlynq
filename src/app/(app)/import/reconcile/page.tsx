"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { AlertCircle, ArrowLeft } from "lucide-react";
import { ReconcileUploadCard } from "@/components/reconcile/upload-card";
import type { AccountOption } from "@/components/reconcile/preview-table";
import { ColumnMappingDialog } from "@/app/(app)/import/components/column-mapping-dialog";
import type { ColumnMapping, ImportTemplate } from "@/lib/import-templates";

/**
 * /import/reconcile — upload entry point that routes everything through the
 * unified staging tables (issue #153). The upload posts to
 * `/api/import/staging/upload`, which persists rows into `staged_imports` +
 * `staged_transactions`, then redirects to `/import/pending?id=<stagedImportId>`
 * where the user reviews and approves the batch.
 *
 * The old preview-and-commit pair on `/api/import/reconcile/{preview,commit}`
 * is gone; everything materializes through the same `/import/pending` review
 * surface as the email-import path.
 */

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
}

/** FINLYNQ-58 — overlap-detection response envelope. When the server sees a
 *  pending staged_imports row for the same account with an overlapping date
 *  range, it returns this BEFORE inserting anything; the client renders the
 *  merge / create-new / cancel modal. */
interface MergeCandidate {
  stagedImportId: string;
  dateRangeStart: string | null;
  dateRangeEnd: string | null;
  rowCount: number;
  originalFilename: string | null;
}

interface UploadParams {
  file: File;
  accountId: number | null;
  tolerance: number;
  templateId: number | null;
  statementBalance: number | null;
  /** FINLYNQ-54 parser knobs — defaults preserve pre-FINLYNQ-54 behavior. */
  skipHeaderRows: number;
  skipFooterRows: number;
  dateFormatOverride: "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
  defaultCurrency: string | null;
}

export default function ReconcilePage() {
  const router = useRouter();
  const [accounts, setAccounts] = useState<AccountOption[]>([]);
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [accountNames, setAccountNames] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [uploadLoading, setUploadLoading] = useState(false);

  // Mapping dialog state — same as before. Non-canonical CSVs (IBKR etc.)
  // still need a column-mapping dialog before staging can persist them.
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
  const [pendingParams, setPendingParams] = useState<{
    accountId: number | null;
    tolerance: number;
    statementBalance: number | null;
    skipHeaderRows: number;
    skipFooterRows: number;
    dateFormatOverride: "auto" | "DD/MM/YYYY" | "MM/DD/YYYY" | "YYYY-MM-DD";
    defaultCurrency: string | null;
  } | null>(null);

  // FINLYNQ-58 — merge-prompt modal state. When the server detects an
  // overlapping pending batch it returns a mergeCandidate descriptor; we
  // stash the originally-uploaded file + params + the candidate, render the
  // 3-button dialog, and re-fire the upload with `action=merge` or
  // `action=new` based on the user's choice.
  const [mergeCandidate, setMergeCandidate] = useState<MergeCandidate | null>(null);
  const [mergePendingFile, setMergePendingFile] = useState<File | null>(null);
  const [mergePendingParams, setMergePendingParams] = useState<UploadParams | null>(null);

  useEffect(() => {
    void Promise.all([
      fetch("/api/accounts").then((r) => (r.ok ? r.json() : [])),
      fetch("/api/import/templates").then((r) => (r.ok ? r.json() : [])),
    ])
      .then(([accts, tpls]) => {
        if (Array.isArray(accts)) {
          setAccounts(
            accts.map((a: { id: number; name: string; currency: string; isInvestment?: boolean }) => ({
              id: a.id,
              name: a.name,
              currency: a.currency,
              isInvestment: !!a.isInvestment,
            })),
          );
          setAccountNames(accts.map((a: { name: string }) => a.name));
        }
        if (Array.isArray(tpls)) {
          setTemplates(tpls);
        }
      })
      .catch(() => {});
  }, []);

  const submitUpload = useCallback(
    async (
      params: UploadParams,
      /** FINLYNQ-58 — set on the second pass when the user picked a merge
       *  action in the modal. 'merge' appends to `mergeIntoStagedImportId`;
       *  'new' bypasses overlap detection and creates a fresh batch. */
      mergeAction?: { action: "merge" | "new"; mergeIntoStagedImportId?: string },
    ) => {
      const {
        file,
        accountId,
        tolerance,
        templateId,
        statementBalance,
        skipHeaderRows,
        skipFooterRows,
        dateFormatOverride,
        defaultCurrency,
      } = params;
      setError(null);
      setUploadLoading(true);
      try {
        const fd = new FormData();
        fd.append("file", file);
        if (accountId) fd.append("accountId", String(accountId));
        if (templateId) fd.append("templateId", String(templateId));
        fd.append("tolerance", String(tolerance));
        if (statementBalance !== null) {
          fd.append("statementBalance", String(statementBalance));
        }
        // FINLYNQ-54 — only forward knobs when they differ from the defaults
        // so the server-side validator doesn't have to special-case "0"/"auto"
        // strings. Server defaults to 0/0/null/null when fields are absent.
        if (skipHeaderRows > 0) fd.append("skipHeaderRows", String(skipHeaderRows));
        if (skipFooterRows > 0) fd.append("skipFooterRows", String(skipFooterRows));
        if (dateFormatOverride !== "auto") {
          fd.append("dateFormatOverride", dateFormatOverride);
        }
        if (defaultCurrency) fd.append("defaultCurrency", defaultCurrency);
        // FINLYNQ-58 — merge action propagation
        if (mergeAction) {
          fd.append("action", mergeAction.action);
          if (mergeAction.action === "merge" && mergeAction.mergeIntoStagedImportId) {
            fd.append("mergeIntoStagedImportId", mergeAction.mergeIntoStagedImportId);
          }
        }
        const res = await fetch("/api/import/staging/upload", {
          method: "POST",
          body: fd,
        });
        const json = await res.json();
        // FINLYNQ-58 — overlap-detection response. Server returns
        // `{ success: true, data: { mergeCandidate: {...} } }` when an
        // existing pending staged_imports row overlaps the new upload's
        // date range for the same account. Stash the file + params and
        // surface the modal; the user picks Merge / Create new / Cancel.
        if (
          res.ok &&
          json &&
          typeof json === "object" &&
          json.success === true &&
          json.data &&
          typeof json.data === "object" &&
          json.data.mergeCandidate
        ) {
          setMergeCandidate(json.data.mergeCandidate as MergeCandidate);
          setMergePendingFile(file);
          setMergePendingParams(params);
          setUploadLoading(false);
          return;
        }
        if (!res.ok) {
          // 422 with type:"csv-needs-mapping" → open the column-mapping
          // dialog. The user maps columns, we POST /api/import/templates to
          // persist the mapping, then re-fire this upload with the new
          // templateId so staging gets the parsed rows.
          if (
            res.status === 422 &&
            json &&
            typeof json === "object" &&
            json.type === "csv-needs-mapping"
          ) {
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
            });
            setMappingDialogOpen(true);
            return;
          }
          throw new Error(json.error ?? `HTTP ${res.status}`);
        }
        const data = json as UploadResponse;
        // Redirect to the unified review page. The review-and-commit
        // experience is exclusively at /import/pending now.
        router.push(data.redirectTo ?? `/import/pending?id=${data.stagedImportId}`);
      } catch (err) {
        setError(err instanceof Error ? err.message : "Upload failed");
        setUploadLoading(false);
      }
    },
    [router],
  );

  const handleUpload = useCallback(
    (params: UploadParams) => {
      void submitUpload(params);
    },
    [submitUpload],
  );

  // FINLYNQ-58 — modal action handlers. Merge / Create new re-fire the
  // same upload with the explicit `action` field; Cancel discards.
  const handleMergeChoice = useCallback(
    (choice: "merge" | "new") => {
      if (!mergePendingFile || !mergePendingParams || !mergeCandidate) {
        setMergeCandidate(null);
        return;
      }
      const params = { ...mergePendingParams, file: mergePendingFile };
      const action =
        choice === "merge"
          ? { action: "merge" as const, mergeIntoStagedImportId: mergeCandidate.stagedImportId }
          : { action: "new" as const };
      setMergeCandidate(null);
      setMergePendingFile(null);
      setMergePendingParams(null);
      void submitUpload(params, action);
    },
    [mergePendingFile, mergePendingParams, mergeCandidate, submitUpload],
  );
  const handleMergeCancel = useCallback(() => {
    setMergeCandidate(null);
    setMergePendingFile(null);
    setMergePendingParams(null);
  }, []);

  // Column-mapping confirm — save the mapping as a template, then re-fire
  // the upload using that template so staging actually receives parsed rows.
  const handleMappingConfirm = useCallback(
    async (params: {
      mapping: ColumnMapping;
      defaultAccount: string | null;
      templateName: string;
    }) => {
      if (!pendingFile || !pendingParams) {
        setMappingDialogOpen(false);
        return;
      }
      setMappingSubmitting(true);
      try {
        const tplRes = await fetch("/api/import/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: params.templateName,
            fileHeaders: mappingHeaders,
            columnMapping: params.mapping,
            defaultAccount: params.defaultAccount ?? undefined,
          }),
        });
        const saved = await tplRes.json();
        if (!tplRes.ok || !saved?.id) {
          throw new Error(
            (saved && typeof saved.error === "string"
              ? saved.error
              : null) ?? "Failed to save template",
          );
        }
        setTemplates((prev) => {
          if (prev.find((t) => t.id === saved.id)) return prev;
          return [...prev, saved];
        });

        setMappingDialogOpen(false);
        const file = pendingFile;
        const {
          accountId,
          tolerance,
          statementBalance,
          skipHeaderRows,
          skipFooterRows,
          dateFormatOverride,
          defaultCurrency,
        } = pendingParams;
        setPendingFile(null);
        setPendingParams(null);

        await submitUpload({
          file,
          accountId,
          tolerance,
          templateId: saved.id as number,
          statementBalance,
          skipHeaderRows,
          skipFooterRows,
          dateFormatOverride,
          defaultCurrency,
        });
      } catch (err) {
        const message =
          err instanceof Error ? err.message : "Failed to save template";
        setError(message);
        setMappingDialogOpen(false);
      } finally {
        setMappingSubmitting(false);
      }
    },
    [pendingFile, pendingParams, mappingHeaders, submitUpload],
  );

  const templateOptions = useMemo(
    () => templates.map((t) => ({ id: t.id, name: t.name })),
    [templates],
  );

  return (
    <div className="space-y-6 pb-12">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Reconciliation Mode</h1>
          <p className="text-sm text-muted-foreground max-w-2xl">
            Upload a statement (CSV / OFX / QFX) — every row lands in the{" "}
            <Link href="/import/pending" className="underline font-medium">
              pending-imports queue
            </Link>{" "}
            for review. Each row is classified as <strong>New</strong>,{" "}
            <strong>Existing</strong>, or <strong>Probable duplicate</strong>{" "}
            against your current Finlynq state before any write.
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

      <Card>
        <CardHeader>
          <CardTitle>Upload statement</CardTitle>
          <CardDescription>
            Supported: CSV (with <code>Date,Account,Amount,Payee</code>{" "}
            headers, a saved template, or column-mapping on the fly) and
            OFX/QFX (single-account statements — pick the destination
            Finlynq account below). After upload you&rsquo;ll be redirected
            to the review queue.
          </CardDescription>
        </CardHeader>
        <CardContent>
          <ReconcileUploadCard
            accounts={accounts}
            templates={templateOptions}
            loading={uploadLoading}
            onUpload={handleUpload}
          />
        </CardContent>
      </Card>

      <ColumnMappingDialog
        open={mappingDialogOpen}
        onOpenChange={(open) => {
          setMappingDialogOpen(open);
          if (!open) {
            setPendingFile(null);
            setPendingParams(null);
            setUploadLoading(false);
          }
        }}
        fileName={mappingFileName}
        headers={mappingHeaders}
        sampleRows={mappingSampleRows}
        suggestedMapping={mappingSuggested}
        accounts={accountNames}
        onConfirm={handleMappingConfirm}
        submitting={mappingSubmitting}
      />

      {/* FINLYNQ-58 — overlap-detection merge prompt. Server returns a
          mergeCandidate when the upload's date range overlaps an existing
          pending batch on the same account; this dialog lets the user
          decide to (a) append into the existing batch, (b) create a new
          batch anyway, or (c) cancel without inserting anything. */}
      <Dialog
        open={mergeCandidate !== null}
        onOpenChange={(open) => {
          if (!open) handleMergeCancel();
        }}
      >
        <DialogContent className="max-w-md">
          <DialogHeader>
            <DialogTitle>Overlapping pending upload</DialogTitle>
            <DialogDescription>
              This account already has a pending upload covering{" "}
              <span className="font-medium">
                {mergeCandidate?.dateRangeStart ?? "(unknown)"}
                {" "}to{" "}
                {mergeCandidate?.dateRangeEnd ?? "(unknown)"}
              </span>{" "}
              ({mergeCandidate?.rowCount ?? 0}{" "}
              {(mergeCandidate?.rowCount ?? 0) === 1 ? "row" : "rows"}
              {mergeCandidate?.originalFilename ? (
                <> from <span className="font-medium">{mergeCandidate.originalFilename}</span></>
              ) : null}
              ). Choose how to handle this upload:
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2 text-sm text-muted-foreground">
            <p>
              <span className="font-medium text-foreground">Merge</span> — append
              the new rows into the existing pending batch. Rows that match an
              ingest-time hash already in the batch are dropped silently.
            </p>
            <p>
              <span className="font-medium text-foreground">Create new batch</span>{" "}
              — start a fresh review queue entry alongside the existing one.
            </p>
            <p>
              <span className="font-medium text-foreground">Cancel</span> —
              discard this upload entirely.
            </p>
          </div>
          <DialogFooter className="gap-2 sm:justify-between">
            <Button variant="ghost" onClick={handleMergeCancel}>
              Cancel
            </Button>
            <div className="flex gap-2">
              <Button variant="outline" onClick={() => handleMergeChoice("new")}>
                Create new batch
              </Button>
              <Button onClick={() => handleMergeChoice("merge")}>
                Merge
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}
