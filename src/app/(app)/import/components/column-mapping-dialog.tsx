"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogDescription,
  DialogFooter,
} from "@/components/ui/dialog";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { AlertCircle, Loader2, Sparkles } from "lucide-react";
import type { ColumnMapping, DateFormatOverride } from "@/lib/import-templates";
// Pure, dependency-free module — importing parseAmount from "@/lib/csv-parser"
// would drag its server-only `@/db` (pg → dns/fs) import into this client bundle.
import { parseAmount } from "@/lib/parse-amount";
import { SUPPORTED_CURRENCIES } from "@/lib/fx/supported-currencies";

type DateFormatUi = "auto" | DateFormatOverride;

/** Fresh column detection for a given skip — returned by the parent's re-parse. */
export interface ReparseResult {
  headers: string[];
  sampleRows: Record<string, string>[];
  suggestedMapping: ColumnMapping | null;
}

interface ColumnMappingDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  fileName: string;
  headers: string[];
  sampleRows: Record<string, string>[];
  suggestedMapping: ColumnMapping | null;
  accounts: string[];
  /**
   * Re-parse the same file with new skip values and return fresh columns /
   * sample / suggestion. Parent owns the fetch (it holds the File). Called
   * debounced when the user changes "Skip N header/footer rows".
   */
  onReparse: (skipHeaderRows: number, skipFooterRows: number) => Promise<ReparseResult>;
  /** Submits the confirmed mapping. Parent handles the csv-map call + template save. */
  onConfirm: (params: {
    mapping: ColumnMapping;
    defaultAccount: string | null;
    templateName: string;
    skipHeaderRows: number;
    skipFooterRows: number;
    defaultCurrency: string | null;
    /** Date-format override; `null` means auto-detect. */
    dateFormatOverride: DateFormatOverride | null;
    /** The headers the mapping was built against — reflects any re-detect, so
     *  the saved template stores the REAL column names, not the pre-trim junk row. */
    headers: string[];
    /** §B (2026-06-04) — only meaningful in confirm mode: the user ticked
     *  "Don't ask again for this account" → flip the account to 'auto'. */
    dontAskAgain?: boolean;
  }) => Promise<void>;
  submitting: boolean;
  /**
   * §B (2026-06-04) — when true the dialog was opened to CONFIRM a mapping the
   * pipeline auto-detected (the csv-confirm-mapping 422), not because nothing
   * matched. Shows confirm-tailored copy + the "Don't ask again for this
   * account" checkbox. Default false preserves the needs-mapping behavior.
   */
  confirmMode?: boolean;
  /**
   * FINLYNQ-195 — when the import target is an investment account, offer the
   * three investment-specific column mappings (Ticker/Symbol, Security name,
   * Quantity). Default false: a NON-investment account never sees/persists
   * them, so the cash import flow is byte-identical. v1 captures these into
   * staging / bank_transactions only — no lot-aware portfolio materialization.
   */
  isInvestment?: boolean;
}

// flipSign is a boolean knob (rendered as a checkbox below), not a column
// dropdown, so it's excluded from the field→header label map. The FINLYNQ-195
// investment columns (ticker / portfolioHolding / quantity) are also excluded —
// they render in their own investment-only section, not the cash field table.
type MappingColumnField = Exclude<
  keyof ColumnMapping,
  "flipSign" | "ticker" | "portfolioHolding" | "quantity"
>;

const FIELD_LABELS: Record<MappingColumnField, string> = {
  date: "Date *",
  amount: "Amount *",
  account: "Account",
  payee: "Payee / Description",
  category: "Category",
  currency: "Currency",
  note: "Note",
  tags: "Tags",
  // 2026-05-24 — per-row "Balance" column. Optional. When mapped, the
  // parser captures one anchor per date (last-in-file-order's value).
  balance: "Balance (running)",
};
const MAPPING_FIELDS = Object.keys(FIELD_LABELS) as MappingColumnField[];
const NONE = "__none__";

