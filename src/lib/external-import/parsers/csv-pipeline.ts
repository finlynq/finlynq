/**
 * Shared CSV parser pipeline (issue #63).
 *
 * Both `/api/import/preview` and `/api/import/staging/upload` need the
 * same fallback chain to handle non-canonical bank export headers
 * (`Transaction Date` / `Description` / `Debit` / `Credit` etc.). Before
 * this module they each had their own implementation; the staging-upload
 * path replaced the old `/api/import/reconcile/preview` route in #153.
 *
 * Behavior is sourced from one place. See [route.ts](../../../app/api/import/preview/route.ts)
 * and [staging/upload/route.ts](../../../app/api/import/staging/upload/route.ts).
 *
 * The pipeline is **read-only** — no DB writes, no encryption. Encryption
 * stays at the commit boundary in the route handlers / `reconcile.ts`. The
 * pipeline does read the user's saved import templates to look up an
 * explicit `templateId` and to auto-match on header signature.
 */

import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  csvToRawTransactions,
  csvToRawTransactionsWithMapping,
  extractBalanceAnchors,
  extractCsvHeaders,
  parseCSV,
  trimCsvRows,
  type DateFormatOverride,
} from "@/lib/csv-parser";
import {
  autoDetectColumnMapping,
  deserializeTemplate,
  findBestTemplate,
  type ColumnMapping,
  type ImportTemplate,
} from "@/lib/import-templates";
import type { RawTransaction } from "@/lib/import-pipeline";

export type ParseError = { row: number; message: string };

export interface CsvPipelineRequest {
  /** Raw CSV text (caller is responsible for `await file.text()`). */
  text: string;
  /** Owner of the saved templates table; required for steps 1 + 3. */
  userId: string;
  /** Explicit template selected by the caller — short-circuits step 1. */
  templateId?: number | null;
  /**
   * Default account name to fill in on rows whose source format doesn't
   * carry one (e.g. OFX single-account, CSV without an `Account` column,
   * reconcile callers that pass an explicit `accountId`).
   */
  defaultAccountName?: string | null;
  /**
   * FINLYNQ-54 parser knobs. All default-equivalent to pre-FINLYNQ-54
   * behavior so existing callers (`/api/import/preview`) are unaffected.
   */
  skipHeaderRows?: number;
  skipFooterRows?: number;
  dateFormatOverride?: DateFormatOverride | null;
  /**
   * FINLYNQ — default currency stamped on rows whose source has no Currency
   * column (or an empty cell). When unset, callers that resolve a saved
   * template fall back to the template's own `defaultCurrency`; otherwise the
   * parser keeps its "CAD" last-resort. Distinct from `anchorCurrency` (which
   * only labels balance anchors).
   */
  defaultCurrency?: string | null;
  /**
   * When true, step 3 (auto-match a saved template by header overlap) is
   * skipped. The pipeline still runs step 2 (canonical headers) and step 4
   * (column-mapping dialog) — this only disables the silent template
   * auto-apply. Set by `/api/import/preview` when the user explicitly picks
   * "Auto-detect" in the template-picker dialog.
   */
  skipAutoMatchTemplate?: boolean;
  /**
   * 2026-05-24 — currency stamped on extracted balance anchors. Falls
   * back to "CAD" when unset. The upload route passes the bound account's
   * currency so anchors land in the bank-side display unit.
   */
  anchorCurrency?: string | null;
  /**
   * Statement-upload field-mapping §B (2026-06-04). When true, the silent
   * auto-apply steps (2 canonical headers, 3 saved-template match, 3.5
   * auto-detect direct) return a `kind: "auto-detected"` result carrying the
   * computed mapping + sample rows INSTEAD of committing — the route surfaces
   * it for user confirmation before staging. Default false preserves today's
   * silent behavior for `/api/import/preview` and every other caller. An
   * explicit `templateId` always short-circuits to the parsed path (step 1)
   * regardless of this flag — a confirmed/edited mapping the user re-fires.
   */
  confirmAutoMapping?: boolean;
}

