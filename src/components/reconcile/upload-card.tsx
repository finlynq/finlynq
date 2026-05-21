"use client";

import { useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { FileDropZone } from "@/app/(app)/import/components/file-drop-zone";
import { Loader2 } from "lucide-react";
import { SUPPORTED_CURRENCIES } from "@/lib/fx/supported-currencies";

import type { AccountOption } from "./preview-table";

export interface TemplateOption {
  id: number;
  name: string;
}

/**
 * FINLYNQ-54 parser knobs (Import options panel). Defaults match
 * pre-FINLYNQ-54 behavior so existing uploads are unaffected when the
 * panel is left collapsed.
 */
export type DateFormatOverrideUi =
  | "auto"
  | "DD/MM/YYYY"
  | "MM/DD/YYYY"
  | "YYYY-MM-DD";

interface Props {
  accounts: AccountOption[];
  templates?: TemplateOption[];
  loading: boolean;
  onUpload: (params: {
    file: File;
    accountId: number | null;
    tolerance: number;
    templateId: number | null;
    /** Optional user-typed statement balance for CSV uploads. OFX/QFX
     *  statements carry their own balance via <LEDGERBAL>, so this is
     *  primarily for CSVs where no balance is reliably parseable. */
    statementBalance: number | null;
    /** FINLYNQ-54 — see the Import options panel below. */
    skipHeaderRows: number;
    skipFooterRows: number;
    dateFormatOverride: DateFormatOverrideUi;
    defaultCurrency: string | null;
  }) => void;
}

const ACCEPT = ".csv,.ofx,.qfx";

export function ReconcileUploadCard({
  accounts,
  templates = [],
  loading,
  onUpload,
}: Props) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [tolerance, setTolerance] = useState<string>("3");
  const [statementBalance, setStatementBalance] = useState<string>("");

  // FINLYNQ-54 parser knobs. The panel is <details>-collapsed by default;
  // defaults preserve the pre-FINLYNQ-54 behavior end-to-end.
  const [skipHeaderRows, setSkipHeaderRows] = useState<string>("0");
  const [skipFooterRows, setSkipFooterRows] = useState<string>("0");
  const [dateFormatOverride, setDateFormatOverride] =
    useState<DateFormatOverrideUi>("auto");
  const [defaultCurrency, setDefaultCurrency] = useState<string>("");

  const accountItems = accounts.map((a) => ({
    value: String(a.id),
    label: `${a.name} (${a.currency})`,
  }));

  const templateItems = templates.map((t) => ({
    value: String(t.id),
    label: t.name,
  }));

  const currencyItems = SUPPORTED_CURRENCIES.map((c) => ({
    value: c,
    label: c,
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Default account (required for OFX/QFX)
          </label>
          <Combobox
            value={selectedAccountId}
            onValueChange={(v) => setSelectedAccountId(v ?? "")}
            items={accountItems}
            placeholder="— Use account column from CSV —"
            searchPlaceholder="Search…"
            emptyMessage="No accounts"
            className="w-full"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Settlement-vs-posting fuzz (days)
          </label>
          <input
            type="number"
            min={0}
            max={30}
            value={tolerance}
            onChange={(e) => setTolerance(e.target.value)}
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          />
        </div>
      </div>

      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            CSV template (optional — for non-standard formats like IBKR)
          </label>
          <Combobox
            value={selectedTemplateId}
            onValueChange={(v) => setSelectedTemplateId(v ?? "")}
            items={templateItems}
            placeholder="— Auto-detect —"
            searchPlaceholder="Search templates…"
            emptyMessage={
              templates.length === 0
                ? "No saved templates yet"
                : "No matching templates"
            }
            className="w-full"
          />
        </div>
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            Statement balance (optional — CSV only)
          </label>
          <input
            type="number"
            step="0.01"
            value={statementBalance}
            onChange={(e) => setStatementBalance(e.target.value)}
            placeholder="e.g. 1234.56"
            className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
          />
        </div>
      </div>

      <details className="rounded-md border bg-muted/30 p-3">
        <summary className="cursor-pointer text-xs font-medium text-muted-foreground">
          Import options (skip header / footer rows, date format, default currency)
        </summary>
        <div className="mt-3 space-y-3">
          <p className="text-xs text-muted-foreground">
            Use when the parser&rsquo;s auto-detect mis-reads your bank&rsquo;s
            export. Leave at defaults for canonical exports.
          </p>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Skip N header rows
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={skipHeaderRows}
                onChange={(e) => setSkipHeaderRows(e.target.value)}
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              />
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Skip N footer rows
              </label>
              <input
                type="number"
                min={0}
                max={100}
                value={skipFooterRows}
                onChange={(e) => setSkipFooterRows(e.target.value)}
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              />
            </div>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Date format
              </label>
              <select
                value={dateFormatOverride}
                onChange={(e) =>
                  setDateFormatOverride(e.target.value as DateFormatOverrideUi)
                }
                className="h-9 w-full rounded-md border bg-transparent px-3 text-sm"
              >
                <option value="auto">Auto-detect</option>
                <option value="DD/MM/YYYY">DD/MM/YYYY</option>
                <option value="MM/DD/YYYY">MM/DD/YYYY</option>
                <option value="YYYY-MM-DD">YYYY-MM-DD</option>
              </select>
            </div>
            <div className="space-y-1">
              <label className="text-xs font-medium text-muted-foreground">
                Default currency (rows missing one)
              </label>
              <Combobox
                value={defaultCurrency}
                onValueChange={(v) => setDefaultCurrency(v ?? "")}
                items={currencyItems}
                placeholder="— None —"
                searchPlaceholder="Search…"
                emptyMessage="No matching currency"
                className="w-full"
              />
            </div>
          </div>
        </div>
      </details>

      <FileDropZone
        accept={ACCEPT}
        disabled={loading}
        onFileSelected={(file) => {
          const accountId = selectedAccountId ? Number(selectedAccountId) : null;
          const templateId = selectedTemplateId
            ? Number(selectedTemplateId)
            : null;
          const tol = Number.parseInt(tolerance, 10);
          // Only forward statementBalance if it parses as a finite number.
          // OFX/QFX statements provide their own balance, so the input is
          // really an aid for CSV uploads — server still accepts it for
          // OFX/QFX but the OFX balance takes priority when both are set.
          let bal: number | null = null;
          if (statementBalance.trim()) {
            const n = Number(statementBalance);
            if (!Number.isNaN(n) && Number.isFinite(n)) bal = n;
          }
          const skipH = Number.parseInt(skipHeaderRows, 10);
          const skipF = Number.parseInt(skipFooterRows, 10);
          onUpload({
            file,
            accountId,
            tolerance: Number.isNaN(tol) ? 3 : Math.max(0, Math.min(30, tol)),
            templateId,
            statementBalance: bal,
            skipHeaderRows: Number.isNaN(skipH) ? 0 : Math.max(0, Math.min(100, skipH)),
            skipFooterRows: Number.isNaN(skipF) ? 0 : Math.max(0, Math.min(100, skipF)),
            dateFormatOverride,
            defaultCurrency: defaultCurrency || null,
          });
        }}
      />

      {loading && (
        <div className="flex items-center justify-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3.5 w-3.5 animate-spin" /> Uploading and classifying rows…
        </div>
      )}
    </div>
  );
}
