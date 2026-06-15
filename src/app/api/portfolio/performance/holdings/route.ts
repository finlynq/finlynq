/**
 * GET /api/portfolio/performance/holdings?period=1m|3m|6m|ytd|1y|all&accountId=…&groupBy=holding|account
 *
 * Per-MEMBER daily market-value series for the stacked Performance view. The
 * base /api/portfolio/performance endpoint reads `portfolio_snapshots`, which
 * is per-ACCOUNT grain — it has no per-holding rows — so the stacked view needs
 * this companion endpoint.
 *
 * `groupBy` selects the band granularity (FINLYNQ-172):
 *   - `holding` (default) — one band per holding ("By holding (value)", FINLYNQ-129).
 *   - `account`           — one band per account ("By account"), summed from the
 *                           SAME per-holding pricing core via the holding→account
 *                           map (no extra pricing work). Account display names are
 *                           DEK-resolved here at the API boundary via
 *                           `safeAccountName` (the pure pricing core stays name-free).
 *
 * Why a SEPARATE, lazily-fetched endpoint (FINLYNQ-128 deferred this): a true
 * per-holding historical series means re-valuing every holding on every grid
 * day (prices + FX per holding per day). `getHoldingsValueByHolding` already
 * does the per-day per-holding pricing (shared core with
 * getHoldingsValueByAccount); `price_cache` + `fx_rates` amortize repeat days.
 * To keep the cost bounded we sample the grid to ≤ GRID_CAP evenly-spaced days
 * (always including the latest) and fetch ONLY when the user toggles stacked
 * mode — the aggregate Performance chart keeps using the cheap snapshot route.
 *
 * Each point ties to the portfolio market value: the per-member values are
 * summed in the holding's account currency then converted to the reporting
 * currency, so Σ(members) at a day equals that day's snapshot market value
 * (the stacked outer edge equals the aggregate line — tc-1).
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { and, eq, gte, isNull, lte } from "drizzle-orm";
import { db, schema } from "@/db";
import {
  getHoldingsValueByHolding,
  type HoldingValue,
} from "@/lib/holdings-value";
import { getRate, getDisplayCurrency } from "@/lib/fx-service";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { safeName, safeAccountName } from "@/lib/safe-name";
import { logApiError } from "@/lib/validate";
import { todayISO } from "@/lib/utils/date";

/** Max grid days valued — bounds the prices×FX×holdings work on a cold cache. */
const GRID_CAP = 40;

const PERIOD_DAYS: Record<string, number | null> = {
  "1m": 30,
  "3m": 90,
  "6m": 180,
  ytd: -1,
  "1y": 365,
  all: null,
};