/** Per-day bank balance anchor extracted from a CSV's Balance column.
 *  Empty when the mapping has no `balance` field or no row carried a
 *  parseable value. */
export type CsvAnchor = { date: string; balance: number; currency: string };

export type CsvPipelineResult =
  | {
      kind: "parsed";
      rows: RawTransaction[];
      errors: ParseError[];
      headers: string[];
      /** Set when steps 1 or 3 matched. */
      appliedTemplateId?: number;
      /** Set when step 3 (auto-match) succeeded — for UI hints. */
      suggestedTemplate?: { id: number; name: string; score: number };
      /** 2026-05-24 — per-day bank balance anchors when the mapping has
       *  a `balance` field. Empty array when the CSV lacks a Balance
       *  column. Currency carries the upload's default currency. */
      anchors: CsvAnchor[];
    }
  | {
      kind: "needs-mapping";
      headers: string[];
      sampleRows: Record<string, string>[];
      suggestedMapping: ColumnMapping | null;
    }
  | {
      // Statement-upload field-mapping §B (2026-06-04). Returned ONLY when
      // `confirmAutoMapping: true` and an auto-apply step (2 / 3 / 3.5) would
      // otherwise have silently committed. The route surfaces the detected
      // mapping for confirmation before staging. The user re-fires with an
      // explicit templateId / mapping to take the parsed path.
      kind: "auto-detected";
      /** The mapping the auto-apply step computed. */
      mapping: ColumnMapping;
      /** Which auto-apply step produced it. */
      source: "canonical" | "template" | "auto-detect";
      /** Set when `source === "template"` — the matched saved template. */
      templateId?: number;
      headers: string[];
      sampleRows: Record<string, string>[];
      /** Estimated number of data rows (header excluded). */
      rowCount: number;
    }
  | {
      kind: "template-not-found";
      templateId: number;
    };

/**
 * Run the full four-step CSV parser fallback chain.
 *
 * 1. Explicit `templateId` -> use its column mapping.
 * 2. Canonical headers (`Date` / `Amount` / `Account` / `Payee`).
 * 3. Auto-matched saved template (≥80% header overlap).
 * 4. Otherwise -> `needs-mapping` with autoDetectColumnMapping suggestion.
 *
 * Step 2 and step 3 only "succeed" if at least one row parsed cleanly.
 * If the canonical-header pass produces zero valid rows AND no saved
 * template matches, the caller gets `needs-mapping` so the UI can prompt
 * the user for a column-mapping dialog.
 */
