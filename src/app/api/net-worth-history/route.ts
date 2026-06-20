/**
 * GET /api/net-worth-history?period=6m|1y|all&accountId=<optional int>
 *
 * Accurate "Net Worth Over Time" (and per-account "Balance Over Time") daily
 * series. Cash/liability accounts are computed live from `transactions`;
 * investment accounts read the stored daily `portfolio_snapshots`, with TODAY
 * substituted by the live holdings aggregator so the latest point matches the
 * dashboard hero net-worth number exactly.
 *
 * Mirrors the head of /api/dashboard (requireAuth → getDEK → getDisplayCurrency
 * → getRateMap). The heavy lifting is the pure `buildNetWorthHistory` core.
 *
 * plan/net-worth-over-time.md Part A.
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import {
  getRateMap,
  getDisplayCurrency,
} from "@/lib/fx-service";
import {
  getAccountBalances,
  getCashSnapshotsInRange,
  getCashTxFingerprint,
  getInvestmentSnapshotsInRange,
} from "@/lib/queries";
import { getHoldingsValueByAccount, type AccountHoldingsValue } from "@/lib/holdings-value";
import { logApiError } from "@/lib/validate";
import { decryptName } from "@/lib/crypto/encrypted-columns";
import { safeAccountName } from "@/lib/safe-name";
import { rankBreakdown } from "@/lib/chart-breakdown";
import {
  buildNetWorthHistory,
  type NetWorthPeriod,
  type LiveAccountValue,
} from "@/lib/net-worth-history";
import {
  rebuildPortfolioSnapshots,
  tryBeginRebuild,
  endRebuild,
  reportRebuildProgress,
  tryBeginCashRebuild,
  endCashRebuild,
} from "@/lib/portfolio/snapshots/rebuild";
import { rebuildCashSnapshots } from "@/lib/portfolio/snapshots/cash-builder";
import { getCashSnapshotMeta, isCashStale } from "@/lib/portfolio/snapshots/cash-meta";
import { listDirtySnapshotUsers, clearDirtyIfUnchanged } from "@/lib/portfolio/snapshots/dirty";

/**
 * DEK-bearing self-heal. Background jobs have no DEK (Stream D encrypts holding
 * symbols), so a cron CANNOT correctly value investment holdings — it would
 * write $1/unit garbage. This request DOES have the session DEK, and the chart
 * is exactly where stale investment history surfaces, so we rebuild here:
 *   - when a back-dated investment edit left a dirty marker, OR
 *   - on first view for a user who has live investments but no snapshots yet.
 * Fire-and-forget (the standalone Node server persists the work); the current
 * response uses existing snapshots and the NEXT load reflects the rebuild.
 */
function kickSelfHeal(
  userId: string,
  dek: Buffer,
  today: string,
  dirtyFrom: string | null,
  dirtyMarkedAt: string | null,
  needsInitialBackfill: boolean,
): void {
  if (!dirtyFrom && !needsInitialBackfill) return;
  if (!tryBeginRebuild(userId)) return; // a rebuild is already running
  // dirtyFrom drives back-dated-edit refresh; null → full history (initial backfill).
  const from = dirtyFrom;
  void (async () => {
    try {
      // Thread progress into the SHARED registry so the "Rebuild investment
      // history" button (which polls the same registry on mount) shows a real
      // determinate "day X of Y" bar while this background self-heal runs —
      // instead of a perma-"starting…". `tryBeginRebuild` above seeds the entry
      // running:true, but WITHOUT an onProgress callback `totalDays`/
      // `daysProcessed` never update, so the button froze on "starting…" the
      // whole walk even though the rebuild was progressing fine.
      const result = await rebuildPortfolioSnapshots(userId, from, today, dek, (done, total) =>
        reportRebuildProgress(userId, done, total),
      );
      if (dirtyMarkedAt) await clearDirtyIfUnchanged(userId, dirtyMarkedAt);
      endRebuild(userId, { result });
    } catch (err) {
      console.warn(
        "[net-worth-history] self-heal rebuild failed:",
        err instanceof Error ? err.message : err,
      );
      endRebuild(userId, { error: err instanceof Error ? err.message : "self-heal failed" });
    }
  })();
}

