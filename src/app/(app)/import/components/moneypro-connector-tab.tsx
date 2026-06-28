"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { Combobox } from "@/components/ui/combobox";
import {
  AlertCircle,
  CheckCircle2,
  Clipboard,
  ClipboardCheck,
  Download,
  FileSpreadsheet,
  Loader2,
  Upload,
} from "lucide-react";
import { exportCsv } from "@/lib/csv-export";
import { todayISO } from "@/lib/utils/date";

interface AccountPlan {
  sourceName: string;
  currency: string;
  txCount: number;
  matchedAccountId: number | null;
  matchedAccountName: string | null;
}

interface Summary {
  totalRows: number;
  transactions: number;
  transfers: number;
  accounts: AccountPlan[];
  categories: string[];
  rowErrors: Array<{ row: number; reason: string }>;
}

interface FinlynqAccount {
  id: number;
  name: string;
  currency: string;
}

type Stage = "idle" | "previewing" | "preview-ready" | "executing" | "executed";

type Choice =
  | { mode: "existing"; accountId: number }
  | { mode: "create"; currency: string; type: "A" | "L" };

/**
 * Collapsible, scrollable list of import issue messages. Each message is
 * self-describing (skipped rows vs. "imported anyway" warnings), so the list
 * is the "report" users asked for instead of a bare count.
 *
 * When expanded, a Download (.csv) and Copy-to-clipboard control let users
 * save the full warning list for offline tracking (FINLYNQ-237).
 */
