"use client";

import { useState, useEffect, useCallback, useRef } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { OnboardingTips } from "@/components/onboarding-tips";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  Wallet,
  Tag,
  Briefcase,
  ArrowLeftRight,
  Mail,
  Copy,
  RefreshCw,
  FileText,
} from "lucide-react";
import { FileDropZone } from "./components/file-drop-zone";
import { ImportPreviewDialog } from "./components/import-preview-dialog";
import { ExcelMapperDialog } from "./components/excel-mapper-dialog";
import { PdfPreview } from "./components/pdf-preview";
import { OfxPreview } from "./components/ofx-preview";
import type { RawTransaction } from "@/lib/import-pipeline";
import type { OfxTransaction, OfxAccountInfo } from "@/lib/ofx-parser";

// CSV structured import steps (existing)
const importSteps = [
  { type: "accounts", label: "Accounts", description: "Import bank accounts, investment accounts, and liabilities", file: "Accounts.csv", icon: Wallet, iconBg: "bg-violet-100 text-violet-600" },
  { type: "categories", label: "Categories", description: "Import expense, income, and reconciliation categories", file: "Categories.csv", icon: Tag, iconBg: "bg-emerald-100 text-emerald-600" },
  { type: "portfolio", label: "Portfolio", description: "Import investment holdings and symbols", file: "Portfolio.csv", icon: Briefcase, iconBg: "bg-cyan-100 text-cyan-600" },
  { type: "transactions", label: "Transactions", description: "Import all transactions (requires accounts and categories first)", file: "Transactions.csv", icon: ArrowLeftRight, iconBg: "bg-amber-100 text-amber-600" },
];

type ImportResult = { total: number; imported: number; skippedDuplicates?: number } | null;
type ImportStatus = "idle" | "loading" | "success" | "error";

interface PreviewRow extends RawTransaction {
  hash: string;
  rowIndex: number;
}

interface SheetInfo {
  name: string;
  headers: string[];
  sampleRows: string[][];
  totalRows: number;
}

