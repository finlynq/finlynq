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
} from "lucide-react";
import { FileDropZone } from "./components/file-drop-zone";
import { ImportPreviewDialog } from "./components/import-preview-dialog";
import { OfxPreview } from "./components/ofx-preview";
import { TemplateManager } from "./components/template-manager";
import { ColumnMappingDialog } from "./components/column-mapping-dialog";
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
        setOfxPreviewOpen(true);
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
        setErrorRows(data.errors ?? []);
        setPreviewOpen(true);
      } else {
        setUploadStatus({ type: "error", message: "Unsupported file format. Please upload a CSV or OFX/QFX file." });
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

  // OFX confirm callback
  const handleOfxConfirm = useCallback(async (rows: RawTransaction[]) => {
    setOfxPreviewOpen(false);
    try {
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, forceImportIndices: [] }),
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
  }, []);

  // Import confirm callback
  const handleImportConfirm = useCallback(async (
    rows: RawTransaction[],
    forceImportIndices: number[],
  ) => {
    setIsImporting(true);
    try {
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, forceImportIndices }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setPreviewOpen(false);
      setUploadStatus({
        type: "success",
        message: `Imported ${data.imported} transactions (${data.skippedDuplicates ?? 0} duplicates skipped)`,
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
                    <li>Duplicate transactions are detected and skipped.</li>
                    <li>You&apos;ll receive a notification when the import completes.</li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 3: Templates */}
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
