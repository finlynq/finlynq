/**
 * GET /api/reconcile/suggestions?accountId=<int>
 *
 * Returns the three-layer reconcile snapshot for one account:
 *   - `linked` — pairs already in `transaction_bank_links`
 *   - `suggestions` — exact-hash + fuzzy candidates (not yet linked)
 *   - `bankOnly` — bank ids with no linked tx and no suggestion
 *   - `txOnly` — tx ids with no linked bank and no suggestion
 *   - `transactions` / `bankTransactions` — per-id enrichment with decrypted
 *     payee + category + freshness metadata so the UI doesn't re-decrypt.
 *
 * Uses `requireEncryption()` because fuzzy matching needs the DEK to decrypt
 * tx + bank payees. A 423 here mirrors the bank-ledger feed at
 * `/api/import/bank-ledger` — without a DEK the surface can't render
 * meaningfully.
 *
 * Thresholds load from the per-user `settings(key='reconcile_thresholds')`
 * row, falling back to `RECONCILE_DEFAULT_THRESHOLDS`. The PUT lives at
 * `/api/settings/reconcile-thresholds` (Phase 4).
 *
 * Cross-tenant attacks return 404 — never 403 — consistent with the rest
 * of the staging + bank-ledger surface (no existence leak).
 *
 * Response envelope is the canonical `{ success: true, data }` per
 * CLAUDE.md MCP v3.1.0 contract.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  computeReconcileForAccount,
  RECONCILE_DEFAULT_THRESHOLDS,
  type ReconcileThresholds,
} from "@/lib/reconcile/match-engine";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  const accountIdRaw = request.nextUrl.searchParams.get("accountId");
  if (!accountIdRaw) {
    return NextResponse.json(
      { error: "Missing required query param: accountId" },
      { status: 400 },
    );
  }
  const accountId = parseInt(accountIdRaw, 10);
  if (!Number.isFinite(accountId) || accountId <= 0) {
    return NextResponse.json({ error: "Invalid accountId" }, { status: 400 });
  }

  // Optional date window. Two equivalent input shapes:
  //   - Legacy: `lookbackDays` (positive int = "last N days from today";
  //     accepted for back-compat with older URLs and bookmarks).
  //   - Explicit: `dateMin` + `dateMax` (ISO YYYY-MM-DD strings; either
  //     can be omitted independently). Preferred — the UI's date-from /
  //     date-to inputs send these directly so the user can pick an
  //     arbitrary window, not just the lookback presets.
  // Explicit params win when both shapes are present.
  const dateMinParam = parseIsoDateParam(
    request.nextUrl.searchParams.get("dateMin"),
  );
  const dateMaxParam = parseIsoDateParam(
    request.nextUrl.searchParams.get("dateMax"),
  );
  const lookbackRaw = request.nextUrl.searchParams.get("lookbackDays");
  const lookbackDays = lookbackRaw ? parseInt(lookbackRaw, 10) : null;
  const lookbackDateMin =
    lookbackDays != null && Number.isFinite(lookbackDays) && lookbackDays > 0
      ? shiftDaysFromToday(-lookbackDays)
      : null;
  const dateMin = dateMinParam ?? lookbackDateMin;
  const dateMax = dateMaxParam;

  // Cross-tenant attack returns 404 without leaking that the account
  // exists for another user. Same pattern as /api/import/bank-ledger.
  const acct = await db
    .select({ id: schema.accounts.id })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, accountId),
        eq(schema.accounts.userId, userId),
      ),
    )
    .limit(1);
  if (!acct[0]) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const thresholds = await loadThresholds(userId);

  const result = await computeReconcileForAccount({
    userId,
    dek,
    accountId,
    thresholds,
    dateMin,
    dateMax,
  });

  return NextResponse.json({
    success: true,
    data: {
      ...result,
      thresholds,
      lookbackDays: lookbackDays && lookbackDays > 0 ? lookbackDays : null,
      dateMin,
      dateMax,
    },
  });
}

/**
 * Parse an ISO `YYYY-MM-DD` query param. Returns null for missing,
 * malformed, or empty strings — match-engine treats null as "no bound".
 */
function parseIsoDateParam(raw: string | null): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return null;
  const ms = Date.parse(trimmed + "T00:00:00Z");
  if (Number.isNaN(ms)) return null;
  return trimmed;
}

/** Return the YYYY-MM-DD that is `deltaDays` from today (UTC). */
function shiftDaysFromToday(deltaDays: number): string {
  const ms = Date.now() + deltaDays * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Read the user's reconcile-threshold overrides from the generic
 * `settings` table. Falls back to `RECONCILE_DEFAULT_THRESHOLDS` when no
 * row exists or when the persisted JSON is malformed (defense in depth
 * — a corrupted row shouldn't break the page).
 */
async function loadThresholds(userId: string): Promise<ReconcileThresholds> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, "reconcile_thresholds"),
        eq(schema.settings.userId, userId),
      ),
    )
    .limit(1);
  if (!row[0]) return { ...RECONCILE_DEFAULT_THRESHOLDS };
  try {
    const parsed = JSON.parse(row[0].value);
    return {
      dateToleranceDays: numberOr(
        parsed?.dateToleranceDays,
        RECONCILE_DEFAULT_THRESHOLDS.dateToleranceDays,
      ),
      amountTolerancePct: numberOr(
        parsed?.amountTolerancePct,
        RECONCILE_DEFAULT_THRESHOLDS.amountTolerancePct,
      ),
      amountToleranceFloor: numberOr(
        parsed?.amountToleranceFloor,
        RECONCILE_DEFAULT_THRESHOLDS.amountToleranceFloor,
      ),
      scoreThreshold: numberOr(
        parsed?.scoreThreshold,
        RECONCILE_DEFAULT_THRESHOLDS.scoreThreshold,
      ),
    };
  } catch {
    return { ...RECONCILE_DEFAULT_THRESHOLDS };
  }
}

function numberOr(v: unknown, fallback: number): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}