function rangeStart(period: string, asOfDate: string): string {
  if (period === "ytd") return `${asOfDate.slice(0, 4)}-01-01`;
  const days = PERIOD_DAYS[period];
  if (days == null) return "1900-01-01";
  const d = new Date(`${asOfDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - days);
  return d.toISOString().slice(0, 10);
}

/** Evenly sample at most `cap` items, ALWAYS keeping the first and last. */
function sampleEvenly<T>(items: T[], cap: number): T[] {
  if (items.length <= cap) return items;
  const out: T[] = [];
  const step = (items.length - 1) / (cap - 1);
  for (let i = 0; i < cap; i++) out.push(items[Math.round(i * step)]);
  // De-dup adjacent (rounding can repeat) while preserving order.
  return out.filter((v, i) => i === 0 || v !== out[i - 1]);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const period = params.get("period") ?? "1y";
  const accountId = params.get("accountId")
    ? parseInt(params.get("accountId")!, 10)
    : null;
  // FINLYNQ-172 — band granularity. Anything other than "account" (incl. the
  // legacy unset case) keeps the per-holding behavior.
  const groupBy = params.get("groupBy") === "account" ? "account" : "holding";

  try {
    const asOfDate = todayISO();
    const from = rangeStart(period, asOfDate);
    const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));

    // FINLYNQ-172 — when grouping by account, DEK-resolve account display names
    // ONCE up front (alias preferred via safeAccountName). The per-holding
    // pricing core stays name-free; names are attached here at the boundary.
    const accountNameById = new Map<number, string>();
    if (groupBy === "account") {
      const acctRows = await db
        .select({
          id: schema.accounts.id,
          nameCt: schema.accounts.nameCt,
          aliasCt: schema.accounts.aliasCt,
        })
        .from(schema.accounts)
        .where(eq(schema.accounts.userId, userId));
      const decrypted = decryptNamedRows(acctRows, dek, {
        nameCt: "name",
        aliasCt: "alias",
      }) as Array<(typeof acctRows)[number] & { name: string | null; alias: string | null }>;
      for (const a of decrypted) {
        accountNameById.set(a.id, safeAccountName(a));
      }
    }

    // Snapshot dates define the grid (same dates the aggregate chart plots).
    const preds = [
      eq(schema.portfolioSnapshots.userId, userId),
      gte(schema.portfolioSnapshots.snapDate, from),
      lte(schema.portfolioSnapshots.snapDate, asOfDate),
    ];
    preds.push(
      accountId != null
        ? eq(schema.portfolioSnapshots.accountId, accountId)
        : isNull(schema.portfolioSnapshots.accountId),
    );
    const snapRows = await db
      .select({ date: schema.portfolioSnapshots.snapDate })
      .from(schema.portfolioSnapshots)
      .where(and(...preds))
      .orderBy(schema.portfolioSnapshots.snapDate);

    let gridDates = Array.from(new Set(snapRows.map((r) => r.date)));
    // Always value the latest point with live "today" so the stacked outer edge
    // matches the live portfolio market value (mirrors the snapshot chart's
    // live-today substitution). Add today if the grid stops short of it.
    if (gridDates.length === 0) gridDates = [asOfDate];
    if (gridDates[gridDates.length - 1] !== asOfDate) gridDates.push(asOfDate);
    gridDates = sampleEvenly(gridDates, GRID_CAP);

    // FX cache shared across all grid days (account ccy → display ccy at the
    // historical day's rate; today uses today's rate).
    const fxCache = new Map<string, number>();
    const convert = async (
      amount: number,
      fromCcy: string,
      date: string,
    ): Promise<number> => {
      if (fromCcy === displayCurrency || amount === 0) return amount;
      const key = `${fromCcy}>${displayCurrency}@${date}`;
      let rate = fxCache.get(key);
      if (rate == null) {
        try {
          rate = (await getRate(fromCcy, displayCurrency, date, userId)) || 1;
        } catch {
          rate = 1;
        }
        fxCache.set(key, rate);
      }
      return amount * rate;
    };

    // Value every holding on each sampled grid day, accumulate into stacked
    // points. Member values are in the DISPLAY currency so the stack ties to
    // the reporting-currency aggregate line.
    const points: Array<{
      date: string;
      total: number;
      members: { id: number; name: string; value: number }[];
    }> = [];

    for (const date of gridDates) {
      let rows: HoldingValue[];
      try {
        rows = await getHoldingsValueByHolding(userId, dek, { asOfDate: date, accountId });
      } catch {
        rows = [];
      }
      // Group key + display name differ per `groupBy`, but the value is the
      // SAME per-holding market value (display-ccy) either way, so account
      // bands sum to the identical grand total as the holding bands (tc-1).
      const memberAcc = new Map<number, { id: number; name: string; value: number }>();
      let total = 0;
      for (const h of rows) {
        if (!Number.isFinite(h.value) || h.value === 0) continue;
        const converted = await convert(h.value, h.currency, date);
        const id = groupBy === "account" ? h.accountId : h.holdingId;
        const name =
          groupBy === "account"
            ? accountNameById.get(h.accountId) ?? safeAccountName({ id: h.accountId, name: null })
            : safeName(h.name, "Holding", h.holdingId);
        const existing = memberAcc.get(id);
        if (existing) existing.value += converted;
        else memberAcc.set(id, { id, name, value: converted });
        total += converted;
      }
      const members = [...memberAcc.values()].map((m) => ({
        id: m.id,
        name: m.name,
        value: Math.round(m.value * 100) / 100,
      }));
      points.push({ date, total: Math.round(total * 100) / 100, members });
    }

    return NextResponse.json({
      success: true,
      data: {
        period,
        accountId,
        groupBy,
        from,
        to: asOfDate,
        currency: displayCurrency,
        points,
      },
    });
  } catch (error: unknown) {
    await logApiError("GET", "/api/portfolio/performance/holdings", error, userId);
    const message =
      error instanceof Error ? error.message : "Failed to load per-holding performance";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
