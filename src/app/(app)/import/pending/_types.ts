/**
 * /import/pending shared types + helpers (FINLYNQ-118 Phase 4).
 *
 * Extracted verbatim from import/pending/page.tsx so the page, the data hooks
 * (_hooks/), and the sub-pane components (_components/) share one definition.
 */

import { type StagedEditableRow } from "@/components/staging/staged-row-editor";
import { type BalanceWarning } from "@/components/staging/balance-warning-banner";
import {
  type PickerAccount,
  type PickerTemplate,
} from "@/components/staging/unbound-import-picker";

export interface StagedRow {
  id: string;
  source: string;
  fromAddress: string | null;
  subject: string | null;
  receivedAt: string;
  totalRowCount: number;
  duplicateCount: number;
  expiresAt: string;
  originalFilename?: string | null;
  fileFormat?: string | null;
  /** 2026-06-04 — the account this batch is bound to (NULL until an
   *  email-import without a template is bound via the picker). Lets the
   *  account-anchored /import Staging tab filter the list to one account. */
  boundAccountId?: number | null;
}

export interface ParsedAnchorRow {
  date: string;
  balance: number;
  currency?: string;
  source?: string;
}

export interface StagedDetail {
  staged: StagedRow & {
    status: string;
    originalFilename?: string | null;
    fileFormat?: string | null;
    statementBalance?: number | null;
    statementBalanceDate?: string | null;
    statementCurrency?: string | null;
    boundAccountId?: number | null;
    dateRangeStart?: string | null;
    dateRangeEnd?: string | null;
    /** 2026-05-24 — anchors parsed from the file's Balance column.
     *  Same shape persisted to staged_imports.parsed_anchors. */
    parsedAnchors?: ParsedAnchorRow[] | null;
    /** 2026-05-28 — fallback metadata captured when an email-import CSV
     *  attachment didn't template-match at parse time. Backs the
     *  UnboundImportPicker. Both null for upload-path imports and for
     *  email imports whose CSV did match a template. */
    headers?: string[] | null;
    sampleRows?: Array<Record<string, string>> | null;
  };
  rows: StagedEditableRow[];
  /** FINLYNQ-124 — the Staging banner now computes the bank-ledger staging
   *  calc client-side; the server only carries the bound account's currency
   *  for the banner's display fallback. */
  reconciliation?: {
    boundAccountCurrency: string | null;
  };
  suggestedMatches?: Array<{
    stagedRowId: string;
    transactionId: number;
    confidence: "exact" | "fuzzy";
  }>;
  /** 2026-05-24 — bank balance pre-flight mismatches. Empty array =
   *  every anchor in the batch lines up with the running total. */
  balanceWarnings?: BalanceWarning[];
  /** 2026-05-28 — populated by the GET when bound_account_id IS NULL AND
   *  headers IS NOT NULL. Lets the UnboundImportPicker render template
   *  + account dropdowns without extra round-trips. */
  pickerCandidates?: {
    accounts: PickerAccount[];
    templates: PickerTemplate[];
  } | null;
}

export function daysUntil(iso: string): number {
  const ms = new Date(iso).getTime() - Date.now();
  return Math.max(0, Math.ceil(ms / (24 * 60 * 60 * 1000)));
}

/** Shift a YYYY-MM-DD by N days (positive or negative). */
export function shiftDays(date: string, days: number): string {
  const d = new Date(date + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().split("T")[0];
}
