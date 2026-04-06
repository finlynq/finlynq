"use client";

import { useState, useEffect, useCallback } from "react";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { OnboardingTips } from "@/components/onboarding-tips";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import {
  Upload,
  CheckCircle2,
  AlertCircle,
  Mail,
  Copy,
  RefreshCw,
} from "lucide-react";
import { FileDropZone } from "./components/file-drop-zone";
import { ImportPreviewDialog } from "./components/import-preview-dialog";
import { OfxPreview } from "./components/ofx-preview";
import type { RawTransaction } from "@/lib/import-pipeline";
import type { OfxTransaction, OfxAccountInfo } from "@/lib/ofx-parser";

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
      } else if (data.type === "csv" || data.valid !== undefined) {
        // CSV — show preview dialog directly
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
                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="rounded-lg border p-3">
                    <p className="text-sm font-medium">CSV</p>
                    <p className="text-xs text-muted-foreground mt-1">
                      Standard CSV transaction files. Automatically parsed and previewed with deduplication.
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
