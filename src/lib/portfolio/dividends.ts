/**
 * Dividend income query — Phase 2 of plan/portfolio-lots-and-performance.md.
 *
 * Reads `transactions` where `category_id` matches the user's Dividends
 * category (resolved via the issue #84 HMAC `name_lookup` helper).
 * Includes BOTH cash dividends (qty=0) and reinvested dividends
 * (qty>0) — the former is direct income, the latter increases the
 * holding's share count and ALSO counts as income for tax purposes.
 * Withholding tax / negative-correction entries (qty=0, amt<0) are
 * surfaced as separate rows rather than netted (issue #84 explicit choice).
 *
 * Group-by modes for the dashboard:
 *   'quarter'   — one summary per (year, Qx)
 *   'year'      — one summary per year
 *   'holding'   — one summary per (holding, account)
 *   undefined   — return raw rows
 */

import { and, eq, gte, isNotNull, lte, sql } from "drizzle-orm";
import { alias } from "drizzle-orm/pg-core";
import { db, schema } from "@/db";
import { decryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
import { getDisplayCurrency } from "@/lib/fx-service";

export interface DividendIncomeFilter {
  from?: string;     // YYYY-MM-DD
  to?: string;       // YYYY-MM-DD
  taxYear?: number;
  holdingId?: number;
  accountId?: number;
  groupBy?: "quarter" | "year" | "holding";
  /**
   * FINLYNQ-182 — opt-in. When true, aggregate the STORED historical
   * `reporting_amount` grouped by `reporting_currency` (NOT a render-time FX
   * conversion of the raw `amount`); rows whose reporting fields are still
   * NULL (self-heal in flight, or a rate was unavailable) surface as an
   * `unrated*` count rather than being on-the-fly converted. Group rows are
   * bucketed by PERIOD ONLY (currency drops out of the bucket key). Callers
   * that omit this (mobile, MCP) keep the legacy native shape.
   */
  reportingCurrency?: boolean;
  /**
   * FINLYNQ-182 — opt-in (native mode only). When true, return ONE group row
   * per period carrying a `byCurrency` breakdown map instead of today's flat
   * per-`(period,currency)` rows, so the web report can render currencies as
   * columns. Callers that omit this (mobile, MCP) keep the legacy flat rows.
   * Ignored when `reportingCurrency` is set.
   */
  pivot?: boolean;
}

export interface DividendRow {
  txId: number;
  date: string;
  amount: number;            // entered_amount where present, else amount
  currency: string;
  isReinvested: boolean;     // qty > 0
  isWithholding: boolean;    // amount < 0 (withholding tax, correction)
  holdingId: number | null;
  holdingName: string | null;
  accountId: number | null;
  accountName: string | null;
  payee: string | null;      // decrypted
  /**
   * FINLYNQ-182 — STORED historical reporting fields (NOT a render-time
   * conversion). `reportingAmount` is `round2(amount × historicalRate)`;
   * `reportingCurrency` is the display currency it was locked into. Either is
   * null when the row hasn't been re-rated yet — such rows are EXCLUDED from
   * reporting totals (never on-the-fly converted), surfaced as `unratedCount`.
   */
  reportingAmount: number | null;
  reportingCurrency: string | null;
}

/** Per-currency cell inside a pivoted period group (FINLYNQ-182). */
export interface DividendCurrencyCell {
  amount: number;
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
}

export interface DividendGroupRow {
  bucket: string;            // 'YYYY-Qn' | 'YYYY' | 'holding:<id>'
  label: string;             // user-friendly bucket label
  amount: number;
  currency: string;          // mixed-currency portfolios fold into multiple group rows
  rowCount: number;
  reinvestedCount: number;
  withholdingCount: number;
  /**
   * FINLYNQ-182 — present ONLY in native pivot mode (`pivot:true`). One row per
   * period; `amount`/`currency` then describe the FIRST currency present (kept
   * for back-compat / sort), while `byCurrency` carries the full per-currency
   * breakdown the web report renders as columns. Absent in legacy + reporting
   * modes.
   */
  byCurrency?: Record<string, DividendCurrencyCell>;
  /**
   * FINLYNQ-182 — present ONLY in reporting mode. Count of rows in this period
   * whose stored reporting fields were still NULL and were therefore NOT folded
   * into the reporting total (re-rating in progress). Never on-the-fly converted.
   */
  unratedCount?: number;
}

export interface DividendIncomeResult {
  rows?: DividendRow[];      // populated when groupBy is undefined
  groups?: DividendGroupRow[]; // populated when groupBy is set
  totals: {
    amount: number;
    rowCount: number;
    byCurrency: Record<string, number>;
    /**
     * FINLYNQ-182 — present ONLY in reporting mode: count of rows across all
     * periods that lacked stored reporting fields (excluded from the totals).
     */
    unratedCount?: number;
  };
  /** FINLYNQ-182 — echoes the active mode so the page/CSV branch correctly. */
  mode?: "native" | "reporting";
  /** FINLYNQ-182 — present in reporting mode: the display currency totals are expressed in. */
  reportingCurrency?: string;
  filter: Required<Omit<DividendIncomeFilter, "reportingCurrency" | "pivot">>;
}

export async function listDividendIncome(
  userId: string,
  dek: Buffer | null,
  filter: DividendIncomeFilter = {},
): Promise<DividendIncomeResult> {
  let from = filter.from;
  let to = filter.to;
  if (filter.taxYear != null) {
    from = from ?? `${filter.taxYear}-01-01`;
    to = to ?? `${filter.taxYear}-12-31`;
  }

  const dividendsCategoryId = await resolveDividendsCategoryId(
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    db as any,
    userId,
    dek,
  );

  const reportingMode = filter.reportingCurrency === true;

  // Reporting mode aggregates the STORED historical `reporting_amount`
  // (locked at write time at each row's date rate) grouped by the stored
  // `reporting_currency` — never an on-the-fly FX conversion of `amount`
  // (FINLYNQ-182, product-owner-locked + the prod FX reporting invariant).
  // Resolve the user's display currency so the page/CSV can label the single
  // reporting bucket; the route also fires selfHealReportingAmounts so stale
  // rows re-rate in the background.
  const displayCurrency = reportingMode ? await getDisplayCurrency(userId) : null;

  const baseFilter: Required<Omit<DividendIncomeFilter, "reportingCurrency" | "pivot">> = {
    from: from ?? "",
    to: to ?? "",
    taxYear: filter.taxYear ?? 0,
    holdingId: filter.holdingId ?? 0,
    accountId: filter.accountId ?? 0,
    groupBy: filter.groupBy ?? "year",
  };

  const empty: DividendIncomeResult = {
    rows: filter.groupBy ? undefined : [],
    groups: filter.groupBy ? [] : undefined,
    totals: { amount: 0, rowCount: 0, byCurrency: {} },
    ...(reportingMode
      ? { mode: "reporting" as const, reportingCurrency: displayCurrency ?? "USD" }
      : { mode: "native" as const }),
    filter: baseFilter,
  };

  if (dividendsCategoryId == null) {
    // No Dividends category configured → no dividend income. Stdio
    // (no DEK) lands here too, matching the issue #84 graceful-degrade
    // contract: returns 0 rather than throwing.
    return empty;
  }

  const preds = [
    eq(schema.transactions.userId, userId),
    eq(schema.transactions.categoryId, dividendsCategoryId),
    isNotNull(schema.transactions.portfolioHoldingId),
  ];
  if (from) preds.push(gte(schema.transactions.date, from));
  if (to) preds.push(lte(schema.transactions.date, to));
  if (filter.holdingId != null) {
    // FINLYNQ-173: a dividend lands on the cash sleeve (portfolio_holding_id)
    // but is attributed to the paying security (related_holding_id). Match on
    // EITHER so a caller scoping to the security's id (the natural choice) OR
    // the cash sleeve's id both resolve that holding's dividends.
    preds.push(
      sql`(${schema.transactions.portfolioHoldingId} = ${filter.holdingId} OR ${schema.transactions.relatedHoldingId} = ${filter.holdingId})`,
    );
  }
  if (filter.accountId != null) {
    preds.push(eq(schema.transactions.accountId, filter.accountId));
  }

  // FINLYNQ-173: attribute the dividend to the PAYING SECURITY
  // (related_holding_id) rather than the cash sleeve it landed on
  // (portfolio_holding_id). A dividend row lands on the cash sleeve but
  // carries related_holding_id = the security; without this the
  // groupBy:"holding" view labels every dividend "Cash". Fall back to the
  // cash sleeve when no related holding was stamped (legacy rows / genuine
  // cash interest). The attribution holding feeds the name/account labels and
  // the holdingId, while the holdingId filter (filter.holdingId) still matches
  // EITHER the security or the cash sleeve so existing deep-links keep working.
  const attributionHoldingId = sql<number | null>`COALESCE(${schema.transactions.relatedHoldingId}, ${schema.transactions.portfolioHoldingId})`;
  const rph = alias(schema.portfolioHoldings, "rph");
  const rows = await db
    .select({
      txId: schema.transactions.id,
      date: schema.transactions.date,
      amount: schema.transactions.amount,
      enteredAmount: schema.transactions.enteredAmount,
      currency: schema.transactions.currency,
      enteredCurrency: schema.transactions.enteredCurrency,
      // FINLYNQ-182 — STORED historical reporting fields (reporting mode only).
      // Never converted at render time.
      reportingAmount: schema.transactions.reportingAmount,
      reportingCurrency: schema.transactions.reportingCurrency,
      quantity: schema.transactions.quantity,
      payeeCt: schema.transactions.payee,
      holdingId: attributionHoldingId,
      accountId: schema.transactions.accountId,
      // Prefer the related (security) holding's name; fall back to the
      // row's own holding (cash sleeve) when no related holding was stamped.
      holdingNameCt: sql<string | null>`COALESCE(${rph.nameCt}, ${schema.portfolioHoldings.nameCt})`,
      accountNameCt: schema.accounts.nameCt,
    })
    .from(schema.transactions)
    .leftJoin(
      schema.portfolioHoldings,
      eq(schema.portfolioHoldings.id, schema.transactions.portfolioHoldingId),
    )
    .leftJoin(
      rph,
      eq(rph.id, schema.transactions.relatedHoldingId),
    )
    .leftJoin(
      schema.accounts,
      eq(schema.accounts.id, schema.transactions.accountId),
    )
    .where(and(...preds));

  const dividendRows: DividendRow[] = rows.map((r) => {
    const amount = Number(r.enteredAmount ?? r.amount ?? 0);
    const ccy = (r.enteredCurrency ?? r.currency ?? "USD") as string;
    const qty = Number(r.quantity ?? 0);
    const payeePlain = r.payeeCt
      ? dek
        ? tryDecryptField(dek, String(r.payeeCt)) ?? null
        : null
      : null;
    const reportingAmount =
      r.reportingAmount != null ? Number(r.reportingAmount) : null;
    const reportingCurrency =
      r.reportingCurrency != null ? String(r.reportingCurrency).toUpperCase() : null;
    return {
      txId: r.txId,
      date: r.date,
      amount,
      currency: ccy,
      isReinvested: qty > 0,
      isWithholding: amount < 0,
      holdingId: r.holdingId ?? null,
      holdingName: decryptName(r.holdingNameCt, dek, null),
      accountId: r.accountId ?? null,
      accountName: decryptName(r.accountNameCt, dek, null),
      payee: payeePlain,
      reportingAmount,
      reportingCurrency,
    };
  });

  const agg = aggregateDividendRows(dividendRows, {
    groupBy: filter.groupBy,
    reportingMode,
    pivot: filter.pivot === true,
    displayCurrency,
  });

  if (!filter.groupBy) {
    return {
      rows: dividendRows,
      totals: agg.totals,
      ...agg.modeFields,
      filter: { ...baseFilter, groupBy: "year" },
    };
  }

  return {
    groups: agg.groups,
    totals: agg.totals,
    ...agg.modeFields,
    filter: { ...baseFilter, groupBy: filter.groupBy },
  };
}

/**
 * Pure aggregation core (FINLYNQ-182) — DB-free so it's unit-testable. Folds a
 * flat `DividendRow[]` into `{ groups, totals }` honoring the three modes:
 *
 *   - **legacy native** (`reportingMode=false`, `pivot=false`): one group row
 *     per `(period, currency)` reading `amount`/`currency` — UNCHANGED shape
 *     mobile + MCP consume.
 *   - **native pivot** (`pivot=true`): one group row per PERIOD with a
 *     `byCurrency` breakdown (the web report renders currencies as columns).
 *   - **reporting** (`reportingMode=true`): one group row per PERIOD reading
 *     the STORED `reporting_amount`/`reporting_currency` (locked at write
 *     time) — NEVER an on-the-fly FX conversion of `amount`. Rows with NULL
 *     reporting fields are EXCLUDED and surfaced as `unratedCount`.
 *
 * When `groupBy` is undefined only `totals`/`modeFields` are meaningful.
 */
export function aggregateDividendRows(
  dividendRows: DividendRow[],
  opts: {
    groupBy?: "quarter" | "year" | "holding";
    reportingMode: boolean;
    pivot: boolean;
    displayCurrency: string | null;
  },
): {
  groups: DividendGroupRow[];
  totals: DividendIncomeResult["totals"];
  modeFields:
    | { mode: "reporting"; reportingCurrency: string }
    | { mode: "native" };
} {
  const { reportingMode, groupBy } = opts;
  const repCcy = (opts.displayCurrency ?? "USD").toUpperCase();

  // Mode-aware "spend" of each row. Reporting mode reads the STORED
  // reporting_amount/reporting_currency; a NULL pair is EXCLUDED (never
  // converted at render time), returned as `null`.
  const spend = (
    r: DividendRow,
  ): { amount: number; currency: string } | null => {
    if (reportingMode) {
      if (r.reportingAmount == null || r.reportingCurrency == null) return null;
      return { amount: r.reportingAmount, currency: r.reportingCurrency };
    }
    return { amount: r.amount, currency: r.currency };
  };

  const totals: DividendIncomeResult["totals"] = {
    amount: 0,
    rowCount: dividendRows.length,
    byCurrency: {},
    ...(reportingMode ? { unratedCount: 0 } : {}),
  };
  for (const r of dividendRows) {
    const s = spend(r);
    if (!s) {
      totals.unratedCount = (totals.unratedCount ?? 0) + 1;
      continue;
    }
    totals.amount += s.amount;
    totals.byCurrency[s.currency] = (totals.byCurrency[s.currency] ?? 0) + s.amount;
  }

  const modeFields = reportingMode
    ? { mode: "reporting" as const, reportingCurrency: repCcy }
    : { mode: "native" as const };

  if (!groupBy) return { groups: [], totals, modeFields };

  // Pivot (one row per period) when reporting mode or native pivot was
  // requested. Legacy native keeps per-(period,currency) rows for mobile/MCP.
  const pivotByPeriod = reportingMode || opts.pivot;
  const wantByCurrency = !reportingMode && opts.pivot;

  const bucketOf = (r: DividendRow): { bucket: string; label: string } => {
    if (groupBy === "quarter") {
      const [y, m] = r.date.split("-").map((s) => parseInt(s, 10));
      const q = Math.floor((m - 1) / 3) + 1;
      const periodKey = `${y}-Q${q}`;
      return {
        bucket: pivotByPeriod ? periodKey : `${periodKey}-${r.currency}`,
        label: `${y} Q${q}`,
      };
    }
    if (groupBy === "year") {
      const y = r.date.slice(0, 4);
      return { bucket: pivotByPeriod ? y : `${y}-${r.currency}`, label: y };
    }
    const base = `holding:${r.holdingId}-${r.accountId}`;
    return {
      bucket: pivotByPeriod ? base : `${base}-${r.currency}`,
      label: r.holdingName ?? `holding #${r.holdingId}`,
    };
  };

  const groupMap = new Map<string, DividendGroupRow>();
  for (const r of dividendRows) {
    const s = spend(r);
    const { bucket, label } = bucketOf(r);
    const cell =
      groupMap.get(bucket) ??
      ({
        bucket,
        label,
        amount: 0,
        currency: s?.currency ?? r.currency,
        rowCount: 0,
        reinvestedCount: 0,
        withholdingCount: 0,
        ...(wantByCurrency ? { byCurrency: {} as Record<string, DividendCurrencyCell> } : {}),
        ...(reportingMode ? { unratedCount: 0 } : {}),
      } as DividendGroupRow);

    if (!s) {
      // reporting-mode laggard: count it on the period but don't fold the value.
      cell.unratedCount = (cell.unratedCount ?? 0) + 1;
      groupMap.set(bucket, cell);
      continue;
    }

    cell.amount += s.amount;
    cell.rowCount += 1;
    if (r.isReinvested) cell.reinvestedCount += 1;
    if (r.isWithholding) cell.withholdingCount += 1;

    if (wantByCurrency && cell.byCurrency) {
      const sub =
        cell.byCurrency[s.currency] ??
        { amount: 0, rowCount: 0, reinvestedCount: 0, withholdingCount: 0 };
      sub.amount += s.amount;
      sub.rowCount += 1;
      if (r.isReinvested) sub.reinvestedCount += 1;
      if (r.isWithholding) sub.withholdingCount += 1;
      cell.byCurrency[s.currency] = sub;
    }
    groupMap.set(bucket, cell);
  }

  // Stable sort: quarter / year by label DESC, holding by amount DESC.
  const groups = [...groupMap.values()];
  if (groupBy === "holding") {
    groups.sort((a, b) => b.amount - a.amount);
  } else {
    groups.sort((a, b) => b.label.localeCompare(a.label));
  }

  return { groups, totals, modeFields };
}

/**
 * Adopt this signature on the MCP HTTP `get_dividend_income` tool so the
 * helper above is the single source of truth across REST + MCP.
 *
 * FINLYNQ-182 — the CSV reflects the active mode:
 *   - raw rows (no groupBy): unchanged per-transaction export.
 *   - reporting mode: a single reporting-currency `total` column.
 *   - native pivot (`byCurrency` present): one money column per currency.
 *   - legacy native: unchanged `amount|currency` group export.
 */
export function dividendsToCsv(result: DividendIncomeResult): string {
  if (result.rows) {
    const header = [
      "date",
      "amount",
      "currency",
      "is_reinvested",
      "is_withholding",
      "holding",
      "account",
      "payee",
    ].join(",");
    const body = result.rows.map((r) =>
      [
        r.date,
        r.amount.toString(),
        r.currency,
        String(r.isReinvested),
        String(r.isWithholding),
        csvEscape(r.holdingName ?? `#${r.holdingId ?? 0}`),
        csvEscape(r.accountName ?? `#${r.accountId ?? 0}`),
        csvEscape(r.payee ?? ""),
      ].join(","),
    );
    return [header, ...body].join("\n");
  }

  const groups = result.groups ?? [];

  // Reporting mode — single reporting-currency Total column.
  if (result.mode === "reporting") {
    const ccy = result.reportingCurrency ?? "USD";
    const header = [
      "bucket",
      "label",
      `total_${ccy.toLowerCase()}`,
      "currency",
      "row_count",
      "reinvested_count",
      "withholding_count",
      "unrated_count",
    ].join(",");
    const body = groups.map((g) =>
      [
        g.bucket,
        csvEscape(g.label),
        g.amount.toString(),
        ccy,
        String(g.rowCount),
        String(g.reinvestedCount),
        String(g.withholdingCount),
        String(g.unratedCount ?? 0),
      ].join(","),
    );
    return [header, ...body].join("\n");
  }

  // Native pivot — one money column per currency present across all periods.
  const pivoted = groups.some((g) => g.byCurrency);
  if (pivoted) {
    const currencies = [
      ...new Set(groups.flatMap((g) => Object.keys(g.byCurrency ?? {}))),
    ].sort();
    const header = [
      "bucket",
      "label",
      ...currencies.map((c) => `amount_${c.toLowerCase()}`),
      "row_count",
      "reinvested_count",
      "withholding_count",
    ].join(",");
    const body = groups.map((g) =>
      [
        g.bucket,
        csvEscape(g.label),
        ...currencies.map((c) => {
          const cell = g.byCurrency?.[c];
          return cell ? cell.amount.toString() : "";
        }),
        String(g.rowCount),
        String(g.reinvestedCount),
        String(g.withholdingCount),
      ].join(","),
    );
    return [header, ...body].join("\n");
  }

  // Legacy native — unchanged.
  const header = [
    "bucket",
    "label",
    "amount",
    "currency",
    "row_count",
    "reinvested_count",
    "withholding_count",
  ].join(",");
  const body = groups.map((g) =>
    [
      g.bucket,
      csvEscape(g.label),
      g.amount.toString(),
      g.currency,
      String(g.rowCount),
      String(g.reinvestedCount),
      String(g.withholdingCount),
    ].join(","),
  );
  return [header, ...body].join("\n");
}

function csvEscape(s: string): string {
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

// decryptField unused but re-export to satisfy "complete decrypt path" intent
// in case a future caller wants payee plaintext with hard-fail.
export { decryptField };
