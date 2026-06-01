"use client";

/**
 * /settings/data — Import + Export + Data Management/danger zone (issue #57).
 * Extracted from the monolith /settings/page.tsx.
 */

import { useState, useCallback } from "react";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import { Upload, FileText, Wallet, Tag, Briefcase, ArrowLeftRight, Database, Download, AlertTriangle, Trash2 } from "lucide-react";

type ImportRow = Record<string, string>;
type ImportSection = "accounts" | "categories" | "portfolio";

const exportItems = [
  { type: "accounts", label: "Accounts", icon: Wallet, iconColor: "text-violet-500" },
  { type: "categories", label: "Categories", icon: Tag, iconColor: "text-emerald-500" },
  { type: "transactions", label: "Transactions", icon: ArrowLeftRight, iconColor: "text-amber-500" },
  { type: "portfolio", label: "Portfolio", icon: Briefcase, iconColor: "text-cyan-500" },
];

export default function DataSettingsPage() {
  // CSV Import (accounts, categories, portfolio)
  const [importSection, setImportSection] = useState<ImportSection | null>(null);
  const [importPreview, setImportPreview] = useState<ImportRow[]>([]);
  const [importHeaders, setImportHeaders] = useState<string[]>([]);
  const [importFileName, setImportFileName] = useState("");
  const [importStatus, setImportStatus] = useState("");
  const [importLoading, setImportLoading] = useState(false);
  const [importAllRows, setImportAllRows] = useState<ImportRow[]>([]);

  // Export
  const [exportStatus, setExportStatus] = useState("");

  // Clear data (danger zone)
  const [clearConfirm, setClearConfirm] = useState("");
  const [clearStep, setClearStep] = useState(0); // 0=idle, 1=first confirm, 2=type DELETE
  const [clearStatus, setClearStatus] = useState("");

  // Delete account (danger zone) — irreversible: drops the user row + all data.
  const [delStep, setDelStep] = useState(0); // 0=idle, 1=warn, 2=password+confirm form
  const [delPassword, setDelPassword] = useState("");
  const [delConfirm, setDelConfirm] = useState("");
  const [delMfaCode, setDelMfaCode] = useState("");
  const [delMfaRequired, setDelMfaRequired] = useState(false);
  const [delStatus, setDelStatus] = useState("");
  const [delLoading, setDelLoading] = useState(false);

  function resetDeleteAccount() {
    setDelStep(0);
    setDelPassword("");
    setDelConfirm("");
    setDelMfaCode("");
    setDelMfaRequired(false);
    setDelStatus("");
    setDelLoading(false);
  }

  async function handleDeleteAccount() {
    if (delStep === 0) {
      setDelStep(1);
      return;
    }
    if (delStep === 1) {
      setDelStep(2);
      return;
    }
    // delStep === 2 — submit.
    if (delConfirm !== "DELETE") {
      setDelStatus("Type DELETE to confirm");
      return;
    }
    if (!delPassword) {
      setDelStatus("Enter your password");
      return;
    }
    setDelLoading(true);
    setDelStatus("");
    try {
      const res = await fetch("/api/auth/delete-account", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          password: delPassword,
          confirmation: delConfirm,
          mfaCode: delMfaCode || undefined,
        }),
      });
      if (res.ok) {
        // Account + session are gone — leave the app for the public home.
        window.location.href = "/";
        return;
      }
      const data = await res.json().catch(() => ({}));
      if (res.status === 401 && data?.code === "mfa-required") {
        setDelMfaRequired(true);
        setDelStatus("Enter your 6-digit authenticator code.");
      } else {
        setDelStatus(data?.error || "Failed to delete account");
      }
    } catch {
      setDelStatus("Failed to delete account");
    } finally {
      setDelLoading(false);
    }
  }

  const parseCSV = useCallback((text: string): { headers: string[]; rows: ImportRow[] } => {
    const lines = text.split(/\r?\n/).filter((l) => l.trim());
    if (lines.length < 2) return { headers: [], rows: [] };
    const headers = lines[0].split(",").map((h) => h.trim().replace(/^"|"$/g, ""));
    const rows: ImportRow[] = [];
    for (let i = 1; i < lines.length; i++) {
      const vals = lines[i].split(",").map((v) => v.trim().replace(/^"|"$/g, ""));
      const row: ImportRow = {};
      headers.forEach((h, j) => { row[h] = vals[j] ?? ""; });
      rows.push(row);
    }
    return { headers, rows };
  }, []);

  function handleImportFile(section: ImportSection, file: File) {
    setImportSection(section);
    setImportStatus("");
    setImportPreview([]);
    setImportAllRows([]);
    setImportFileName(file.name);

    const reader = new FileReader();
    reader.onload = (e) => {
      const text = e.target?.result as string;
      const { headers, rows } = parseCSV(text);
      if (rows.length === 0) { setImportStatus("File appears empty or has no data rows."); return; }
      setImportHeaders(headers);
      setImportPreview(rows.slice(0, 5));
      setImportAllRows(rows);
    };
    reader.readAsText(file);
  }

  async function handleImportConfirm() {
    if (!importSection || importAllRows.length === 0) return;
    setImportLoading(true);
    setImportStatus(`Importing ${importAllRows.length} rows…`);
    let ok = 0;
    let failed = 0;
    try {
      if (importSection === "accounts") {
        for (const row of importAllRows) {
          try {
            await fetch("/api/accounts", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: row.name || row.Name || "",
                type: row.type || row.Type || "A",
                group: row.group || row.Group || "Other",
                currency: row.currency || row.Currency || "CAD",
                note: row.note || row.Note || "",
              }),
            });
            ok++;
          } catch { failed++; }
        }
      } else if (importSection === "categories") {
        for (const row of importAllRows) {
          try {
            await fetch("/api/categories", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                name: row.name || row.Name || "",
                type: row.type || row.Type || "E",
                group: row.group || row.Group || "Other",
                note: row.note || row.Note || "",
              }),
            });
            ok++;
          } catch { failed++; }
        }
      } else if (importSection === "portfolio") {
        for (const row of importAllRows) {
          try {
            await fetch("/api/portfolio", {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                symbol: row.symbol || row.Symbol || row.ticker || "",
                name: row.name || row.Name || "",
                quantity: parseFloat(row.quantity || row.Quantity || "0") || 0,
                currency: row.currency || row.Currency || "CAD",
                note: row.note || row.Note || "",
              }),
            });
            ok++;
          } catch { failed++; }
        }
      }

      setImportStatus(`Imported ${ok} rows${failed > 0 ? `, ${failed} failed` : ""}.`);
      setImportPreview([]);
      setImportAllRows([]);
      setImportSection(null);
      setImportFileName("");
    } catch {
      setImportStatus("Import failed");
    } finally {
      setImportLoading(false);
    }
  }

  function handleImportFileInput(section: ImportSection) {
    return (e: React.ChangeEvent<HTMLInputElement>) => {
      const file = e.target.files?.[0];
      if (file) handleImportFile(section, file);
      e.target.value = "";
    };
  }

  function csvCell(val: unknown): string {
    const s = String(val ?? "");
    return s.includes(",") || s.includes('"') || s.includes("\n") ? `"${s.replace(/"/g, '""')}"` : s;
  }

  function buildCsv(rows: Record<string, unknown>[]): string {
    if (rows.length === 0) return "";
    const headers = Object.keys(rows[0]);
    return [headers.join(","), ...rows.map((r) => headers.map((h) => csvCell(r[h])).join(","))].join("\n");
  }

  async function handleExport(type: string) {
    setExportStatus(`Exporting ${type}...`);
    try {
      const res = await fetch(type === "transactions" ? `/api/${type}?limit=99999` : `/api/${type}`);
      const data = await res.json();
      let rows: Record<string, unknown>[] = Array.isArray(data) ? data : data.data ?? [];

      if (rows.length === 0) {
        setExportStatus("No data to export");
        return;
      }

      // For transactions: expand split transactions into individual split rows
      if (type === "transactions") {
        const splitsRes = await fetch("/api/transactions/splits");
        const allSplits: Array<{ transactionId: number; categoryId: number | null; accountId: number | null; amount: number; note: string; description: string; tags: string }> = splitsRes.ok ? await splitsRes.json() : [];
        const splitMap = new Map<number, typeof allSplits>();
        for (const s of allSplits) {
          const arr = splitMap.get(s.transactionId) ?? [];
          arr.push(s);
          splitMap.set(s.transactionId, arr);
        }

        const expanded: Record<string, unknown>[] = [];
        for (const txn of rows) {
          const txnId = txn.id as number;
          const splits = splitMap.get(txnId);
          if (splits && splits.length > 0) {
            // Emit one row per split; omit the parent's category, use split fields instead
            for (const s of splits) {
              expanded.push({
                ...txn,
                split_parent_id: txnId,
                categoryId: s.categoryId ?? "",
                amount: s.amount,
                note: s.note || txn.note,
                split_account_id: s.accountId ?? "",
                split_description: s.description,
                split_tags: s.tags,
              });
            }
          } else {
            expanded.push({ ...txn, split_parent_id: "" });
          }
        }
        rows = expanded;
      }

      const csv = buildCsv(rows);
      const blob = new Blob([csv], { type: "text/csv" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `${type}-export.csv`;
      a.click();
      URL.revokeObjectURL(url);
      setExportStatus(`${type} exported successfully`);
    } catch {
      setExportStatus("Export failed");
    }
  }

  async function handleClearData() {
    if (clearStep === 0) {
      setClearStep(1);
      return;
    }
    if (clearStep === 1) {
      setClearStep(2);
      return;
    }
    if (clearStep === 2) {
      if (clearConfirm !== "DELETE") {
        setClearStatus("Type DELETE to confirm");
        return;
      }
      try {
        const res = await fetch("/api/data", { method: "DELETE" });
        if (res.ok) {
          setClearStatus("All data cleared successfully");
          setClearStep(0);
          setClearConfirm("");
        } else {
          const data = await res.json();
          setClearStatus(data.error || "Failed to clear data");
        }
      } catch {
        setClearStatus("Failed to clear data");
      }
    }
  }

  return (
    <div className="max-w-2xl space-y-6">
      <div>
        <h1 className="text-2xl font-bold tracking-tight">Data</h1>
        <p className="text-sm text-muted-foreground mt-0.5">Import, export, and manage your data</p>
      </div>

      {/* CSV Import */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-teal-100 text-teal-600">
              <Upload className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Import Data</CardTitle>
              <CardDescription>Import accounts, categories, or portfolio holdings from CSV</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-4">
          {/* Import type buttons */}
          <div className="grid grid-cols-3 gap-3">
            {([
              { key: "accounts" as const, label: "Accounts", icon: Wallet, color: "text-violet-500", hint: "Columns: name, type, group, currency, note" },
              { key: "categories" as const, label: "Categories", icon: Tag, color: "text-emerald-500", hint: "Columns: name, type, group, note" },
              { key: "portfolio" as const, label: "Portfolio", icon: Briefcase, color: "text-cyan-500", hint: "Columns: symbol, name, quantity, currency, note" },
            ] as const).map(({ key, label, icon: Icon, color, hint }) => (
              <div key={key} className="space-y-1">
                <label className={`flex flex-col items-center gap-2 border rounded-lg p-3 cursor-pointer hover:bg-muted/50 transition-colors text-center ${importSection === key ? "border-primary bg-primary/5" : ""}`}>
                  <Icon className={`h-5 w-5 ${color}`} />
                  <span className="text-sm font-medium">{label}</span>
                  <span className="text-[10px] text-muted-foreground">{hint}</span>
                  <input
                    type="file"
                    accept=".csv"
                    className="sr-only"
                    onChange={handleImportFileInput(key)}
                  />
                </label>
              </div>
            ))}
          </div>

          {/* Preview */}
          {importPreview.length > 0 && importSection && (
            <div className="space-y-3">
              <div className="flex items-center gap-2 text-sm">
                <FileText className="h-4 w-4 text-muted-foreground" />
                <span className="font-medium truncate">{importFileName}</span>
                <Badge variant="outline" className="text-[10px]">Preview</Badge>
              </div>
              <div className="overflow-x-auto rounded border text-xs">
                <table className="w-full">
                  <thead>
                    <tr className="bg-muted/50">
                      {importHeaders.map((h) => (
                        <th key={h} className="px-2 py-1.5 text-left font-medium text-muted-foreground whitespace-nowrap">{h}</th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    {importPreview.map((row, i) => (
                      <tr key={i} className="border-t">
                        {importHeaders.map((h) => (
                          <td key={h} className="px-2 py-1.5 whitespace-nowrap">{row[h] ?? ""}</td>
                        ))}
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="text-[10px] text-muted-foreground">Showing first {importPreview.length} rows. Full file will be imported on confirm.</p>
              <div className="flex gap-2">
                <Button variant="outline" size="sm" onClick={() => { setImportPreview([]); setImportSection(null); setImportFileName(""); setImportStatus(""); }}>
                  Cancel
                </Button>
                <Button size="sm" onClick={handleImportConfirm} disabled={importLoading}>
                  {importLoading ? "Importing…" : `Import ${importSection}`}
                </Button>
              </div>
            </div>
          )}

          {importStatus && (
            <p className={`text-xs flex items-center gap-1 ${importStatus.includes("fail") || importStatus.includes("error") ? "text-destructive" : "text-muted-foreground"}`}>
              <Upload className="h-3 w-3" /> {importStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Data Export */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-indigo-100 text-indigo-600">
              <Database className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Data Export</CardTitle>
              <CardDescription>Export your data as CSV files</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          <div className="grid grid-cols-2 gap-3">
            {exportItems.map((item) => (
              <Button key={item.type} variant="outline" className="justify-start h-auto py-3 px-4" onClick={() => handleExport(item.type)}>
                <item.icon className={`h-4 w-4 mr-2 ${item.iconColor}`} />
                <div className="text-left">
                  <p className="text-sm font-medium">{item.label}</p>
                  <p className="text-[10px] text-muted-foreground">Download CSV</p>
                </div>
              </Button>
            ))}
          </div>
          {exportStatus && (
            <p className="text-xs text-muted-foreground flex items-center gap-1">
              <Download className="h-3 w-3" /> {exportStatus}
            </p>
          )}
        </CardContent>
      </Card>

      {/* Backfill transactions — canonicalization pipeline */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-amber-100 text-amber-600">
              <ArrowLeftRight className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Backfill transactions</CardTitle>
              <CardDescription>Canonicalize legacy or imported transactions so realized gains and lot tracking work</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent>
          <Button variant="outline" onClick={() => { window.location.href = "/settings/backfill"; }}>
            Open backfill wizard
          </Button>
          <p className="text-xs text-muted-foreground mt-2">
            Reviews proposals before applying. Won&apos;t change account balances. <a href="/settings/backfill" className="underline">Learn more</a>.
          </p>
        </CardContent>
      </Card>

      {/* Data Management — danger zone */}
      <Card>
        <CardHeader>
          <div className="flex items-center gap-3">
            <div className="flex h-10 w-10 items-center justify-center rounded-xl bg-rose-100 text-rose-600">
              <AlertTriangle className="h-5 w-5" />
            </div>
            <div>
              <CardTitle className="text-base">Data Management</CardTitle>
              <CardDescription>Danger zone - destructive actions</CardDescription>
            </div>
          </div>
        </CardHeader>
        <CardContent className="space-y-3">
          {clearStep === 0 && (
            <Button variant="outline" className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={handleClearData}>
              <Trash2 className="h-4 w-4 mr-2" />
              Clear All Data
            </Button>
          )}

          {clearStep === 1 && (
            <div className="space-y-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
              <p className="text-sm font-medium text-destructive">Are you sure? This will permanently delete all your data.</p>
              <div className="flex gap-2">
                <Button variant="destructive" size="sm" onClick={handleClearData}>Yes, I want to delete everything</Button>
                <Button variant="ghost" size="sm" onClick={() => setClearStep(0)}>Cancel</Button>
              </div>
            </div>
          )}

          {clearStep === 2 && (
            <div className="space-y-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
              <p className="text-sm font-medium text-destructive">Type DELETE to confirm permanent deletion of all data:</p>
              <div className="flex gap-2">
                <Input
                  value={clearConfirm}
                  onChange={(e) => setClearConfirm(e.target.value)}
                  placeholder="Type DELETE"
                  className="max-w-40"
                />
                <Button variant="destructive" size="sm" onClick={handleClearData} disabled={clearConfirm !== "DELETE"}>Confirm</Button>
                <Button variant="ghost" size="sm" onClick={() => { setClearStep(0); setClearConfirm(""); setClearStatus(""); }}>Cancel</Button>
              </div>
            </div>
          )}

          {clearStatus && (
            <p className={`text-xs ${clearStatus.includes("success") ? "text-emerald-600" : "text-destructive"}`}>
              {clearStatus}
            </p>
          )}

          {/* Delete account — irreversible: removes your login + all data */}
          <div className="pt-3 mt-1 border-t border-border/60 space-y-3">
            {delStep === 0 && (
              <div className="space-y-1.5">
                <Button variant="outline" className="border-destructive text-destructive hover:bg-destructive hover:text-destructive-foreground" onClick={handleDeleteAccount}>
                  <Trash2 className="h-4 w-4 mr-2" />
                  Delete Account
                </Button>
                <p className="text-xs text-muted-foreground">Permanently deletes your account, login, and all data.</p>
              </div>
            )}

            {delStep === 1 && (
              <div className="space-y-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                <p className="text-sm font-medium text-destructive">This permanently deletes your account and all of your data, including your login. This cannot be undone.</p>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={handleDeleteAccount}>Continue</Button>
                  <Button variant="ghost" size="sm" onClick={resetDeleteAccount}>Cancel</Button>
                </div>
              </div>
            )}

            {delStep === 2 && (
              <div className="space-y-3 p-3 rounded-lg border border-destructive/30 bg-destructive/5">
                <p className="text-sm font-medium text-destructive">Confirm permanent account deletion:</p>
                <div className="space-y-2">
                  <Input
                    type="password"
                    value={delPassword}
                    onChange={(e) => setDelPassword(e.target.value)}
                    placeholder="Your password"
                    autoComplete="current-password"
                    className="max-w-xs"
                  />
                  <Input
                    value={delConfirm}
                    onChange={(e) => setDelConfirm(e.target.value)}
                    placeholder="Type DELETE"
                    className="max-w-40"
                  />
                  {delMfaRequired && (
                    <Input
                      value={delMfaCode}
                      onChange={(e) => setDelMfaCode(e.target.value)}
                      placeholder="6-digit code"
                      inputMode="numeric"
                      maxLength={6}
                      className="max-w-40"
                    />
                  )}
                </div>
                <div className="flex gap-2">
                  <Button variant="destructive" size="sm" onClick={handleDeleteAccount} disabled={delLoading || delConfirm !== "DELETE" || !delPassword}>
                    {delLoading ? "Deleting…" : "Delete my account"}
                  </Button>
                  <Button variant="ghost" size="sm" onClick={resetDeleteAccount} disabled={delLoading}>Cancel</Button>
                </div>
              </div>
            )}

            {delStatus && (
              <p className="text-xs text-destructive">{delStatus}</p>
            )}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