// FINLYNQ-195 — investment-account-only column mappings. Rendered as a separate
// section below the cash fields ONLY when `isInvestment` is set. `quantity` is
// numeric; `ticker` / `portfolioHolding` are the security SYMBOL / NAME.
type InvestmentColumnField = "ticker" | "portfolioHolding" | "quantity";
const INVESTMENT_FIELD_LABELS: Record<InvestmentColumnField, string> = {
  ticker: "Ticker / Symbol",
  portfolioHolding: "Security name",
  quantity: "Quantity",
};
const INVESTMENT_FIELDS = Object.keys(
  INVESTMENT_FIELD_LABELS,
) as InvestmentColumnField[];

/** Clamp a string skip input to an integer in [0, 100]. */
function clampSkip(raw: string): number {
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : 0;
}

/** Derive a sensible default template name from the file name. */
function defaultTemplateName(fileName: string): string {
  // "download-transactions (6).csv" → "download-transactions"
  const base = fileName.replace(/\.(csv|tsv|txt)$/i, "");
  return base.replace(/\s*\(\d+\)\s*$/, "").trim() || "My CSV Template";
}

export function ColumnMappingDialog({
  open,
  onOpenChange,
  fileName,
  headers,
  sampleRows,
  suggestedMapping,
  accounts,
  onReparse,
  onConfirm,
  submitting,
  confirmMode = false,
  isInvestment = false,
}: ColumnMappingDialogProps) {
  // Displayed columns / sample / suggestion are LOCAL state so debounced
  // re-detection can replace them without the parent re-pushing props (which
  // would clobber the user's in-progress mapping / account / currency).
  const [localHeaders, setLocalHeaders] = useState<string[]>(headers);
  const [localSampleRows, setLocalSampleRows] = useState<Record<string, string>[]>(sampleRows);
  const [localSuggested, setLocalSuggested] = useState<ColumnMapping | null>(suggestedMapping);

  const [mapping, setMapping] = useState<ColumnMapping>(
    () => suggestedMapping ?? { date: "", amount: "" },
  );
  const [defaultAccount, setDefaultAccount] = useState("");
  const [templateName, setTemplateName] = useState(() => defaultTemplateName(fileName));
  const [skipHeaderRows, setSkipHeaderRows] = useState("0");
  const [skipFooterRows, setSkipFooterRows] = useState("0");
  const [defaultCurrency, setDefaultCurrency] = useState("");
  const [dateFormatOverride, setDateFormatOverride] = useState<DateFormatUi>("auto");
  const [redetecting, setRedetecting] = useState(false);
  const [error, setError] = useState("");
  // §B (2026-06-04) — "Don't ask again for this account" (confirm mode only).
  const [dontAskAgain, setDontAskAgain] = useState(false);

  // Monotonic guard: only the latest re-detect's response is applied.
  const reparseSeq = useRef(0);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Re-seed ALL local state whenever the dialog opens against a new file.
  // Keyed on [open, fileName] only — NOT on the headers/sample/suggestion props,
  // so a re-detect (which changes the suggestion) doesn't trip this reset and
  // wipe the user's defaultAccount / templateName / currency mid-edit.
  useEffect(() => {
    if (!open) return;
    setLocalHeaders(headers);
    setLocalSampleRows(sampleRows);
    setLocalSuggested(suggestedMapping);
    setMapping(suggestedMapping ?? { date: "", amount: "" });
    setDefaultAccount("");
    setTemplateName(defaultTemplateName(fileName));
    setSkipHeaderRows("0");
    setSkipFooterRows("0");
    setDefaultCurrency("");
    setDateFormatOverride("auto");
    setRedetecting(false);
    setError("");
    setDontAskAgain(false);
    // Invalidate any in-flight re-detect from a previous file + clear debounce.
    reparseSeq.current++;
    if (debounceRef.current) {
      clearTimeout(debounceRef.current);
      debounceRef.current = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, fileName]);

  // Clear any pending debounce on unmount.
  useEffect(() => {
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, []);

  const setField = (field: MappingColumnField, value: string) => {
    setMapping((prev) => ({ ...prev, [field]: value || undefined }));
  };

  // FINLYNQ-195 — same shape as setField for the investment column keys.
  const setInvestmentField = (field: InvestmentColumnField, value: string) => {
    setMapping((prev) => ({ ...prev, [field]: value || undefined }));
  };

  // Re-detect columns by re-parsing the file with the new skip values. The
  // old mapping points at pre-trim column names, so re-seed it from the fresh
  // suggestion; defaultAccount / templateName / currency are left untouched.
  const runReparse = async (headerStr: string, footerStr: string) => {
    const seq = ++reparseSeq.current;
    setRedetecting(true);
    try {
      const next = await onReparse(clampSkip(headerStr), clampSkip(footerStr));
      if (seq !== reparseSeq.current) return; // superseded by a newer request
      setLocalHeaders(next.headers);
      setLocalSampleRows(next.sampleRows);
      setLocalSuggested(next.suggestedMapping);
      // Re-seed the column mappings from the fresh suggestion (the old ones
      // point at pre-trim column names) but PRESERVE the flip-sign toggle —
      // it's independent of which columns map where.
      setMapping((prev) => ({
        ...(next.suggestedMapping ?? { date: "", amount: "" }),
        ...(prev.flipSign ? { flipSign: true } : {}),
      }));
      setError("");
    } catch {
      if (seq === reparseSeq.current) {
        setError("Couldn't re-read the file with those skip values. Adjust and try again.");
      }
    } finally {
      if (seq === reparseSeq.current) setRedetecting(false);
    }
  };

  const scheduleReparse = (headerStr: string, footerStr: string) => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => {
      void runReparse(headerStr, footerStr);
    }, 400);
  };

  const handleConfirm = async () => {
    setError("");
    if (!mapping.date) { setError("Pick the Date column."); return; }
    if (!mapping.amount) { setError("Pick the Amount column."); return; }
    if (!mapping.account && !defaultAccount) {
      setError("Map an Account column, or pick a Default Account below.");
      return;
    }
    if (!templateName.trim()) { setError("Give the template a name."); return; }

    // FINLYNQ-195 — never persist investment column keys for a cash account
    // (defends against a stale suggestion / re-detect leaking ticker/qty into a
    // cash template). For investment accounts they pass through untouched.
    const outMapping: ColumnMapping = { ...mapping };
    if (!isInvestment) {
      delete outMapping.ticker;
      delete outMapping.portfolioHolding;
      delete outMapping.quantity;
    }

    await onConfirm({
      mapping: outMapping,
      defaultAccount: defaultAccount || null,
      templateName: templateName.trim(),
      skipHeaderRows: clampSkip(skipHeaderRows),
      skipFooterRows: clampSkip(skipFooterRows),
      defaultCurrency: defaultCurrency || null,
      dateFormatOverride: dateFormatOverride === "auto" ? null : dateFormatOverride,
      headers: localHeaders,
      dontAskAgain,
    });
  };

  // Compute a live sample using the current mapping so the user sees what
  // each column resolves to before committing.
  const mappedSample = useMemo(() => {
    // Reflect the flip-sign knob so the previewed Amount matches what lands
    // in staging. Falls back to the raw cell text when it isn't a parseable
    // number (the parser would reject that row anyway).
    const displayAmount = (raw: string): string => {
      if (!mapping.flipSign || !raw) return raw;
      const n = parseAmount(raw);
      if (Number.isNaN(n)) return raw;
      return String(n === 0 ? 0 : -n);
    };
    return localSampleRows.slice(0, 5).map((row) => ({
      date: mapping.date ? row[mapping.date] ?? "" : "",
      amount: displayAmount(mapping.amount ? row[mapping.amount] ?? "" : ""),
      payee: mapping.payee ? row[mapping.payee] ?? "" : "",
      note: mapping.note ? row[mapping.note] ?? "" : "",
      currency: mapping.currency
        ? row[mapping.currency] ?? ""
        : defaultCurrency || "",
      account: mapping.account
        ? row[mapping.account] ?? ""
        : defaultAccount || "(default account)",
      // FINLYNQ-195 — investment columns previewed only when mapped.
      ticker: mapping.ticker ? row[mapping.ticker] ?? "" : "",
      security: mapping.portfolioHolding ? row[mapping.portfolioHolding] ?? "" : "",
      quantity: mapping.quantity ? row[mapping.quantity] ?? "" : "",
    }));
  }, [localSampleRows, mapping, defaultAccount, defaultCurrency]);

  const noColumns = localHeaders.length === 0 && !redetecting;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-4xl max-h-[88vh] overflow-hidden flex flex-col">
        <DialogHeader>
          <DialogTitle>
            {confirmMode ? "Confirm Column Mapping" : "Map CSV Columns"}
          </DialogTitle>
          <DialogDescription>
            {confirmMode ? (
              <>
                We detected a column mapping for{" "}
                <span className="font-mono text-xs">{fileName}</span>. Review it
                below — adjust any column that looks wrong, then import.
              </>
            ) : (
              <>
                We couldn&apos;t auto-match the columns in{" "}
                <span className="font-mono text-xs">{fileName}</span>.
                Tell us which column is which — we&apos;ll remember the mapping for next time.
              </>
            )}
          </DialogDescription>
        </DialogHeader>

        <div className="overflow-auto flex-1 space-y-4 pr-1">
          {localSuggested && (
            <div className="flex items-start gap-2 rounded-lg border border-blue-200 bg-blue-50/40 p-2.5">
              <Sparkles className="h-4 w-4 text-blue-600 shrink-0 mt-0.5" />
              <p className="text-xs text-blue-800">
                We&apos;ve pre-filled our best guesses. Double-check Date, Amount, and Account
                before continuing.
              </p>
            </div>
          )}

          {/* Import options — skip junk rows above/below the data + date format
              + default currency. Changing the skip count re-detects the columns
              below; date format / currency apply on Continue. */}
          <details className="rounded-lg border bg-muted/30 p-3" open>
            <summary className="cursor-pointer text-sm font-medium">
              Import options (skip header / footer rows, date format, default currency)
            </summary>
            <div className="mt-3 space-y-3">
              <p className="text-xs text-muted-foreground">
                If the real column names aren&apos;t on the first row (a title or
                summary row sits above them), skip those rows — the columns below
                refresh automatically.
              </p>
              <div className="grid gap-3 sm:grid-cols-2">
                <div className="space-y-1">
                  <Label htmlFor="map-skip-h" className="text-xs">Skip N header rows</Label>
                  <Input
                    id="map-skip-h"
                    type="number"
                    min={0}
                    max={100}
                    value={skipHeaderRows}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSkipHeaderRows(v);
                      scheduleReparse(v, skipFooterRows);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="map-skip-f" className="text-xs">Skip N footer rows</Label>
                  <Input
                    id="map-skip-f"
                    type="number"
                    min={0}
                    max={100}
                    value={skipFooterRows}
                    onChange={(e) => {
                      const v = e.target.value;
                      setSkipFooterRows(v);
                      scheduleReparse(skipHeaderRows, v);
                    }}
                  />
                </div>
                <div className="space-y-1">
                  <Label htmlFor="map-date-fmt" className="text-xs">Date format</Label>
                  <select
                    id="map-date-fmt"
                    value={dateFormatOverride}
                    onChange={(e) => setDateFormatOverride(e.target.value as DateFormatUi)}
                    className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
                  >
                    <option value="auto">Auto-detect</option>
                    <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                    <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                    <option value="YYYY-MM-DD">YYYY-MM-DD</option>
                  </select>
                </div>
                <div className="space-y-1">
                  <Label className="text-xs">Default currency (rows missing one)</Label>
                  <Select
                    value={defaultCurrency || NONE}
                    onValueChange={(v) => setDefaultCurrency(!v || v === NONE ? "" : v)}
                  >
                    <SelectTrigger className="h-9">
                      <SelectValue placeholder="— None —" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— None —</SelectItem>
                      {SUPPORTED_CURRENCIES.map((c) => (
                        <SelectItem key={c} value={c}>{c}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              </div>
              <label className="flex items-start gap-2.5 rounded-lg border bg-background px-3 py-2.5 cursor-pointer">
                <input
                  type="checkbox"
                  checked={mapping.flipSign === true}
                  onChange={(e) =>
                    setMapping((prev) => ({ ...prev, flipSign: e.target.checked }))
                  }
                  className="h-4 w-4 mt-0.5 rounded border-gray-300"
                />
                <span className="flex-1">
                  <span className="block text-sm font-medium">Flip sign of amounts</span>
                  <span className="block text-xs text-muted-foreground">
                    Multiply every amount by -1 on import — for sources that
                    export expenses as positive (or income as negative). The
                    sample below updates to match.
                  </span>
                </span>
              </label>
              {redetecting && (
                <p className="flex items-center gap-1.5 text-xs text-muted-foreground">
                  <Loader2 className="h-3.5 w-3.5 animate-spin" />
                  Re-reading file…
                </p>
              )}
            </div>
          </details>

          {noColumns && (
            <div className="flex items-center gap-2 rounded-lg border border-amber-200 bg-amber-50/50 px-3 py-2">
              <AlertCircle className="h-4 w-4 text-amber-600 shrink-0" />
              <p className="text-xs text-amber-700">
                No columns found — you may have skipped past the end of the file.
                Lower the skip count.
              </p>
            </div>
          )}

          {/* Mapping table */}
          <div className="space-y-2">
            <Label className="text-sm font-medium">Column Mapping</Label>
            <div className="rounded-lg border divide-y">
              {MAPPING_FIELDS.map((field) => (
                <div key={field} className="flex items-center gap-3 px-3 py-2">
                  <span className="w-36 text-xs text-muted-foreground shrink-0">
                    {FIELD_LABELS[field]}
                  </span>
                  <Select
                    value={mapping[field] ?? NONE}
                    onValueChange={(v) => setField(field, (!v || v === NONE) ? "" : v)}
                  >
                    <SelectTrigger className="h-8 text-xs">
                      <SelectValue placeholder="—" />
                    </SelectTrigger>
                    <SelectContent>
                      <SelectItem value={NONE}>— not mapped —</SelectItem>
                      {localHeaders.map((h) => (
                        <SelectItem key={h} value={h}>{h}</SelectItem>
                      ))}
                    </SelectContent>
                  </Select>
                </div>
              ))}
            </div>
          </div>

          {/* FINLYNQ-195 — investment-account-only column mappings. Shown ONLY
              when the import target is an investment account; a cash account
              never renders these (and they're stripped at confirm anyway).
              v1 captures ticker/name/qty into staging / bank_transactions —
              it does NOT yet materialize lot-aware portfolio operations. */}
          {isInvestment && (
            <div className="space-y-2">
              <Label className="text-sm font-medium">
                Investment columns (this is an investment account)
              </Label>
              <p className="text-xs text-muted-foreground">
                Map the security ticker/symbol, name, and quantity from your
                brokerage export. These are captured with the imported rows for
                now; they aren&apos;t yet turned into buy/sell positions.
              </p>
              <div className="rounded-lg border divide-y">
                {INVESTMENT_FIELDS.map((field) => (
                  <div key={field} className="flex items-center gap-3 px-3 py-2">
                    <span className="w-36 text-xs text-muted-foreground shrink-0">
                      {INVESTMENT_FIELD_LABELS[field]}
                    </span>
                    <Select
                      value={mapping[field] ?? NONE}
                      onValueChange={(v) =>
                        setInvestmentField(field, !v || v === NONE ? "" : v)
                      }
                    >
                      <SelectTrigger className="h-8 text-xs">
                        <SelectValue placeholder="—" />
                      </SelectTrigger>
                      <SelectContent>
                        <SelectItem value={NONE}>— not mapped —</SelectItem>
                        {localHeaders.map((h) => (
                          <SelectItem key={h} value={h}>{h}</SelectItem>
                        ))}
                      </SelectContent>
                    </Select>
                  </div>
                ))}
              </div>
            </div>
          )}

          {/* Default account */}
          <div className="space-y-1.5">
            <Label className="text-sm">Default Account</Label>
            <p className="text-xs text-muted-foreground">
              Used when the Account column is not mapped, or when a row&apos;s account cell is empty.
            </p>
            <Select value={defaultAccount} onValueChange={(v) => setDefaultAccount(v ?? "")}>
              <SelectTrigger className="h-8 text-sm">
                <SelectValue placeholder="— none —" />
              </SelectTrigger>
              <SelectContent>
                {accounts.map((a) => (
                  <SelectItem key={a} value={a}>{a}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>

          {/* Live sample — how rows land in staging with the current mapping. */}
          {mappedSample.length > 0 && (
            <div className="space-y-1.5">
              <Label className="text-sm">Sample (first {mappedSample.length} rows)</Label>
              <div className="rounded-lg border overflow-x-auto">
                <table className="w-full text-xs">
                  <thead className="bg-muted/50">
                    <tr>
                      <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">Date</th>
                      <th className="text-left px-2 py-1.5 font-medium">Account</th>
                      <th className="text-left px-2 py-1.5 font-medium">Payee</th>
                      <th className="text-left px-2 py-1.5 font-medium">Note</th>
                      {isInvestment && (
                        <>
                          <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">Ticker</th>
                          <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">Security</th>
                          <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">Qty</th>
                        </>
                      )}
                      <th className="text-left px-2 py-1.5 font-medium whitespace-nowrap">Currency</th>
                      <th className="text-right px-2 py-1.5 font-medium whitespace-nowrap">Amount</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {mappedSample.map((r, i) => (
                      <tr key={i}>
                        <td className="px-2 py-1 font-mono whitespace-nowrap">{r.date || "—"}</td>
                        <td className="px-2 py-1">{r.account || "—"}</td>
                        <td className="px-2 py-1 truncate max-w-[200px]" title={r.payee}>{r.payee || "—"}</td>
                        <td className="px-2 py-1 truncate max-w-[160px] text-muted-foreground" title={r.note}>{r.note || "—"}</td>
                        {isInvestment && (
                          <>
                            <td className="px-2 py-1 font-mono whitespace-nowrap">{r.ticker || "—"}</td>
                            <td className="px-2 py-1 truncate max-w-[160px]" title={r.security}>{r.security || "—"}</td>
                            <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{r.quantity || "—"}</td>
                          </>
                        )}
                        <td className="px-2 py-1 whitespace-nowrap text-muted-foreground">{r.currency || "—"}</td>
                        <td className="px-2 py-1 text-right font-mono whitespace-nowrap">{r.amount || "—"}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {/* Template name */}
          <div className="space-y-1.5">
            <Label htmlFor="col-map-tpl-name" className="text-sm">
              Save this mapping as a template
            </Label>
            <Input
              id="col-map-tpl-name"
              value={templateName}
              onChange={(e) => setTemplateName(e.target.value)}
              placeholder="e.g. CIBC Mastercard"
              className="h-8 text-sm"
            />
            <p className="text-xs text-muted-foreground">
              Future uploads with the same columns will use this mapping automatically.
            </p>
          </div>

          {/* §B — per-account auto-vs-ask choice. Shown in BOTH modes (the
              saved template auto-applies via header-match next time; this
              controls whether that match is confirmed or applied silently). */}
          <div className="space-y-1.5 rounded-lg border bg-muted/20 p-3">
            <Label className="text-sm font-medium">On future uploads to this account</Label>
            <div className="space-y-1.5">
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="csv-future-mode"
                  className="mt-0.5"
                  checked={!dontAskAgain}
                  onChange={() => setDontAskAgain(false)}
                />
                <span>
                  <span className="font-medium">Ask me to confirm first</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Show this mapping for review each time (recommended).
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2 text-sm cursor-pointer">
                <input
                  type="radio"
                  name="csv-future-mode"
                  className="mt-0.5"
                  checked={dontAskAgain}
                  onChange={() => setDontAskAgain(true)}
                />
                <span>
                  <span className="font-medium">Apply this mapping automatically</span>
                  <span className="block text-[11px] text-muted-foreground">
                    Import silently — don&apos;t ask again for this account. Reset
                    anytime on the account&apos;s page → Import preferences.
                  </span>
                </span>
              </label>
            </div>
          </div>

          {error && (
            <div className="flex items-center gap-2 rounded-lg border border-rose-200 bg-rose-50/50 px-3 py-2">
              <AlertCircle className="h-4 w-4 text-rose-600 shrink-0" />
              <p className="text-xs text-rose-700">{error}</p>
            </div>
          )}
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={submitting}>
            Cancel
          </Button>
          <Button onClick={handleConfirm} disabled={submitting || redetecting || noColumns}>
            {submitting
              ? "Preparing preview..."
              : redetecting
                ? "Re-reading…"
                : confirmMode
                  ? "Import with this mapping"
                  : "Continue"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