export async function parseCsvWithFallback(
  req: CsvPipelineRequest,
): Promise<CsvPipelineResult> {
  const {
    userId,
    templateId,
    defaultAccountName,
    skipHeaderRows = 0,
    skipFooterRows = 0,
    dateFormatOverride = null,
    defaultCurrency = null,
    skipAutoMatchTemplate = false,
    anchorCurrency = null,
    confirmAutoMapping = false,
  } = req;
  const anchorCcy = anchorCurrency ?? "CAD";
  // Apply header/footer trim BEFORE any header detection so the trim
  // shapes what step 2 (canonical headers) and step 3 (auto-matched
  // saved template) actually see (FINLYNQ-54). With both knobs at 0
  // this is identity.
  const text = trimCsvRows(req.text, skipHeaderRows, skipFooterRows);
  const headers = extractCsvHeaders(text);

  // 1. Explicit template selected by user — use its mapping directly.
  if (templateId !== null && templateId !== undefined && !Number.isNaN(templateId)) {
    const tplRow = await db
      .select()
      .from(schema.importTemplates)
      .where(
        and(
          eq(schema.importTemplates.id, templateId),
          eq(schema.importTemplates.userId, userId),
        ),
      )
      .get();
    if (!tplRow) {
      return { kind: "template-not-found", templateId };
    }
    const tpl = deserializeTemplate(tplRow);
    // FINLYNQ — apply the template's OWN stored skip + default currency when the
    // request didn't pass explicit values, so re-uploading via a saved template
    // honors its persisted parser knobs. Read the RAW `req.` values (the
    // destructured locals are 0/null-defaulted) so "not passed" ≠ "passed as 0".
    const effSkipH = req.skipHeaderRows ?? tpl.skipHeaderRows ?? 0;
    const effSkipF = req.skipFooterRows ?? tpl.skipFooterRows ?? 0;
    const effCurrency = req.defaultCurrency ?? tpl.defaultCurrency ?? null;
    const effDateFmt = req.dateFormatOverride ?? tpl.dateFormatOverride ?? null;
    const tplText = trimCsvRows(req.text, effSkipH, effSkipF);
    const tplHeaders = extractCsvHeaders(tplText);
    const mapped = parseWithMapping(
      tplText,
      tpl.columnMapping,
      tpl.defaultAccount ?? null,
      effDateFmt,
      effCurrency,
    );
    const filled = applyDefaultAccount(mapped.rows, defaultAccountName);
    const anchors = extractBalanceAnchors(
      tplText,
      tpl.columnMapping,
      effDateFmt,
      anchorCcy,
    );
    return {
      kind: "parsed",
      rows: filled,
      errors: mapped.errors,
      headers: tplHeaders,
      appliedTemplateId: tpl.id,
      anchors,
    };
  }

  // 2. Try canonical headers (Date / Amount / Account / Payee).
  //
  // Caveat (2026-05-27 fix): the canonical reader keys on the literal
  // column names `Date` / `Amount` / `Payee` / `Account` and silently
  // returns `payee: ""` when the file uses a synonym like `Description`
  // (TD, Tangerine, RBC export shape). The CSVs still satisfy the
  // canonical Date+Amount minimum so the pipeline used to short-circuit
  // with empty payees — which then broke downstream rule firing (the
  // upload-time rule matcher couldn't see the payee) AND the inbox
  // RowCard display (every card rendered `(no payee)`).
  //
  // Guard: if canonical-success returns rows but EVERY row has an empty
  // payee AND auto-detect finds a payee-mappable header, fall through
  // to the auto-detect mapping path below so the synonym (Description,
  // Merchant, Memo, Narrative) gets picked up. Files that genuinely
  // have no payee at all (e.g. Quicken raw exports) still succeed at
  // step 2 because auto-detect returns null for them.
  const canonical = csvToRawTransactions(text, dateFormatOverride, defaultCurrency);
  if (canonical.rows.length > 0) {
    const auto = autoDetectColumnMapping(headers);
    const allPayeesEmpty = canonical.rows.every(
      (r) => !r.payee || r.payee.trim() === "",
    );
    const autoFindsPayee = auto && typeof auto.payee === "string" && auto.payee.length > 0;
    const shouldFallthroughForPayee = allPayeesEmpty && autoFindsPayee;

    if (!shouldFallthroughForPayee) {
      // §B confirm gate: surface the canonical mapping for review instead of
      // committing silently. The canonical reader keys on the literal
      // `Date`/`Amount`/`Payee`/`Account` columns; auto-detect reconstructs
      // that mapping (plus any synonym Balance column) for the dialog.
      if (confirmAutoMapping) {
        const canonicalMapping = auto ?? canonicalFallbackMapping(headers);
        return {
          kind: "auto-detected",
          mapping: canonicalMapping,
          source: "canonical",
          headers,
          sampleRows: parseCSV(text).slice(0, 5),
          rowCount: estimateRowCount(text),
        };
      }
      const filled = applyDefaultAccount(canonical.rows, defaultAccountName);
      // Canonical path has no explicit ColumnMapping; reuse auto-detect to
      // find a Balance column when present. Falls back to no anchors when
      // the file doesn't carry one.
      const anchors = auto
        ? extractBalanceAnchors(text, auto, dateFormatOverride, anchorCcy)
        : [];
      return {
        kind: "parsed",
        rows: filled,
        errors: canonical.errors,
        headers,
        anchors,
      };
    }
    // Fall through to step 3 / 4 below so the payee-mappable header gets used.
  }

  // 3. Try an auto-matched saved template (≥80% header overlap). Skipped
  //    when the caller explicitly opted out (template-picker "Auto-detect").
  const allTemplates = skipAutoMatchTemplate
    ? []
    : await db
        .select()
        .from(schema.importTemplates)
        .where(eq(schema.importTemplates.userId, userId))
        .all();
  const templates: ImportTemplate[] = allTemplates.map(deserializeTemplate);
  const best = skipAutoMatchTemplate ? null : findBestTemplate(headers, templates);
  if (best) {
    // FINLYNQ — apply the matched template's default currency + date format
    // (request override first). Skip-fallback for step 3 is deferred:
    // `headers`/`findBestTemplate` are computed on the request-skip-trimmed
    // text, so re-trimming post-match could shift which rows parse. Currency
    // and date format have no such ordering hazard.
    const effCurrency = req.defaultCurrency ?? best.template.defaultCurrency ?? null;
    const effDateFmt = req.dateFormatOverride ?? best.template.dateFormatOverride ?? null;
    const mapped = parseWithMapping(
      text,
      best.template.columnMapping,
      best.template.defaultAccount ?? null,
      effDateFmt,
      effCurrency,
    );
    if (mapped.rows.length > 0) {
      // §B confirm gate: a high-confidence template match is pre-filled for
      // one-click accept rather than applied silently.
      if (confirmAutoMapping) {
        return {
          kind: "auto-detected",
          mapping: best.template.columnMapping,
          source: "template",
          templateId: best.template.id,
          headers,
          sampleRows: parseCSV(text).slice(0, 5),
          rowCount: estimateRowCount(text),
        };
      }
      const filled = applyDefaultAccount(mapped.rows, defaultAccountName);
      const anchors = extractBalanceAnchors(
        text,
        best.template.columnMapping,
        effDateFmt,
        anchorCcy,
      );
      return {
        kind: "parsed",
        rows: filled,
        errors: mapped.errors,
        headers,
        appliedTemplateId: best.template.id,
        suggestedTemplate: {
          id: best.template.id,
          name: best.template.name,
          score: best.score,
        },
        anchors,
      };
    }
  }

  // 3.5. Auto-detect direct apply (2026-05-27 fix).
  //
  // Before failing back to a needs-mapping prompt, give the auto-detect
  // engine one chance to drive the parse end-to-end. This is what closes
  // the "Description column → payee" gap that the canonical short-circuit
  // used to swallow.
  //
  // Only runs when auto-detect finds the three required columns (date,
  // amount, AND payee). The first two are baseline canonical
  // requirements; the third is added because a payee-less mapping is
  // exactly what step 2 already covers — falling through here without a
  // payee would be a no-op.
  const directAuto = autoDetectColumnMapping(headers);
  if (directAuto && directAuto.date && directAuto.amount && directAuto.payee) {
    const mapped = parseWithMapping(
      text,
      directAuto,
      null,
      dateFormatOverride,
      defaultCurrency,
    );
    if (mapped.rows.length > 0) {
      // §B confirm gate: this is exactly the guess that's most worth
      // confirming (it picks the payee column from the synonym list, which
      // can bind the wrong column when a file has both Memo and Description).
      if (confirmAutoMapping) {
        return {
          kind: "auto-detected",
          mapping: directAuto,
          source: "auto-detect",
          headers,
          sampleRows: parseCSV(text).slice(0, 5),
          rowCount: estimateRowCount(text),
        };
      }
      const filled = applyDefaultAccount(mapped.rows, defaultAccountName);
      const anchors = extractBalanceAnchors(
        text,
        directAuto,
        dateFormatOverride,
        anchorCcy,
      );
      return {
        kind: "parsed",
        rows: filled,
        errors: mapped.errors,
        headers,
        anchors,
      };
    }
  }

  // 4. Nothing worked — return headers + auto-detected suggestion so the
  //    client can show a column-mapping dialog.
  const suggestedMapping = autoDetectColumnMapping(headers);
  const sampleRows = parseCSV(text).slice(0, 5);
  return {
    kind: "needs-mapping",
    headers,
    sampleRows,
    suggestedMapping,
  };
}

