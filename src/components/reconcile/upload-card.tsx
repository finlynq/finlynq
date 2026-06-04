"use client";

import { useState } from "react";
import { Combobox } from "@/components/ui/combobox";
import { FileDropZone } from "@/app/(app)/import/components/file-drop-zone";
import { Loader2 } from "lucide-react";

import type { AccountOption } from "./preview-table";

export interface TemplateOption {
  id: number;
  name: string;
  /** FINLYNQ-54 follow-up — parser knobs persisted on the template. When a
   *  user picks this template the upload card pre-fills the Import-options
   *  panel from these fields (template wins per product decision). All four
   *  are optional so legacy callers passing `{id, name}` still typecheck. */
  skipHeaderRows?: number;
  skipFooterRows?: number;
  dateFormatOverride?: DateFormatOverrideUi | null;
  defaultCurrency?: string | null;
  /** The default account configured on the template (account name string
   *  from `import_templates.default_account`). Picking the template pre-fills
   *  the account dropdown when this name matches one of the user's accounts.
   *  Without this, anchor upserts skipped (staged_imports.bound_account_id
   *  stays NULL → approve-time gate fails). */
  defaultAccount?: string | null;
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

/** §A (2026-06-04) — which OFX/QFX field populates the payee. */
export type OfxPayeeSourceUi = "name" | "memo";

interface Props {
  accounts: AccountOption[];
  templates?: TemplateOption[];
  loading: boolean;
  /** When set, the account picker is hidden and EVERY upload is bound to
   *  this account. Used by the account-anchored /import upload drawer, where
   *  the destination account is already chosen by the surface. The standalone
   *  /import/reconcile caller leaves this undefined and keeps the picker. */
  lockedAccount?: AccountOption | null;
  /** §A (2026-06-04) — the bound account's saved OFX payee source. When set,
   *  the card renders a "Payee from: Name / Memo" radio defaulting to it
   *  (OFX/QFX uploads only — the server ignores this for CSV). Undefined =>
   *  hide the radio (standalone /import/reconcile caller). */
  ofxPayeeSource?: OfxPayeeSourceUi;
  /** Called when the user flips the OFX payee-source radio, so the parent can
   *  persist it to the bound account (PATCH /api/accounts/[id]/import-prefs). */
  onOfxPayeeSourceChange?: (value: OfxPayeeSourceUi) => void;
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
    /** §A (2026-06-04) — OFX/QFX payee source for THIS upload. Server
     *  ignores it for CSV. Undefined when the radio isn't shown. */
    payeeSource?: OfxPayeeSourceUi;
  }) => void;
}

const ACCEPT = ".csv,.ofx,.qfx";

export function ReconcileUploadCard({
  accounts,
  templates = [],
  loading,
  lockedAccount,
  ofxPayeeSource,
  // §A (2026-06-04) — the visible Name/Memo radio was replaced by the
  // OfxConfirmDialog preview (the drawer persists the choice there), so this
  // callback is no longer wired to a card control. Kept in Props for the
  // drawer's call-site typecheck.
  onUpload,
}: Props) {
  const [selectedAccountId, setSelectedAccountId] = useState<string>("");
  const [selectedTemplateId, setSelectedTemplateId] = useState<string>("");
  const [tolerance, setTolerance] = useState<string>("3");
  const [statementBalance, setStatementBalance] = useState<string>("");
  // §A (2026-06-04) — the OFX/QFX payee-source choice now lives in the
  // OfxConfirmDialog preview (the drawer persists it). The card just forwards
  // the bound account's saved value as the initial upload hint; for a 'confirm'
  // account the route ignores it and returns the preview, and the dialog's
  // choice wins on re-fire. For an 'auto' account this saved value is applied.

  // FINLYNQ-54 parser knobs. The panel is <details>-collapsed by default;
  // defaults preserve the pre-FINLYNQ-54 behavior end-to-end.
  const [skipHeaderRows, setSkipHeaderRows] = useState<string>("0");
  const [skipFooterRows, setSkipFooterRows] = useState<string>("0");
  const [dateFormatOverride, setDateFormatOverride] =
    useState<DateFormatOverrideUi>("auto");
  const [defaultCurrency, setDefaultCurrency] = useState<string>("");

  /** Apply a picked template's parser knobs + default account to the form.
   *  Template wins; any value the user typed before picking is overwritten.
   *  Statement balance is intentionally NOT touched — that changes per
   *  upload. The default-account resolution matches by name against the
   *  `accounts` prop; a no-match (renamed/deleted account) leaves the
   *  account dropdown untouched so the user can pick manually. */
  const applyTemplateKnobs = (templateId: string) => {
    if (!templateId) return;
    const tpl = templates.find((t) => String(t.id) === templateId);
    if (!tpl) return;
    setSkipHeaderRows(String(tpl.skipHeaderRows ?? 0));
    setSkipFooterRows(String(tpl.skipFooterRows ?? 0));
    setDateFormatOverride(tpl.dateFormatOverride ?? "auto");
    setDefaultCurrency(tpl.defaultCurrency ?? "");
    // When the account is locked by the surface, a template's default account
    // must NOT override it — the drawer's account always wins.
    if (!lockedAccount && tpl.defaultAccount) {
      const match = accounts.find((a) => a.name === tpl.defaultAccount);
      if (match) setSelectedAccountId(String(match.id));
    }
  };

  const accountItems = accounts.map((a) => ({
    value: String(a.id),
    label: `${a.name} (${a.currency})`,
  }));

  const templateItems = templates.map((t) => ({
    value: String(t.id),
    label: t.name,
  }));

  return (
    <div className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-2">
        <div className="space-y-1">
          <label className="text-xs font-medium text-muted-foreground">
            {lockedAccount ? "Account" : "Default account (required for OFX/QFX)"}
          </label>
          {lockedAccount ? (
            <div className="flex h-9 items-center rounded-md border bg-muted/30 px-3 text-sm">
              {lockedAccount.name} ({lockedAccount.currency})
            </div>
          ) : (
            <Combobox
              value={selectedAccountId}
              onValueChange={(v) => setSelectedAccountId(v ?? "")}
              items={accountItems}
              placeholder="— Use account column from CSV —"
              searchPlaceholder="Search…"
              emptyMessage="No accounts"
              className="w-full"
            />
          )}
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
            onValueChange={(v) => {
              const next = v ?? "";
              setSelectedTemplateId(next);
              applyTemplateKnobs(next);
            }}
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

      {ofxPayeeSource && (
        <p className="rounded-md border bg-muted/20 px-3 py-2 text-[11px] text-muted-foreground">
          For OFX/QFX statements you&apos;ll get a preview to confirm how rows map
          (and pick whether the Payee comes from the Name or Memo field) before
          they&apos;re imported.
        </p>
      )}

      <FileDropZone
        accept={ACCEPT}
        disabled={loading}
        onFileSelected={(file) => {
          const accountId = lockedAccount
            ? lockedAccount.id
            : selectedAccountId
              ? Number(selectedAccountId)
              : null;
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
            // §A — only meaningful for OFX/QFX; server ignores it for CSV.
            payeeSource: ofxPayeeSource,
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
