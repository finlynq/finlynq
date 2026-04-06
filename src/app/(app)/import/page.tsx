"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
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
  BookmarkCheck,
  Wand2,
} from "lucide-react";
import { FileDropZone } from "./components/file-drop-zone";
import { ImportPreviewDialog } from "./components/import-preview-dialog";
import { OfxPreview } from "./components/ofx-preview";
import { CsvMapperDialog } from "./components/csv-mapper-dialog";
import { TemplateManager } from "./components/template-manager";
import { extractCsvHeaders } from "@/lib/csv-parser";
import type { RawTransaction } from "@/lib/import-pipeline";
import type { OfxTransaction, OfxAccountInfo } from "@/lib/ofx-parser";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

interface ImportTemplate {
  id: number;
  name: string;
  fileType: string;
  headers: string[];
  columnMapping: Record<string, string>;
  defaultAccount: string;
  matchScore?: number;
}

export default function ImportPage() {
  // File upload state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [validRows, setValidRows] = useState<PreviewRow[]>([]);
  const [duplicateRows, setDuplicateRows] = useState<PreviewRow[]>([]);
  const [errorRows, setErrorRows] = useState<Array<{ rowIndex: number; message: string }>>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Current file and CSV mapping context (for template saving)
  const [currentFile, setCurrentFile] = useState<File | null>(null);
  const [currentCsvHeaders, setCurrentCsvHeaders] = useState<string[] | undefined>();
  const [currentColumnMapping, setCurrentColumnMapping] = useState<Record<string, string> | undefined>();
  const [currentDefaultAccount, setCurrentDefaultAccount] = useState<string | undefined>();

  // Accounts
  const [accounts, setAccounts] = useState<string[]>([]);

  // OFX preview state
  const [ofxPreviewOpen, setOfxPreviewOpen] = useState(false);
  const [ofxTransactions, setOfxTransactions] = useState<OfxTransaction[]>([]);
  const [ofxAccountInfo, setOfxAccountInfo] = useState<OfxAccountInfo>({ bankId: "", accountId: "", accountType: "" });
  const [ofxBalanceAmount, setOfxBalanceAmount] = useState<number | null>(null);
  const [ofxBalanceDate, setOfxBalanceDate] = useState<string | null>(null);
  const [ofxDateRange, setOfxDateRange] = useState<{ start: string; end: string } | null>(null);
  const [ofxCurrency, setOfxCurrency] = useState("CAD");

  // CSV mapper dialog state
  const [csvMapperOpen, setCsvMapperOpen] = useState(false);
  const [csvHeaders, setCsvHeaders] = useState<string[]>([]);
  const [isMapping, setIsMapping] = useState(false);

  // Template state
  const [templates, setTemplates] = useState<ImportTemplate[]>([]);
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [autoMatchedTemplate, setAutoMatchedTemplate] = useState<ImportTemplate | null>(null);

  // Email state
  const [importEmail, setImportEmail] = useState<string | null>(null);
  const [emailLoading, setEmailLoading] = useState(false);
  const [copied, setCopied] = useState(false);

  // Fetch accounts + email config + templates on mount
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setAccounts(data.map((a: { name: string }) => a.name));
      })
      .catch(() => {});

    fetch("/api/import/email-config")
      .then((r) => r.json())
      .then((data: { email?: string }) => setImportEmail(data.email ?? null))
      .catch(() => {});

    fetch("/api/import/templates")
      .then((r) => r.json())
      .then((data: ImportTemplate[]) => { if (Array.isArray(data)) setTemplates(data); })
      .catch(() => {});
  }, []);

  // Auto-match: when a CSV file is uploaded, score templates against its headers
  const findBestTemplate = useCallback((fileHeaders: string[]): ImportTemplate | null => {
    if (templates.length === 0 || fileHeaders.length === 0) return null;
    const fileSet = new Set(fileHeaders.map((h) => h.toLowerCase().trim()));
    let best: ImportTemplate | null = null;
    let bestScore = 0;
    for (const t of templates) {
      const matches = t.headers.filter((h) => fileSet.has(h.toLowerCase().trim())).length;
      const score = t.headers.length > 0 ? Math.round((matches / t.headers.length) * 100) : 0;
      if (score > bestScore && score >= 80) {
        bestScore = score;
        best = { ...t, matchScore: score };
      }
    }
    return best;
  }, [templates]);

  // Apply a template's mapping to the current file
  const applyTemplateToFile = useCallback(async (file: File, mapping: Record<string, string>, defAccount: string, headers: string[]) => {
    setIsMapping(true);
    try {
      const formData = new FormData();
      formData.append("file", file);
      formData.append("columnMapping", JSON.stringify(mapping));
      if (defAccount) formData.append("defaultAccount", defAccount);

      const res = await fetch("/api/import/csv-map", { method: "POST", body: formData });
      const data = await res.json() as { error?: string; valid?: PreviewRow[]; duplicates?: PreviewRow[]; errors?: Array<{ rowIndex: number; message: string }> };
      if (!res.ok) throw new Error(data.error);

      setValidRows(data.valid ?? []);
      setDuplicateRows(data.duplicates ?? []);
      setErrorRows(data.errors ?? []);
      setCurrentCsvHeaders(headers);
      setCurrentColumnMapping(mapping);
      setCurrentDefaultAccount(defAccount);
      setPreviewOpen(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Mapping failed";
      setUploadStatus({ type: "error", message });
    } finally {
      setIsMapping(false);
    }
  }, []);

  // Universal file upload handler
  const handleFileUpload = useCallback(async (file: File) => {
    setUploadStatus(null);
    setCurrentFile(file);
    setCurrentCsvHeaders(undefined);
    setCurrentColumnMapping(undefined);
    setCurrentDefaultAccount(undefined);
    setAutoMatchedTemplate(null);

    const ext = file.name.split(".").pop()?.toLowerCase();

    // For CSV: extract headers first to check for template match
    if (ext === "csv") {
      try {
        const text = await file.text();
        const headers = extractCsvHeaders(text);

        // Check if a specific template is selected
        const selectedTemplate = selectedTemplateId
          ? templates.find((t) => String(t.id) === selectedTemplateId)
          : null;

        if (selectedTemplate) {
          // Use selected template directly
          await applyTemplateToFile(file, selectedTemplate.columnMapping, selectedTemplate.defaultAccount ?? "", selectedTemplate.headers);
          return;
        }

        // Auto-match: find best matching template
        const best = findBestTemplate(headers);
        if (best) {
          setAutoMatchedTemplate(best);
          await applyTemplateToFile(file, best.columnMapping, best.defaultAccount ?? "", best.headers);
          return;
        }

        // Check if standard format (our own CSV export format)
        const standardHeaders = ["Date", "Amount", "Account", "Payee", "Categorization", "Currency", "Note", "Tags"];
        const lowerHeaders = headers.map((h) => h.toLowerCase());
        const hasDate = lowerHeaders.some((h) => h === "date");
        const hasAmount = lowerHeaders.some((h) => h === "amount");

        if (hasDate && hasAmount && headers.some((h) => standardHeaders.includes(h))) {
          // Standard format — use existing auto-parser
          const formData = new FormData();
          formData.append("file", file);
          const res = await fetch("/api/import/preview", { method: "POST", body: formData });
          const data = await res.json() as { error?: string; valid?: PreviewRow[]; duplicates?: PreviewRow[]; errors?: Array<{ rowIndex: number; message: string }> };
          if (!res.ok) throw new Error(data.error);
          setValidRows(data.valid ?? []);
          setDuplicateRows(data.duplicates ?? []);
          setErrorRows(data.errors ?? []);
          setPreviewOpen(true);
        } else {
          // Non-standard CSV — show column mapper
          setCsvHeaders(headers);
          setCsvMapperOpen(true);
        }
      } catch (err: unknown) {
        const message = err instanceof Error ? err.message : "Failed to process file";
        setUploadStatus({ type: "error", message });
      }
      return;
    }

    // OFX/QFX and other formats: use existing preview endpoint
    const formData = new FormData();
    formData.append("file", file);

    try {
      const res = await fetch("/api/import/preview", { method: "POST", body: formData });
      const data = await res.json() as {
        type?: string;
        error?: string;
        valid?: PreviewRow[];
        duplicates?: PreviewRow[];
        errors?: Array<{ rowIndex: number; message: string }>;
        transactions?: OfxTransaction[];
        account?: OfxAccountInfo;
        balanceAmount?: number;
        balanceDate?: string;
        dateRange?: { start: string; end: string };
        currency?: string;
      };
      if (!res.ok) throw new Error(data.error);

      if (data.type === "ofx") {
        setOfxTransactions(data.transactions ?? []);
        setOfxAccountInfo(data.account ?? { bankId: "", accountId: "", accountType: "" });
        setOfxBalanceAmount(data.balanceAmount ?? null);
        setOfxBalanceDate(data.balanceDate ?? null);
        setOfxDateRange(data.dateRange ?? null);
        setOfxCurrency(data.currency ?? "CAD");
        setOfxPreviewOpen(true);
      } else {
        setUploadStatus({ type: "error", message: "Unsupported file format. Please upload a CSV or OFX/QFX file." });
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to process file";
      setUploadStatus({ type: "error", message });
    }
  }, [selectedTemplateId, templates, findBestTemplate, applyTemplateToFile]);

  // CSV mapper dialog confirm
  const handleCsvMapped = useCallback(async (mapping: Record<string, string>, defAccount: string) => {
    setCsvMapperOpen(false);
    if (!currentFile) return;
    await applyTemplateToFile(currentFile, mapping, defAccount, csvHeaders);
  }, [currentFile, csvHeaders, applyTemplateToFile]);

  // OFX confirm callback
  const handleOfxConfirm = useCallback(async (rows: RawTransaction[]) => {
    setOfxPreviewOpen(false);
    try {
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, forceImportIndices: [] }),
      });
      const data = await res.json() as { error?: string; imported?: number; skippedDuplicates?: number };
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
  const handleImportConfirm = useCallback(async (rows: RawTransaction[], forceImportIndices: number[]) => {
    setIsImporting(true);
    try {
      const res = await fetch("/api/import/execute", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ rows, forceImportIndices }),
      });
      const data = await res.json() as { error?: string; imported?: number; skippedDuplicates?: number };
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
      const data = await res.json() as { email?: string };
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
            <BookmarkCheck className="h-4 w-4 mr-1.5" />
            Templates
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Upload Files */}
        <TabsContent value="upload">
          <div className="space-y-4 mt-4">
            {/* Template selector */}
            {templates.length > 0 && (
              <div className="flex items-center gap-2">
                <Wand2 className="h-4 w-4 text-muted-foreground shrink-0" />
                <span className="text-sm text-muted-foreground shrink-0">Use template:</span>
                <Select value={selectedTemplateId} onValueChange={(v) => setSelectedTemplateId(v ?? "")}>
                  <SelectTrigger className="w-56">
                    <SelectValue placeholder="Auto-detect" />
                  </SelectTrigger>
                  <SelectContent>
                    <SelectItem value="_auto">Auto-detect</SelectItem>
                    {templates.map((t) => (
                      <SelectItem key={t.id} value={String(t.id)}>
                        {t.name}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            )}

            <FileDropZone onFileSelected={handleFileUpload} accept=".csv,.ofx,.qfx" />

            {isMapping && (
              <Card className="border-indigo-200 bg-indigo-50/30">
                <CardContent className="py-3">
                  <div className="flex items-center gap-2">
                    <RefreshCw className="h-4 w-4 text-indigo-600 animate-spin" />
                    <p className="text-sm text-indigo-700">Applying column mapping…</p>
                  </div>
                </CardContent>
              </Card>
            )}

            {autoMatchedTemplate && !isMapping && (
              <Card className="border-emerald-200 bg-emerald-50/30">
                <CardContent className="py-3">
                  <div className="flex items-center gap-2">
                    <Wand2 className="h-4 w-4 text-emerald-600" />
                    <p className="text-sm text-emerald-700">
                      Auto-matched template <span className="font-medium">{autoMatchedTemplate.name}</span>
                      {autoMatchedTemplate.matchScore && (
                        <Badge variant="secondary" className="ml-2 text-[10px] bg-emerald-100 text-emerald-700">
                          {autoMatchedTemplate.matchScore}% match
                        </Badge>
                      )}
                    </p>
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
                      Standard or custom-column CSV files. Save column mappings as templates for one-click re-import.
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
                    <li>Forward your bank statement email (or attach CSV files) to the address above.</li>
                    <li>Attachments are automatically extracted and parsed.</li>
                    <li>If you have a saved template matching the CSV format, it will be applied automatically.</li>
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
            <p className="text-sm text-muted-foreground">
              Templates save your column mappings so you can re-import files from the same bank without reconfiguring.
              Upload a CSV, map the columns, and click &quot;Save column mapping as template&quot; after the preview.
            </p>
            <TemplateManager />
          </div>
        </TabsContent>
      </Tabs>

      {/* Dialogs */}
      <CsvMapperDialog
        open={csvMapperOpen}
        onOpenChange={setCsvMapperOpen}
        headers={csvHeaders}
        file={currentFile ?? new File([], "")}
        accounts={accounts}
        onMapped={handleCsvMapped}
        isMapping={isMapping}
      />

      <ImportPreviewDialog
        open={previewOpen}
        onOpenChange={setPreviewOpen}
        validRows={validRows}
        duplicateRows={duplicateRows}
        errorRows={errorRows}
        onConfirm={handleImportConfirm}
        isImporting={isImporting}
        csvHeaders={currentCsvHeaders}
        columnMapping={currentColumnMapping}
        defaultAccount={currentDefaultAccount}
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
        accounts={accounts}
        onConfirm={handleOfxConfirm}
      />
    </div>
  );
}