/**
 * §B (2026-06-04) — best-effort mapping for the canonical-headers case when
 * `autoDetectColumnMapping` returned null. The canonical reader keys on the
 * literal `Date`/`Amount`/`Payee`/`Account`/… header names, so reflect any
 * that are present so the confirm dialog isn't blank.
 */
function canonicalFallbackMapping(headers: string[]): ColumnMapping {
  const has = (name: string) =>
    headers.find((h) => h.trim().toLowerCase() === name.toLowerCase());
  const mapping: ColumnMapping = {
    date: has("Date") ?? "",
    amount: has("Amount") ?? "",
  };
  const payee = has("Payee");
  if (payee) mapping.payee = payee;
  const account = has("Account");
  if (account) mapping.account = account;
  const category = has("Category");
  if (category) mapping.category = category;
  const currency = has("Currency");
  if (currency) mapping.currency = currency;
  const note = has("Note");
  if (note) mapping.note = note;
  const tags = has("Tags");
  if (tags) mapping.tags = tags;
  const balance = has("Balance");
  if (balance) mapping.balance = balance;
  return mapping;
}

/** §B (2026-06-04) — count data rows (header excluded) for the confirm
 *  dialog's "N rows" hint. */
function estimateRowCount(text: string): number {
  return parseCSV(text).length;
}