function IssueDetails({ title, items }: { title: string; items: string[] }) {
  const [copied, setCopied] = useState(false);

  if (items.length === 0) return null;

  function handleDownload() {
    exportCsv(
      items.map((text) => ({ text })),
      [{ header: "Warning", accessor: (r: { text: string }) => r.text }],
      `import-warnings-${todayISO()}.csv`,
    );
  }

  async function handleCopy() {
    try {
      await navigator.clipboard.writeText(items.join("\n"));
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch {
      // clipboard unavailable — silently ignore
    }
  }

  return (
    <details className="rounded-md border border-amber-500/30 bg-amber-500/5 text-xs">
      <summary className="flex cursor-pointer select-none items-center gap-1.5 px-3 py-2 font-medium text-amber-700 dark:text-amber-400">
        <AlertCircle className="h-3.5 w-3.5 shrink-0" />
        {title} ({items.length})
      </summary>
      <ul className="max-h-48 list-disc space-y-1 overflow-y-auto border-t border-amber-500/20 px-6 py-2 text-[11px] leading-snug text-muted-foreground">
        {items.map((msg, i) => (
          <li key={i}>{msg}</li>
        ))}
      </ul>
      <div className="flex items-center gap-2 border-t border-amber-500/20 px-3 py-1.5">
        <button
          type="button"
          onClick={handleDownload}
          className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400 hover:underline"
        >
          <Download className="h-3 w-3" />
          Download .csv
        </button>
        <span className="text-amber-500/40">·</span>
        <button
          type="button"
          onClick={handleCopy}
          className="flex items-center gap-1 text-[11px] text-amber-700 dark:text-amber-400 hover:underline"
        >
          {copied ? (
            <ClipboardCheck className="h-3 w-3" />
          ) : (
            <Clipboard className="h-3 w-3" />
          )}
          {copied ? "Copied!" : "Copy to clipboard"}
        </button>
      </div>
    </details>
  );
}

export function MoneyProConnectorTab() {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);
  const [summary, setSummary] = useState<Summary | null>(null);
  const [accounts, setAccounts] = useState<FinlynqAccount[]>([]);
  // Per source-account UI state: "new" or `id:<n>`, plus a type for new ones.
  const [target, setTarget] = useState<Record<string, string>>({});
  const [newType, setNewType] = useState<Record<string, "A" | "L">>({});
  const [result, setResult] = useState<{
    imported: number;
    skippedDuplicates: number;
    accountsCreated: number;
    categoriesCreated: number;
    errors?: string[];
  } | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Options for the searchable account picker — shared across every row.
  const accountItems = useMemo(
    () => [
      { value: "new", label: "+ Create new account" },
      ...accounts.map((a) => ({
        value: `id:${a.id}`,
        label: `${a.name} (${a.currency})`,
      })),
    ],
    [accounts],
  );

  useEffect(() => {
    fetch("/api/accounts")
      .then((r) => r.json())
      .then((data) => {
        if (Array.isArray(data)) {
          setAccounts(
            data.map((a: { id: number; name: string; currency: string }) => ({
              id: a.id,
              name: a.name,
              currency: a.currency,
            })),
          );
        }
      })
      .catch(() => {});
  }, []);

  const onFileChosen = useCallback((f: File | null) => {
    setFile(f);
    setError(null);
    setSummary(null);
    setResult(null);
    setStage("idle");
  }, []);

  const runPreview = useCallback(async () => {
    if (!file) return;
    setStage("previewing");
    setError(null);
    try {
      const fd = new FormData();
      fd.append("file", file);
      const res = await fetch("/api/import/connectors/moneypro/preview", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = (await res.json()) as Summary;
      setSummary(data);
      // Seed mapping defaults: matched → that account, else create new.
      const t: Record<string, string> = {};
      const nt: Record<string, "A" | "L"> = {};
      for (const p of data.accounts) {
        t[p.sourceName] = p.matchedAccountId ? `id:${p.matchedAccountId}` : "new";
        nt[p.sourceName] = "A";
      }
      setTarget(t);
      setNewType(nt);
      setStage("preview-ready");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Preview failed");
      setStage("idle");
    }
  }, [file]);

  const runExecute = useCallback(async () => {
    if (!file || !summary) return;
    setStage("executing");
    setError(null);
    try {
      const choices: Record<string, Choice> = {};
      for (const p of summary.accounts) {
        const sel = target[p.sourceName] ?? "new";
        if (sel.startsWith("id:")) {
          choices[p.sourceName] = { mode: "existing", accountId: Number(sel.slice(3)) };
        } else {
          choices[p.sourceName] = {
            mode: "create",
            currency: p.currency,
            type: newType[p.sourceName] ?? "A",
          };
        }
      }
      const fd = new FormData();
      fd.append("file", file);
      fd.append("choices", JSON.stringify(choices));
      const res = await fetch("/api/import/connectors/moneypro/execute", {
        method: "POST",
        body: fd,
      });
      if (!res.ok) {
        const j = await res.json().catch(() => ({}));
        throw new Error(j.error ?? `HTTP ${res.status}`);
      }
      const data = await res.json();
      setResult({
        imported: data.imported,
        skippedDuplicates: data.skippedDuplicates,
        accountsCreated: data.accountsCreated,
        categoriesCreated: data.categoriesCreated,
        errors: data.errors,
      });
      setStage("executed");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Import failed");
      setStage("preview-ready");
    }
  }, [file, summary, target, newType]);

  const busy = stage === "previewing" || stage === "executing";

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Money Pro
          </CardTitle>
          <CardDescription>
            Migrate your Money Pro history to Finlynq. In Money Pro, open the{" "}
            <span className="font-medium">Transactions report</span> and export
            it as <span className="font-mono">CSV</span>, then upload it here.
            Expenses, income, transfers, and opening balances are imported with
            the right sign and currency.
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          {error && (
            <div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/10 p-3 text-sm">
              <AlertCircle className="h-4 w-4 mt-0.5 shrink-0 text-destructive" />
              <div className="flex-1">{error}</div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-2">
            <input
              ref={fileInputRef}
              type="file"
              accept=".csv,text/csv"
              className="hidden"
              onChange={(e) => onFileChosen(e.target.files?.[0] ?? null)}
            />
            <Button
              variant="outline"
              size="sm"
              onClick={() => fileInputRef.current?.click()}
            >
              <Upload className="h-3.5 w-3.5 mr-1.5" />
              {file ? "Choose a different file" : "Choose CSV file"}
            </Button>
            {file && (
              <>
                <Badge variant="secondary" className="font-mono text-xs">
                  {file.name} ({Math.round(file.size / 1024)} KB)
                </Badge>
                <Button size="sm" onClick={runPreview} disabled={busy}>
                  {stage === "previewing" && (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  )}
                  {stage === "executed" ? "Re-preview" : "Preview import"}
                </Button>
              </>
            )}
          </div>

          {summary && stage !== "executed" && (
            <div className="space-y-4">
              <div className="rounded-md border bg-muted/30 p-3 text-xs font-mono">
                {summary.transactions.toLocaleString()} transactions ·{" "}
                {summary.transfers} transfers · {summary.categories.length}{" "}
                categories
                {summary.rowErrors.length > 0 && (
                  <span className="text-amber-600 dark:text-amber-400">
                    {" "}
                    · {summary.rowErrors.length} rows skipped
                  </span>
                )}
              </div>

              <IssueDetails
                title="Rows skipped while reading the file"
                items={summary.rowErrors.map(
                  (e) => `Row ${e.row}: ${e.reason}`,
                )}
              />

              <div className="space-y-2">
                <h3 className="text-sm font-medium">Map accounts</h3>
                <p className="text-xs text-muted-foreground">
                  Each Money Pro account becomes a Finlynq account. Matched names
                  are linked automatically; the rest are created new.
                </p>
                <div className="rounded-md border divide-y">
                  {summary.accounts.map((p) => {
                    const sel = target[p.sourceName] ?? "new";
                    return (
                      <div
                        key={p.sourceName}
                        className="flex flex-wrap items-center gap-2 p-2.5 text-sm"
                      >
                        <div className="flex-1 min-w-[160px]">
                          <span className="font-medium">{p.sourceName}</span>
                          <span className="text-muted-foreground text-xs ml-2 font-mono">
                            {p.currency} · {p.txCount} tx
                          </span>
                        </div>
                        <Combobox
                          value={sel}
                          onValueChange={(v) =>
                            setTarget((prev) => ({
                              ...prev,
                              [p.sourceName]: v || "new",
                            }))
                          }
                          items={accountItems}
                          placeholder="Select account"
                          searchPlaceholder="Search accounts…"
                          emptyMessage="No matching account"
                          className="h-8 w-[220px]"
                        />
                        {sel === "new" && (
                          <Select
                            value={newType[p.sourceName] ?? "A"}
                            onValueChange={(v) =>
                              setNewType((prev) => ({
                                ...prev,
                                [p.sourceName]: (v as "A" | "L") ?? "A",
                              }))
                            }
                          >
                            <SelectTrigger className="w-[110px] h-8">
                              <SelectValue />
                            </SelectTrigger>
                            <SelectContent>
                              <SelectItem value="A">Asset</SelectItem>
                              <SelectItem value="L">Liability</SelectItem>
                            </SelectContent>
                          </Select>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>

              <Button onClick={runExecute} disabled={busy}>
                {stage === "executing" && (
                  <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                )}
                Import {summary.transactions.toLocaleString()} transactions
              </Button>
            </div>
          )}

          {result && stage === "executed" && (
            <div className="rounded-md border border-green-500/30 bg-green-500/5 p-3 text-sm space-y-1">
              <div className="font-medium flex items-center gap-1.5">
                <CheckCircle2 className="h-4 w-4 text-green-600" />
                Import complete
              </div>
              <div className="text-xs text-muted-foreground font-mono space-y-0.5 mt-1">
                <div>Imported: {result.imported}</div>
                <div>Skipped duplicates: {result.skippedDuplicates}</div>
                <div>Accounts created: {result.accountsCreated}</div>
                <div>Categories created: {result.categoriesCreated}</div>
              </div>
              {result.errors && result.errors.length > 0 && (
                <IssueDetails title="Warnings" items={result.errors} />
              )}
            </div>
          )}
        </CardContent>
      </Card>
    </div>
  );
}