export default function ImportPage() {
  // Structured CSV import state
  const [results, setResults] = useState<Record<string, ImportResult>>({});
  const [statuses, setStatuses] = useState<Record<string, ImportStatus>>({});
  const [errors, setErrors] = useState<Record<string, string>>({});
  const fileInputRefs = useRef<Record<string, HTMLInputElement | null>>({});

  // File upload state
  const [previewOpen, setPreviewOpen] = useState(false);
  const [validRows, setValidRows] = useState<PreviewRow[]>([]);
  const [duplicateRows, setDuplicateRows] = useState<PreviewRow[]>([]);
  const [errorRows, setErrorRows] = useState<Array<{ rowIndex: number; message: string }>>([]);
  const [isImporting, setIsImporting] = useState(false);
  const [uploadStatus, setUploadStatus] = useState<{ type: "success" | "error"; message: string } | null>(null);

  // Excel mapper state
  const [excelMapperOpen, setExcelMapperOpen] = useState(false);
  const [excelSheets, setExcelSheets] = useState<SheetInfo[]>([]);
  const [excelFile, setExcelFile] = useState<File | null>(null);
  const [isExcelMapping, setIsExcelMapping] = useState(false);

  // PDF preview state
  const [pdfPreviewOpen, setPdfPreviewOpen] = useState(false);
  const [pdfRows, setPdfRows] = useState<RawTransaction[]>([]);
  const [pdfConfidence, setPdfConfidence] = useState(0);
  const [pdfRawText, setPdfRawText] = useState("");
  const [accounts, setAccounts] = useState<string[]>([]);

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

  // Fetch accounts + email config on mount
  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) setAccounts(data.map((a: { name: string }) => a.name));
      })
      .catch(() => {});

    fetch("/api/import/email-config")
      .then((r) => r.json())
      .then((data) => setImportEmail(data.email))
      .catch(() => {});
  }, []);

  // Structured CSV import handler (existing flow)
  async function handleStructuredImport(type: string, file: File) {
    setStatuses((s) => ({ ...s, [type]: "loading" }));
    setErrors((e) => ({ ...e, [type]: "" }));

    const formData = new FormData();
    formData.append("type", type);
    formData.append("file", file);

    try {
      const res = await fetch("/api/import", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);
      setResults((r) => ({ ...r, [type]: data }));
      setStatuses((s) => ({ ...s, [type]: "success" }));
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Import failed";
      setErrors((e) => ({ ...e, [type]: message }));
      setStatuses((s) => ({ ...s, [type]: "error" }));
    }
  }

  // Universal file upload handler
  const handleFileUpload = useCallback(async (file: File) => {
    setUploadStatus(null);

    const formData = new FormData();
    formData.append("file", file);

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
      } else if (data.type === "excel") {
        setExcelSheets(data.sheets);
        setExcelFile(file);
        setExcelMapperOpen(true);
      } else if (data.type === "pdf") {
        const allRows = [...(data.valid ?? []), ...(data.duplicates ?? [])];
        setPdfRows(allRows.map((r: PreviewRow) => ({
          date: r.date,
          account: r.account,
          amount: r.amount,
          payee: r.payee,
          category: r.category,
          currency: r.currency,
          note: r.note,
        })));
        setPdfConfidence(data.confidence ?? 0);
        setPdfRawText(data.rawText ?? "");
        setPdfPreviewOpen(true);
      } else {
        // CSV — show preview dialog directly
        setValidRows(data.valid ?? []);
        setDuplicateRows(data.duplicates ?? []);
        setErrorRows(data.errors ?? []);
        setPreviewOpen(true);
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Failed to process file";
      setUploadStatus({ type: "error", message });
    }
  }, []);

  // Excel mapper callback
  const handleExcelMapped = useCallback(async (
    sheetName: string,
    mapping: Record<string, string>,
    hasHeaders: boolean,
  ) => {
    if (!excelFile) return;
    setIsExcelMapping(true);

    try {
      const formData = new FormData();
      formData.append("file", excelFile);
      formData.append("sheetName", sheetName);
      formData.append("columnMapping", JSON.stringify(mapping));
      formData.append("hasHeaders", String(hasHeaders));

      const res = await fetch("/api/import/excel-map", { method: "POST", body: formData });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error);

      setExcelMapperOpen(false);
      setValidRows(data.valid ?? []);
      setDuplicateRows(data.duplicates ?? []);
      setErrorRows(data.errors ?? []);
      setPreviewOpen(true);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Mapping failed";
      setUploadStatus({ type: "error", message });
      setExcelMapperOpen(false);
    } finally {
      setIsExcelMapping(false);
    }
  }, [excelFile]);

  // PDF confirm callback
  const handlePdfConfirm = useCallback(async (rows: RawTransaction[]) => {
    setPdfPreviewOpen(false);

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

  const completedCount = Object.values(statuses).filter((s) => s === "success").length;

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
          <TabsTrigger value="structured">
            <FileText className="h-4 w-4 mr-1.5" />
            Structured CSV
          </TabsTrigger>
        </TabsList>

        {/* Tab 1: Upload Files */}
        <TabsContent value="upload">
          <div className="space-y-4 mt-4">
            <FileDropZone onFileSelected={handleFileUpload} />

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
                <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium">CSV</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Standard CSV transaction files. Automatically parsed and previewed with deduplication.
                    </p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium">Excel (.xlsx, .xls)</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Map spreadsheet columns to transaction fields with a visual mapper.
                    </p>
                  </div>
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium">PDF</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Bank statements are parsed using table detection. Assign an account before importing.
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
                    <li>Forward your bank statement email (or attach CSV/Excel/PDF files) to the address above.</li>
                    <li>Attachments are automatically extracted and parsed.</li>
                    <li>Duplicate transactions are detected and skipped.</li>
                    <li>You&apos;ll receive a notification when the import completes.</li>
                  </ol>
                </div>
              </CardContent>
            </Card>
          </div>
        </TabsContent>

        {/* Tab 3: Structured CSV Import (existing flow) */}
        <TabsContent value="structured">
          <div className="space-y-4 mt-4">
            <p className="text-sm text-muted-foreground">
              Import your CSV files in order: Accounts, Categories, Portfolio, then Transactions.
            </p>

            {/* Progress indicator */}
            <div className="flex items-center gap-2">
              {importSteps.map((step, i) => (
                <div key={step.type} className="flex items-center gap-2">
                  <div className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-bold ${
                    statuses[step.type] === "success"
                      ? "bg-emerald-100 text-emerald-700"
                      : statuses[step.type] === "error"
                        ? "bg-rose-100 text-rose-700"
                        : "bg-muted text-muted-foreground"
                  }`}>
                    {statuses[step.type] === "success" ? <CheckCircle2 className="h-4 w-4" /> : i + 1}
                  </div>
                  {i < importSteps.length - 1 && (
                    <div className={`h-0.5 w-8 rounded-full ${statuses[step.type] === "success" ? "bg-emerald-300" : "bg-muted"}`} />
                  )}
                </div>
              ))}
              <span className="text-xs text-muted-foreground ml-2">{completedCount}/{importSteps.length} complete</span>
            </div>

            {importSteps.map((step) => {
              const StepIcon = step.icon;
              return (
                <Card key={step.type} className={statuses[step.type] === "success" ? "border-emerald-200 bg-emerald-50/30" : ""}>
                  <CardHeader>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-3">
                        <div className={`flex h-10 w-10 items-center justify-center rounded-xl ${step.iconBg}`}>
                          <StepIcon className="h-5 w-5" />
                        </div>
                        <div>
                          <CardTitle className="text-base">{step.label}</CardTitle>
                          <CardDescription className="text-xs">{step.description}</CardDescription>
                        </div>
                      </div>
                      {statuses[step.type] === "success" && (
                        <Badge variant="default" className="bg-emerald-600 text-white">
                          <CheckCircle2 className="h-3 w-3 mr-1" />
                          Done
                        </Badge>
                      )}
                      {statuses[step.type] === "error" && (
                        <Badge variant="destructive">
                          <AlertCircle className="h-3 w-3 mr-1" />
                          Error
                        </Badge>
                      )}
                    </div>
                  </CardHeader>
                  <CardContent>
                    <div className="flex items-center gap-4 flex-1">
                        <input
                          type="file"
                          accept=".csv"
                          className="hidden"
                          ref={(el) => { fileInputRefs.current[step.type] = el; }}
                          onChange={(e) => {
                            const file = e.target.files?.[0];
                            if (file) handleStructuredImport(step.type, file);
                            e.target.value = "";
                          }}
                        />
                        <Button
                          variant={statuses[step.type] === "success" ? "outline" : "default"}
                          className="w-full cursor-pointer"
                          disabled={statuses[step.type] === "loading"}
                          onClick={() => fileInputRefs.current[step.type]?.click()}
                        >
                          <Upload className="h-4 w-4 mr-2" />
                          {statuses[step.type] === "loading"
                            ? "Importing..."
                            : statuses[step.type] === "success"
                              ? "Re-upload"
                              : `Upload ${step.file}`}
                        </Button>
                    </div>
                    {results[step.type] && (
                      <p className="text-xs text-muted-foreground mt-2">
                        Imported <span className="font-semibold text-emerald-600">{results[step.type]!.imported}</span> of {results[step.type]!.total} rows
                        {results[step.type]!.skippedDuplicates ? (
                          <span className="text-amber-600 ml-1">({results[step.type]!.skippedDuplicates} duplicates skipped)</span>
                        ) : null}
                      </p>
                    )}
                    {errors[step.type] && (
                      <p className="text-xs text-rose-600 mt-2">{errors[step.type]}</p>
                    )}
                  </CardContent>
                </Card>
              );
            })}
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
      />

      {excelFile && (
        <ExcelMapperDialog
          open={excelMapperOpen}
          onOpenChange={setExcelMapperOpen}
          sheets={excelSheets}
          file={excelFile}
          onMapped={handleExcelMapped}
          isMapping={isExcelMapping}
        />
      )}

      <PdfPreview
        open={pdfPreviewOpen}
        onOpenChange={setPdfPreviewOpen}
        rows={pdfRows}
        confidence={pdfConfidence}
        rawText={pdfRawText}
        accounts={accounts}
        onConfirm={handlePdfConfirm}
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
