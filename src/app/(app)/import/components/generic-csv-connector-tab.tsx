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
import { Input } from "@/components/ui/input";
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

// Logical fields the importer understands. Required ones can't be unmapped.
const FIELDS = [
  { key: "date", label: "Date", required: true },
  { key: "amount", label: "Amount", required: true },
  { key: "account", label: "Account", required: true },
  { key: "currency", label: "Currency", required: false },
  { key: "note", label: "Description / note", required: false },
  { key: "category", label: "Category", required: false },
  { key: "accountTo", label: "Transfer to (account)", required: false },
  { key: "amountTo", label: "Amount received (FX transfer)", required: false },
  { key: "currencyTo", label: "Currency received (FX transfer)", required: false },
] as const;

type FieldKey = (typeof FIELDS)[number]["key"];
type Mapping = Partial<Record<FieldKey, string>>;

const NONE = "__none__";

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

interface PreviewResponse {
  headers: string[];
  sampleRows: Array<Record<string, string>>;
  mapping: Mapping;
  missingRequired: FieldKey[];
  mappingComplete: boolean;
  summary: Summary | null;
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
 * Collapsible, scrollable list of import issue messages.
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

export function GenericCsvConnectorTab() {
  const [file, setFile] = useState<File | null>(null);
  const [stage, setStage] = useState<Stage>("idle");
  const [error, setError] = useState<string | null>(null);

  const [headers, setHeaders] = useState<string[]>([]);
  const [sampleRows, setSampleRows] = useState<Array<Record<string, string>>>([]);
  const [mapping, setMapping] = useState<Mapping>({});
  const [missingRequired, setMissingRequired] = useState<FieldKey[]>([]);
  const [summary, setSummary] = useState<Summary | null>(null);

  const [defaultCurrency, setDefaultCurrency] = useState("");
  const [includeOpening, setIncludeOpening] = useState(true);

  const [accounts, setAccounts] = useState<FinlynqAccount[]>([]);
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
    setHeaders([]);
    setSampleRows([]);
    setMapping({});
    setMissingRequired([]);
    setStage("idle");
  }, []);

  // Seed account targets for any source account we haven't seen yet (preserves
  // the user's existing choices across mapping refreshes).
  const seedTargets = useCallback((plans: AccountPlan[]) => {
    setTarget((prev) => {
      const next = { ...prev };
      for (const p of plans) {
        if (next[p.sourceName] === undefined) {
          next[p.sourceName] = p.matchedAccountId ? `id:${p.matchedAccountId}` : "new";
        }
      }
      return next;
    });
    setNewType((prev) => {
      const next = { ...prev };
      for (const p of plans) if (next[p.sourceName] === undefined) next[p.sourceName] = "A";
      return next;
    });
  }, []);

  const runPreview = useCallback(
    async (mappingArg?: Mapping) => {
      if (!file) return;
      setStage("previewing");
      setError(null);
      try {
        const fd = new FormData();
        fd.append("file", file);
        if (mappingArg) fd.append("mapping", JSON.stringify(mappingArg));
        if (defaultCurrency.trim()) fd.append("defaultCurrency", defaultCurrency.trim());
        if (!includeOpening) fd.append("includeOpeningBalance", "0");
        const res = await fetch("/api/import/connectors/generic-csv/preview", {
          method: "POST",
          body: fd,
        });
        if (!res.ok) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j.error ?? `HTTP ${res.status}`);
        }
        const data = (await res.json()) as PreviewResponse;
        setHeaders(data.headers);
        setSampleRows(data.sampleRows);
        // On the FIRST preview adopt the server's suggested mapping; on refreshes
        // keep the user's mapping (we passed it in).
        if (!mappingArg) setMapping(data.mapping);
        setMissingRequired(data.missingRequired);
        setSummary(data.summary);
        if (data.summary) seedTargets(data.summary.accounts);
        setStage("preview-ready");
      } catch (err) {
        setError(err instanceof Error ? err.message : "Preview failed");
        setStage(headers.length ? "preview-ready" : "idle");
      }
    },
    [file, defaultCurrency, includeOpening, seedTargets, headers.length],
  );

  // Change one mapped column and re-preview with the new mapping.
  const setFieldHeader = useCallback(
    (field: FieldKey, headerOrNone: string) => {
      const next: Mapping = { ...mapping };
      if (headerOrNone === NONE || !headerOrNone) delete next[field];
      else next[field] = headerOrNone;
      setMapping(next);
      runPreview(next);
    },
    [mapping, runPreview],
  );

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
      fd.append("mapping", JSON.stringify(mapping));
      fd.append("choices", JSON.stringify(choices));
      if (defaultCurrency.trim()) fd.append("defaultCurrency", defaultCurrency.trim());
      if (!includeOpening) fd.append("includeOpeningBalance", "0");
      const res = await fetch("/api/import/connectors/generic-csv/execute", {
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
  }, [file, summary, target, newType, mapping, defaultCurrency, includeOpening]);

  const busy = stage === "previewing" || stage === "executing";
  const showMapper = stage === "preview-ready" || (stage === "executing" && !!summary);

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2">
            <FileSpreadsheet className="h-4 w-4" />
            Generic CSV (full ledger)
          </CardTitle>
          <CardDescription>
            Migrate a whole-portfolio export from any app — one CSV with{" "}
            <span className="font-mono">date</span>,{" "}
            <span className="font-mono">amount</span>,{" "}
            <span className="font-mono">account</span> columns (plus optional
            currency, category, note and a transfer-destination column). Columns
            are auto-detected; adjust the mapping below if a column isn&apos;t
            picked up. Transfers, opening balances, and multiple currencies are
            handled. For a <span className="font-medium">cross-currency
            transfer</span>, also map the{" "}
            <span className="font-mono">amount received</span> and{" "}
            <span className="font-mono">currency received</span> columns so each
            side is recorded in its own currency.
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
                <Button size="sm" onClick={() => runPreview()} disabled={busy}>
                  {stage === "previewing" && (
                    <Loader2 className="h-3.5 w-3.5 mr-1.5 animate-spin" />
                  )}
                  {stage === "executed" ? "Re-preview" : "Preview import"}
                </Button>
              </>
            )}
          </div>

          {showMapper && headers.length > 0 && (
            <div className="space-y-4">
              {/* Column mapping */}
              <div className="space-y-2">
                <h3 className="text-sm font-medium">Match columns</h3>
                <p className="text-xs text-muted-foreground">
                  Tell Finlynq which column holds each field. Required fields are
                  marked with <span className="text-destructive">*</span>.
                </p>
                <div className="grid gap-2 sm:grid-cols-2">
                  {FIELDS.map((f) => (
                    <div key={f.key} className="flex items-center gap-2">
                      <label className="w-40 shrink-0 text-xs text-muted-foreground">
                        {f.label}
                        {f.required && <span className="text-destructive"> *</span>}
                      </label>
                      <Select
                        value={mapping[f.key] ?? NONE}
                        onValueChange={(v) => setFieldHeader(f.key, v ?? NONE)}
                      >
                        <SelectTrigger
                          className={`h-8 flex-1 ${
                            f.required && !mapping[f.key]
                              ? "border-destructive/60"
                              : ""
                          }`}
                        >
                          <SelectValue placeholder="— Not mapped —" />
                        </SelectTrigger>
                        <SelectContent>
                          {!f.required && <SelectItem value={NONE}>— Not mapped —</SelectItem>}
                          {headers.map((h) => (
                            <SelectItem key={h} value={h}>
                              {h}
                            </SelectItem>
                          ))}
                        </SelectContent>
                      </Select>
                    </div>
                  ))}
                </div>
                {missingRequired.length > 0 && (
                  <p className="text-xs text-destructive">
                    Map the required field(s): {missingRequired.join(", ")}.
                  </p>
                )}
              </div>

              {/* Sample preview */}
              {sampleRows.length > 0 && (
                <div className="space-y-1">
                  <h4 className="text-xs font-medium text-muted-foreground">
                    First {sampleRows.length} rows
                  </h4>
                  <div className="overflow-x-auto rounded-md border">
                    <table className="w-full text-[11px]">
                      <thead className="bg-muted/40">
                        <tr>
                          {headers.map((h) => (
                            <th key={h} className="px-2 py-1 text-left font-mono font-medium">
                              {h}
                            </th>
                          ))}
                        </tr>
                      </thead>
                      <tbody>
                        {sampleRows.map((row, i) => (
                          <tr key={i} className="border-t">
                            {headers.map((h) => (
                              <td key={h} className="whitespace-nowrap px-2 py-1 text-muted-foreground">
                                {row[h] ?? ""}
                              </td>
                            ))}
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}

              {/* Options */}
              <div className="flex flex-wrap items-center gap-4">
                <div className="flex items-center gap-2">
                  <label className="text-xs text-muted-foreground">
                    Default currency
                  </label>
                  <Input
                    value={defaultCurrency}
                    onChange={(e) => setDefaultCurrency(e.target.value.toUpperCase())}
                    onBlur={() => mapping.date && mapping.amount && mapping.account && runPreview(mapping)}
                    placeholder="USD"
                    className="h-8 w-24 font-mono"
                    maxLength={10}
                  />
                </div>
                <label className="flex items-center gap-2 text-xs text-muted-foreground">
                  <input
                    type="checkbox"
                    checked={includeOpening}
                    onChange={(e) => {
                      setIncludeOpening(e.target.checked);
                      if (mapping.date && mapping.amount && mapping.account) runPreview(mapping);
                    }}
                  />
                  Import opening-balance rows
                </label>
              </div>

              {summary && (
                <>
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
                    items={summary.rowErrors.map((e) => `Row ${e.row}: ${e.reason}`)}
                  />

                  <div className="space-y-2">
                    <h3 className="text-sm font-medium">Map accounts</h3>
                    <p className="text-xs text-muted-foreground">
                      Each source account becomes a Finlynq account. Matched names
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
                </>
              )}
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