/** Parse a CSV with a column mapping and apply a template-level default account. */
function parseWithMapping(
  text: string,
  mapping: ColumnMapping,
  defaultAccount: string | null,
  dateFormatOverride?: DateFormatOverride | null,
  defaultCurrency?: string | null,
): { rows: RawTransaction[]; errors: ParseError[] } {
  const result = csvToRawTransactionsWithMapping(
    text,
    mapping as unknown as Record<string, string>,
    dateFormatOverride,
    defaultCurrency,
  );
  if (defaultAccount) {
    result.rows = result.rows.map((r) => ({
      ...r,
      account: r.account || defaultAccount,
    }));
  }
  return result;
}

/**
 * Fill in `account` on rows whose source format didn't carry one. Caller-
 * supplied `defaultAccountName` (typically derived from an explicit
 * accountId) takes precedence over template-level defaults already applied.
 */
function applyDefaultAccount(
  rows: RawTransaction[],
  defaultAccountName: string | null | undefined,
): RawTransaction[] {
  if (!defaultAccountName) return rows;
  return rows.map((r) => ({
    ...r,
    account: r.account || defaultAccountName,
  }));
}

/**
 * Build a richer "0 rows parsed" error message for the caller to surface.
 * Includes byte count and the first non-empty line so users can see what
 * we actually received. Common-case hint covers semicolon/tab separators
 * (the parser is comma-only; users on European bank exports hit this).
 */
export function buildEmptyCsvError(text: string): string {
  const cleaned = text.replace(/^\uFEFF/, "");
  const bytes = Buffer.byteLength(text, "utf8");
  const firstLine =
    cleaned
      .split(/\r\n|\r|\n/)
      .map((l) => l.trim())
      .find((l) => l.length > 0) ?? "";
  const truncated = firstLine.length > 200 ? `${firstLine.slice(0, 200)}…` : firstLine;
  const hint =
    "If the file uses semicolons or tabs as separators, please re-export as comma-separated.";
  if (!truncated) {
    return `No transactions found in file (csv, ${bytes} bytes — file appears empty). ${hint}`;
  }
  return `No transactions found in file (csv, ${bytes} bytes). First line: ${JSON.stringify(truncated)}. ${hint}`;
}