/**
 * DEK-FREE cash self-heal. Cash balance = cumulative SUM(tx.amount) + cached FX,
 * so unlike the investment self-heal this needs no DEK and runs on every chart
 * load when the staleness watermark trips (a cash tx inserted/edited/deleted, a
 * new calendar day, or never-built). Fire-and-forget + in-flight guarded; the
 * current response uses existing snapshots and the NEXT load reflects the
 * rebuild. plan/net-worth-cash-snapshots.md Phase 4.
 */
function kickCashSelfHeal(userId: string, today: string): void {
  if (!tryBeginCashRebuild(userId)) return; // a cash rebuild is already running
  void (async () => {
    try {
      // Full history + stamp the watermark fresh (it captures the fingerprint
      // BEFORE building, so a mid-build write re-trips stale on the next load).
      await rebuildCashSnapshots({ userId, fromDate: null, toDate: today, stampMeta: true });
    } catch (err) {

      console.warn(
        "[net-worth-history] cash self-heal failed:",
        err instanceof Error ? err.message : err,
      );
    } finally {
      endCashRebuild(userId);
    }
  })();
}

function parsePeriod(raw: string | null): NetWorthPeriod {
  return raw === "6m" || raw === "1y" || raw === "all" ? raw : "6m";
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;

  const params = request.nextUrl.searchParams;
  const period = parsePeriod(params.get("period"));
  const accountId = params.get("accountId")
    ? parseInt(params.get("accountId")!, 10)
    : null;

  try {
    const today = new Date().toISOString().slice(0, 10);
    const displayCurrency = await getDisplayCurrency(userId, params.get("currency"));
    const rateMap = await getRateMap(displayCurrency, userId);

    // Cash side AND investment side now both read stored per-account snapshots
    // (cash translated at each day's historical FX rate; investment at market
    // value). The cash side used to be computed live from transactions and
    // re-translated at TODAY's rate every load (the drift this change fixes).
    const cashSnapshotRows = await getCashSnapshotsInRange(
      userId,
      "1900-01-01",
      today,
      accountId ?? undefined,
    );
    const snapshotRows = await getInvestmentSnapshotsInRange(
      userId,
      "1900-01-01",
      today,
      accountId ?? undefined,
    );

    // Today's live override. Restrict to the SAME non-archived account sets the
    // dashboard hero sums over, so the latest point matches.
    const balances = await getAccountBalances(userId);
    const investmentAccountIds = new Set(
      balances.filter((b) => Boolean(b.isInvestment)).map((b) => b.accountId),
    );
    // Live cash balance (native ccy, current rate) per non-investment account —
    // overrides the snapshot value on TODAY so the latest point equals the hero.
    const liveCashByAccount = new Map<number, LiveAccountValue>();
    for (const b of balances) {
      if (b.isInvestment) continue; // investment value comes from the holdings aggregator
      if (accountId != null && b.accountId !== accountId) continue;
      liveCashByAccount.set(b.accountId, {
        value: Number(b.balance ?? 0),
        currency: b.currency,
      });
    }
    // The live "today" override only applies to INVESTMENT accounts. Valuing the
    // whole portfolio (getHoldingsValueByAccount prices every holding live) is
    // pointless when the in-scope account set has no investment account — e.g. a
    // cash account's per-account chart, which would otherwise pay the full
    // ~all-holdings valuation for a result it immediately discards. Skip it.
    const scopeHasInvestmentAccount =
      accountId != null
        ? investmentAccountIds.has(accountId)
        : investmentAccountIds.size > 0;
    const holdingsByAccount: Map<number, AccountHoldingsValue> =
      scopeHasInvestmentAccount
        ? await getHoldingsValueByAccount(userId, dek)
        : new Map();
    const liveInvestmentByAccount = new Map<number, LiveAccountValue>();
    for (const [accId, v] of holdingsByAccount) {
      if (!investmentAccountIds.has(accId)) continue;
      if (accountId != null && accId !== accountId) continue;
      liveInvestmentByAccount.set(accId, { value: v.value, currency: v.currency });
    }

    const snapshots = snapshotRows.map((r) => ({
      accountId: r.accountId as number,
      snapDate: r.snapDate,
      marketValue: Number(r.marketValue),
      currency: r.currency,
    }));
    const cashSnapshots = cashSnapshotRows.map((r) => ({
      accountId: r.accountId as number,
      snapDate: r.snapDate,
      marketValue: Number(r.marketValue),
      currency: r.currency,
    }));

    const { series: rawSeries, hasInvestmentData, fxApproximation } = buildNetWorthHistory({
      period,
      displayCurrency,
      rateMap,
      cashSnapshots,
      liveCashByAccount,
      snapshots,
      liveInvestmentByAccount,
      today,
    });

    // FINLYNQ-128 — resolve each per-account breakdown entry to a display name
    // (decrypt + safeAccountName fallback for a missing DEK) and rank it into a
    // top-10 + "Other" residual so the tooltip can render it directly. The
    // pure core stays name-free (no DEK); naming + ranking happen here.
    const accountNameById = new Map<number, string>();
    for (const b of balances) {
      const name = decryptName((b as { accountNameCt?: string | null }).accountNameCt, dek, null);
      const alias = decryptName((b as { aliasCt?: string | null }).aliasCt, dek, null);
      accountNameById.set(b.accountId, safeAccountName({ id: b.accountId, name, alias }));
    }
    const series = rawSeries.map((p) => {
      const named = p.breakdown.map((e) => ({
        id: e.accountId,
        name: accountNameById.get(e.accountId) ?? `Account #${e.accountId}`,
        value: e.value,
      }));
      const { rows, other } = rankBreakdown(named, { maxMembers: 10 });
      const breakdown = other ? [...rows, other] : rows;
      // FINLYNQ-129 — the stacked "By account" view needs the FULL per-account
      // members (with stable account ids) so the client can re-rank + stack on
      // toggle. `breakdown` stays the pre-ranked top-10 + "Other" tooltip rows.
      return { date: p.date, value: p.value, breakdown, members: named };
    });

    // Auto-rebuild stale investment history with the request DEK (a cron can't
    // — see kickSelfHeal). Only when we actually have a DEK to price correctly.
    if (dek) {
      const needsInitialBackfill =
        liveInvestmentByAccount.size > 0 && snapshots.length === 0;
      let dirtyFrom: string | null = null;
      let dirtyMarkedAt: string | null = null;
      try {
        const dirty = await listDirtySnapshotUsers();
        const mine = dirty.find((d) => d.userId === userId);
        if (mine) {
          dirtyFrom = mine.fromDate;
          dirtyMarkedAt = mine.markedAt;
        }
      } catch {
        /* dirty lookup is best-effort */
      }
      kickSelfHeal(userId, dek, today, dirtyFrom, dirtyMarkedAt, needsInitialBackfill);
    }

    // Cash self-heal — DEK-free, so it runs regardless of `dek`. Fires when the
    // stored cash snapshots are stale (a cash tx changed, a new day rolled over,
    // or they were never built). plan/net-worth-cash-snapshots.md Phase 4.
    try {
      const cashFp = await getCashTxFingerprint(userId);
      const cashMeta = await getCashSnapshotMeta(userId);
      if (cashFp.count > 0 && isCashStale(cashFp, cashMeta, today)) {
        kickCashSelfHeal(userId, today);
      }
    } catch {
      /* cash staleness check is best-effort */
    }

    return NextResponse.json({
      displayCurrency,
      period,
      accountId,
      series,
      hasInvestmentData,
      fxApproximation,
    });
  } catch (error: unknown) {
    await logApiError("GET", "/api/net-worth-history", error, userId);
    const message =
      error instanceof Error ? error.message : "Failed to load net worth history";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
