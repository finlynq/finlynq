"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OnboardingTips } from "@/components/onboarding-tips";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  Mail,
  Copy,
  RefreshCw,
  BookTemplate,
  Sparkles,
  Link as LinkIcon,
  ListChecks,
} from "lucide-react";
import Link from "next/link";
import { FileDropZone } from "./components/file-drop-zone";
import { ImportPreviewDialog, type ProbableDuplicateMatch } from "./components/import-preview-dialog";
import { OfxPreview } from "./components/ofx-preview";
import {
  InvestmentStatementPreview,
  type InvestmentExternalAccount,
} from "./components/investment-statement-preview";
import { TemplateManager } from "./components/template-manager";
import { ColumnMappingDialog } from "./components/column-mapping-dialog";
import { ConnectorTab } from "./components/connector-tab";
import type { RawTransaction } from "@/lib/import-pipeline";
import type { OfxTransaction, OfxAccountInfo } from "@/lib/ofx-parser";
import type { ColumnMapping, ImportTemplate } from "@/lib/import-templates";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

export default function ImportPage() {
  // File upload state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [validRows, setValidRows] = useState<PreviewRow[]>([]);
  const [duplicateRows, setDuplicateRows] = useState<PreviewRow[]>([]);
  const [probableDuplicates, setProbableDuplicates] = useState<ProbableDuplicateMatch[]>([]);
  const [errorRows, setErrorRows] = useState<Array<{ rowIndex: number; message: string }>>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // CSV template state
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [appliedTemplateId, setAppliedTemplateId] = useState<number | null>(null);
  const [suggestedTemplate, setSuggestedTemplate] = useState<{ id: number; name: string; score: number } | null>(null);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [lastUploadedFile, setLastUploadedFile] = useState<File | null>(null);

  const [accountNames, setAccountNames] = useState<string[]>([]);

  // Column mapping dialog state (shown when auto-detect fails)
  const [mappingDialogOpen, setMappingDialogOpen] = useState(false);
  const [mappingHeaders, setMappingHeaders] = useState<string[]>([]);
  const [mappingSampleRows, setMappingSampleRows] = useState<Record<string, string>[]>([]);
  const [mappingSuggested, setMappingSuggested] = useState<ColumnMapping | null>(null);
  const [mappingFileName, setMappingFileName] = useState<string>("");
  const [mappingSubmitting, setMappingSubmitting] = useState(false);

  // OFX preview state
  const [ofxPreviewOpen, setOfxPreviewOpen] = useState(false);
  const [ofxTransactions, setOfxTransactions] = useState<OfxTransaction[]>([]);
  const [ofxAccountInfo, setOfxAccountInfo] = useState<OfxAccountInfo>({ bankId: "", accountId: "", accountType: "" });
  const [ofxBalanceAmount, setOfxBalanceAmount] = useState<number | null>(null);
  const [ofxBalanceDate, setOfxBalanceDate] = useState<string | null>(null);
  const [ofxDateRange, setOfxDateRange] = useState<{ start: string; end: string } | null>(null);
  const [ofxCurrency, setOfxCurrency] = useState("CAD");
  // Issue #62: track which OFX flavor (ofx vs qfx) so /api/import/execute can
  // be stamped with the right `source:<format>` tag at handleOfxConfirm time.
  const [ofxFormat, setOfxFormat] = useState<"ofx" | "qfx">("ofx");

  // Issue #64: investment-statement preview state. The investment path
  // (OFX with INVSTMTRS, QFX, IBKR FlexQuery XML) routes through a separate
  // dialog because the file may contain multiple brokerage sub-accounts the
  // user must individually bind to Finlynq accounts.
  const [investmentPreviewOpen, setInvestmentPreviewOpen] = useState(false);
  const [investmentFormat, setInvestmentFormat] =
    useState<"ofx" | "qfx" | "ibkr-xml">("ofx");
  const [investmentExternalAccounts, setInvestmentExternalAccounts] =
    useState<InvestmentExternalAccount[]>([]);
  const [investmentRows, setInvestmentRows] = useState<RawTransaction[]>([]);
  const [investmentDateRange, setInvestmentDateRange] =
    useState<{ start: string; end: string } | null>(null);

  // Email state
  const [importEmail, setImportEmail] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch accounts, templates, and email config on mount
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setAccountNames(data.map((a: { name: string }) => a.name));
      })
      .catch(() => {});

    fetch("/api/import/templates")
      .then((r) => r.json())
      .then((data) => { if (Array.isArray(data)) setTemplates(data); })
      .catch(() => {});

    fetch("/api/import/email-config")
      .then((r) => r.json())
      .then((data) => setImportEmail(data.email))
      .catch(() => {});
  }, []);

  // Core file preview function — called with optional templateId override
  const previewFile = useCallback(async (file: File, templateId?: number) => {
    setUploadStatus(null);
    setSuggestedTemplate(null);

    const formData = new FormData();
    formData.append("file", file);
    if (templateId !== undefined) formData.append("templateId", String(templateId));

    try {
      const res = await fetch("/api/import/preview", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      if (data.type === "ofx") {
        setOfxTransactions(data.transactions ?? []);
        setOfxAccountInfo(data.account ?? { bankId: "", accountId: "", accountType: "" });
        setOfxBalanceAmount(data.balanceAmount ?? null);
        setOfxBalanceDate(data.balanceDate ?? null);
        setOfxDateRange(data.dateRange ?? null);
        setOfxCurrency(data.currency ?? "CAD");
        setOfxFormat(data.format === "qfx" ? "qfx" : "ofx");
        setOfxPreviewOpen(true);
      } else if (data.type === "investment-statement") {
        // Issue #64: OFX/QFX investment statement OR IBKR FlexQuery XML.
        // Rows arrive with synthetic external-id `account` values + a
        // matching externalAccounts inventory; the dialog asks the user to
        // bind each one to a Finlynq account before /api/import/execute.
        const fmt: "ofx" | "qfx" | "ibkr-xml" =
          data.format === "qfx"
            ? "qfx"
            : data.format === "ibkr-xml"
              ? "ibkr-xml"
              : "ofx";
        setInvestmentFormat(fmt);
        setInvestmentExternalAccounts(data.externalAccounts ?? []);
        setInvestmentRows(data.rows ?? []);
        setInvestmentDateRange(data.dateRange ?? null);
        setInvestmentPreviewOpen(true);
      } else if (data.type === "csv-needs-mapping") {
        // Auto-detect failed — open the column mapping dialog.
        setMappingHeaders(data.headers ?? []);
        setMappingSampleRows(data.sampleRows ?? []);
        setMappingSuggested(data.suggestedMapping ?? null);
        setMappingFileName(data.fileName ?? file.name);
        setMappingDialogOpen(true);
      } else if (data.type === "csv" || data.valid !== undefined) {
        setCsvHeaders(data.headers ?? []);
        setAppliedTemplateId(data.appliedTemplateId ?? null);

        // Show suggestion banner if server found a match and no template was forced
        if (!templateId && data.suggestedTemplate) {
          setSuggestedTemplate(data.suggestedTemplate);
        }

        setValidRows(data.valid ?? []);
        setDuplicateRows(data.duplicates ?? []);
        setProbableDuplicates(data.probableDuplicates ?? []);
        setErrorRows(data.errors ?? []);
        setPreviewOpen(true);
      } else {
        setUploadStatus({ type: "error", message: "Unsupported file format. Please upload a CSV, Excel, PDF, OFX, QFX, or IBKR FlexQuery XML file." });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to process file";
      setUploadStatus({ type: "error", message });
    }
  }, []);

  // Universal file upload handler
  const handleFileUpload = useCallback(async (file: File) => {
    setLastUploadedFile(file);
    const tid = selectedTemplateId ? parseInt(selectedTemplateId, 10) : undefined;
    await previewFile(file, tid);
  }, [previewFile, selectedTemplateId]);

  // Apply suggested template
  const applySuggested = useCallback(async () => {
    if (!suggestedTemplate || !lastUploadedFile) return;
    setSuggestedTemplate(null);
    setPreviewOpen(false);
    await previewFile(lastUploadedFile, suggestedTemplate.id);
  }, [suggestedTemplate, lastUploadedFile, previewFile]);

  // Column mapping dialog confirm — parse with the user-supplied mapping,
  // open the regular preview, and auto-save the mapping as a template.
  const handleMappingConfirm = useCallback(
    async (params: {
      mapping: ColumnMapping;
      defaultAccount: string | null;
      templateName: string;
    }) => {
      if (!lastUploadedFile) return;
      setMappingSubmitting(true);
      try {
        // 1. Parse rows using the user's mapping.
        const formData = new FormData();
        formData.append("file", lastUploadedFile);
        formData.append("columnMapping", JSON.stringify(params.mapping));
        if (params.defaultAccount) formData.append("defaultAccount", params.defaultAccount);

        const res = await fetch("/api/import/csv-map", { method: "POST", body: formData });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);

        // 2. Save the mapping as a template (best-effort — don't block import).
        fetch("/api/import/templates", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            name: params.templateName,
            fileHeaders: data.headers ?? mappingHeaders,
            columnMapping: params.mapping,
            defaultAccount: params.defaultAccount ?? undefined,
          }),
        })
          .then((r) => r.json())
          .then((saved) => {
            if (saved && saved.id) {
              setTemplates((prev) => {
                if (prev.find((t) => t.id === saved.id)) return prev;
                return [...prev, saved];
              });
              setAppliedTemplateId(saved.id);
            }
          })
          .catch(() => {});

        // 3. Open the regular preview dialog with the parsed rows.
        setCsvHeaders(data.headers ?? []);
        setValidRows(data.valid ?? []);
        setDuplicateRows(data.duplicates ?? []);
        setProbableDuplicates(data.probableDuplicates ?? []);
        setErrorRows(data.errors ?? []);
        setMappingDialogOpen(false);
        setPreviewOpen(true);
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to parse with mapping";
        setUploadStatus({ type: "error", message });
        setMappingDialogOpen(false);
      } finally {
        setMappingSubmitting(false);
      }
    },
    [lastUploadedFile, mappingHeaders],
  );

  // Issue #64: investment-statement confirm callback. Rows arrive with
  // their `account` already rebound to a real Finlynq account name by the
  // dialog. /api/import/execute reuses the same path as every other import.
  const handleInvestmentConfirm = useCallback(
    async (rows: RawTransaction[]) => {
      setInvestmentPreviewOpen(false);
      try {
        const res = await fetch("/api/import/execute", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ rows, forceImportIndices: [] }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        const errCount = Array.isArray(data.errors) ? data.errors.length : 0;
        const errSuffix = errCount > 0 ? `, ${errCount} errors` : "";
        setUploadStatus({
          type: errCount > 0 && data.imported === 0 ? "error" : "success",
          message: `Imported ${data.imported} rows (${data.skippedDuplicates ?? 0} duplicates skipped${errSuffix})`,
        });
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Import failed";
        setUploadStatus({ type: "error", message });
      }
    },
    [],
  );

  // OFX confirm callback
  const handleOfxConfirm = useCallback(async (rows: RawTransaction[]) => {
    setOfxPreviewOpen(false);
    try {
      // Issue #62: stamp source:ofx or source:qfx based on the file format
      // detected at preview time.
      const sourceTag = `source:${ofxFormat}`;
      const taggedRows: RawTransaction[] = rows.map((r) => {
        const existing = (r.tags ?? "").split(",").map((t) => t.trim()).filter((t) => t);
        if (existing.some((t) => t.toLowerCase() === sourceTag.toLowerCase())) return r;
        return { ...r, tags: existing.length ? `${existing.join(",")},${sourceTag}` : sourceTag };
      });
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: taggedRows, forceImportIndices: [] }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setUploadStatus({
        type: "success",
        message: `Imported ${data.imported} transactions (${data.skippedDuplicates ?? 0} duplicates skipped)`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Import failed";
      setUploadStatus({ type: "error", message });
    }
  }, [ofxFormat]);

  // Import confirm callback
  const handleImportConfirm = useCallback(async (
    rows: RawTransaction[],
    forceImportIndices: number[],
    skipIndices: number[] = [],
  ) => {
    setIsImporting(true);
    try {
      // Issue #65: when the user marks any probable duplicates as "skip", we
      // filter them out client-side before /execute. The server-side
      // detector is a warning surface — it never blocks; the user's explicit
      // choice is what removes the row.
      const skipSet = new Set(skipIndices);
      const filtered = skipSet.size > 0
        ? rows.filter((_, idx) => !skipSet.has((rows[idx] as RawTransaction & { rowIndex?: number }).rowIndex ?? idx))
        : rows;
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows: filtered, forceImportIndices }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPreviewOpen(false);
      const skippedProbable = skipSet.size;
      setUploadStatus({
        type: "success",
        message: `Imported ${data.imported} transactions (${data.skippedDuplicates ?? 0} exact duplicates skipped${skippedProbable > 0 ? `, ${skippedProbable} probable duplicates skipped` : ""})`,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Import failed";
      setUploadStatus({ type: "error", message });
    } finally {
      setIsImporting(false);
    }
  }, []);

  // Email config handlers
  const generateEmail = async () => {
    setEmailLoading(true);
    try {
      const res = await fetch("/api/import/email-config", { method: "POST" });
      const data = await res.json();
      if (data.email) setImportEmail(data.email);
    } catch {
      // ignore
    } finally {
      setEmailLoading(false);
    }
  };

  const copyEmail = () => {
    if (importEmail) {
      navigator.clipboard.writeText(importEmail);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  return (
    <div className="max-w-3xl space-y-6">
      <OnboardingTips page="import" />
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Import Data</h1>
        <p className="text-sm text-muted-foreground mt-0.5">
          Upload files or send them via email to import your financial data.
        </p>
      </div>

      <Tabs defaultValue="upload">
        <TabsList>
          <TabsTrigger value="upload">
            <Upload className="h-4 w-4 mr-1.5" />
            Upload Files
          </TabsTrigger>
          <TabsTrigger value="email">
            <Mail className="h-4 w-4 mr-1.5" />
            Email Import
          </TabsTrigger>
          <TabsTrigger value="connect">
            <LinkIcon className="h-4 w-4 mr-1.5" />
            Connect a Service
          </TabsTrigger>
          <TabsTrigger value="templates">
            <BookTemplate className="h-4 w-4 mr-1.5" />
            Templates
            {templates.length > 0 && (
              <span className="ml-1.5 text-[10px] bg-muted rounded-full px-1.5 py-0.5 font-mono">
                {templates.length}
              </span>
            )}
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Upload Files */}
        <TabsContent value="upload">
          <div className="space-y-4 mt-4">
            {/* Template selector */}
            {templates.length > 0 && (
              <div className="flex items-center gap-2">
                <BookTemplate className="h-4 w-4 text-muted-foreground shrink-0" />
                <Select value={selectedTemplateId} onValueChange={(v) => setSelectedTemplateId(v ?? "")}>
                  <SelectTrigger className="flex-1 h-8 text-sm">
                    <SelectValue placeholder="Use a saved template (optional)" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="">Auto-detect</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}
                        {t.defaultAccount && ` · ${t.defaultAccount}`}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
                {selectedTemplateId && (
                  <Button size="sm" variant="ghost" className="h-8 px-2 text-xs" onClick={() => setSelectedTemplateId("")}>
                    Clear
                  </Button>
                )}
              </div>
            )}

            <FileDropZone onFileSelected={handleFileUpload} />

            {/* Reconciliation Mode entry — issue #36. Statement-aware
                preview/diff/approve flow that classifies each row as
                NEW / EXISTING / PROBABLE_DUPLICATE before any write. */}
            <Card className="border-dashed border-indigo-200 bg-indigo-50/30 dark:bg-indigo-950/10">
              <CardContent className="py-3">
                <div className="flex items-center justify-between gap-3">
                  <div className="flex items-center gap-2 min-w-0">
                    <ListChecks className="h-4 w-4 text-indigo-600 shrink-0" />
                    <div className="min-w-0">
                      <p className="text-sm font-medium">Reconciliation Mode</p>
                      <p className="text-xs text-muted-foreground">
                        Diff a statement row-by-row before committing. Flags
                        probable duplicates and lets you fix routing inline.
                      </p>
                    </div>
                  </div>
                  <Link
                    href="/import/reconcile"
                    className="shrink-0 inline-flex h-8 items-center rounded-md border bg-background px-3 text-xs font-medium hover:bg-muted"
                  >
                    Open
                  </Link>
                </div>
              </CardContent>
            </Card>

            {/* Auto-match suggestion banner */}
            {suggestedTemplate && (
              <Card className="border-blue-200 bg-blue-50/40">
                <CardContent className="py-3">
                  <div className="flex items-center justify-between gap-3">
                    <div className="flex items-center gap-2">
                      <Sparkles className="h-4 w-4 text-blue-600 shrink-0" />
                      <p className="text-sm text-blue-800">
                        This looks like <span className="font-medium">{suggestedTemplate.name}</span>
                        {" "}({suggestedTemplate.score}% match). Re-import using this template?
                      </p>
                    </div>
                    <div className="flex gap-2 shrink-0">
                      <Button size="sm" variant="outline" className="h-7 text-xs" onClick={() => setSuggestedTemplate(null)}>
                        Ignore
                      </Button>
                      <Button size="sm" className="h-7 text-xs" onClick={applySuggested}>
                        Apply
                      </Button>
                    </div>
                  </div>
                </CardContent>
              </Card>
            )}

            {uploadStatus && (
              <Card className={uploadStatus.type === "success" ? "border-emerald-200 bg-emerald-50/30" : "border-rose-200 bg-rose-50/30"}>
                <CardContent className="py-3">
                  <div className="flex items-center gap-2">
                    {uploadStatus.type === "success" ? (
                      <CheckCircle2 className="h-4 w-4 text-emerald-600" />
                    ) : (
                      <AlertCircle className="h-4 w-4 text-rose-600" />
                    )}
                    <p className={`text-sm ${uploadStatus.type === "success" ? "text-emerald-700" : "text-rose-700"}`}>
                      {uploadStatus.message}
                    </p>
                  </div>
                </CardContent>
              </Card>
            )}

            <Card>
              <CardHeader>
                <CardTitle className="text-sm">Supported Formats</CardTitle>
              </CardHeader>
              <CardContent>
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium">CSV</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Standard CSV transaction files. Save a template to auto-map columns on future uploads.
                    </p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium">OFX / QFX</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Bank transaction files with unique IDs for reliable deduplication. Supported by most Canadian banks.
                    </p>
                  </div>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 2: Email Import */}
        <TabsContent value="email">
          <div className="space-y-4 mt-4">
            <Card>
              <CardHeader>
                <CardTitle className="text-base flex items-center gap-2">
                  <Mail className="h-5 w-5 text-blue-600" />
                  Import via Email
                </CardTitle>
                <CardDescription>
                  Forward bank statements and transaction files to your unique import email address.
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                {importEmail ? (
                  <>
                    <div className="flex items-center gap-2">
                      <div className="flex-1 rounded-lg border bg-muted/50 px-4 py-2.5 font-mono text-sm">
                        {importEmail}
                      </div>
                      <Button variant="outline" size="sm" onClick={copyEmail}>
                        <Copy className="h-4 w-4 mr-1" />
                        {copied ? "Copied!" : "Copy"}
                      </Button>
                    </div>
                    <Button
                      variant="ghost"
                      size="sm"
                      onClick={generateEmail}
                      disabled={emailLoading}
                    >
                      <RefreshCw className={`h-3.5 w-3.5 mr-1.5 ${emailLoading ? "animate-spin" : ""}`} />
                      Regenerate Address
                    </Button>
                  </>
                ) : (
                  <Button onClick={generateEmail} disabled={emailLoading}>
                    <Mail className="h-4 w-4 mr-2" />
                    {emailLoading ? "Generating..." : "Generate Import Email Address"}
                  </Button>
                )}

                <div className="rounded-lg border bg-muted/30 p-4 space-y-2">
                  <p className="text-sm font-medium">How it works</p>
                  <ol className="text-xs text-muted-foreground space-y-1 list-decimal list-inside">
                    <li>Forward your bank statement email (or attach a CSV file) to the address above.</li>
                    <li>CSV attachments are matched against your saved import templates automatically.</li>
                    <li>Parsed transactions wait for your review at <a href="/import/pending" className="underline hover:no-underline">/import/pending</a> — nothing is imported until you approve.</li>
                    <li>Duplicate transactions are flagged and skipped on approve.</li>
                    <li>Pending imports auto-expire after 14 days.</li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 3: Connect a Service */}
        <TabsContent value="connect">
          <ConnectorTab />
        </TabsContent>

        {/* Tab 4: Templates */}
        <TabsContent value="templates">
          <div className="space-y-4 mt-4">
            <div>
              <p className="text-sm text-muted-foreground">
                Templates save your CSV column mappings so future uploads from the same bank are automatically recognized.
                Upload a CSV and click <span className="font-medium">Save as Template</span> in the preview dialog to create one.
              </p>
            </div>
            <TemplateManager
              templates={templates}
              onDeleted={(id) => setTemplates((prev) => prev.filter((t) => t.id !== id))}
              onRenamed={(id, name) =>
                setTemplates((prev) => prev.map((t) => (t.id === id ? { ...t, name } : t)))
              }
            />
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <ImportPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        validRows={validRows}
        duplicateRows={duplicateRows}
        probableDuplicates={probableDuplicates}
        errorRows={errorRows}
        onConfirm={handleImportConfirm}
        isImporting={isImporting}
        csvHeaders={csvHeaders}
        accounts={accountNames}
        appliedTemplateId={appliedTemplateId}
        onTemplateSaved={(t) => {
          setTemplates((prev) => {
            if (prev.find((x) => x.id === t.id)) return prev;
            // Refetch to get full template data
            fetch("/api/import/templates")
              .then((r) => r.json())
              .then((data) => { if (Array.isArray(data)) setTemplates(data); })
              .catch(() => {});
            return prev;
          });
        }}
      />

      <OfxPreview
        open={ofxPreviewOpen}
        onOpenChange={setOfxPreviewOpen}
        transactions={ofxTransactions}
        accountInfo={ofxAccountInfo}
        balanceAmount={ofxBalanceAmount}
        balanceDate={ofxBalanceDate}
        dateRange={ofxDateRange}
        currency={ofxCurrency}
        accounts={accountNames}
        onConfirm={handleOfxConfirm}
      />

      {/* Issue #64: investment-statement preview (OFX INVSTMTRS / QFX
          investment / IBKR FlexQuery XML). Multi-account file → user binds
          each external account to a Finlynq account before import. */}
      <InvestmentStatementPreview
        open={investmentPreviewOpen}
        onOpenChange={setInvestmentPreviewOpen}
        format={investmentFormat}
        externalAccounts={investmentExternalAccounts}
        rows={investmentRows}
        dateRange={investmentDateRange}
        finlynqAccounts={accountNames}
        onConfirm={handleInvestmentConfirm}
      />

      <ColumnMappingDialog
        open={mappingDialogOpen}
        onOpenChange={setMappingDialogOpen}
        fileName={mappingFileName}
        headers={mappingHeaders}
        sampleRows={mappingSampleRows}
        suggestedMapping={mappingSuggested}
        accounts={accountNames}
        onConfirm={handleMappingConfirm}
        submitting={mappingSubmitting}
      />
    </div>
  );
}
