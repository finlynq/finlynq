/**
 * GET + PUT /api/settings/reconcile-thresholds
 *
 * Persists the four fuzzy-match thresholds used by the /reconcile page:
 *   - dateToleranceDays   (default 7)
 *   - amountTolerancePct  (default 0.07)
 *   - amountToleranceFloor (default 50)
 *   - scoreThreshold      (default 0.6)
 *
 * Storage: the generic `settings(key, userId, value)` table under
 * `key='reconcile_thresholds'`. Value is a JSON-stringified object.
 *
 * The seeded defaults are the single source of truth at
 * `pf-app/src/lib/reconcile/match-engine.ts`
 * `RECONCILE_DEFAULT_THRESHOLDS` — keep them in lockstep with anything
 * the cross-source detector at `pf-app/src/lib/external-import/duplicate-detect.ts`
 * uses as `DEFAULT_OPTIONS` so tuning one surface translates to the other.
 *
 * Mirrors the GET+PUT pattern from
 * `pf-app/src/app/api/settings/display-currency/route.ts` (5 of these
 * already in the codebase — same shape, same auth guard, same conflict-do-update).
 *
 * Read uses `requireAuth()` (no DEK needed — the persisted blob is plain
 * text). Write uses `requireAuth()` for the same reason — the persisted
 * values aren't user-data ciphertext.
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody } from "@/lib/validate";
import { RECONCILE_DEFAULT_THRESHOLDS } from "@/lib/reconcile/match-engine";

export const dynamic = "force-dynamic";

const SETTINGS_KEY = "reconcile_thresholds";

const thresholdSchema = z.object({
  dateToleranceDays: z
    .number()
    .int()
    .min(0)
    .max(30)
    .default(RECONCILE_DEFAULT_THRESHOLDS.dateToleranceDays),
  amountTolerancePct: z
    .number()
    .min(0)
    .max(1)
    .default(RECONCILE_DEFAULT_THRESHOLDS.amountTolerancePct),
  amountToleranceFloor: z
    .number()
    .min(0)
    .max(10000)
    .default(RECONCILE_DEFAULT_THRESHOLDS.amountToleranceFloor),
  scoreThreshold: z
    .number()
    .min(0)
    .max(1)
    .default(RECONCILE_DEFAULT_THRESHOLDS.scoreThreshold),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, SETTINGS_KEY),
        eq(schema.settings.userId, userId),
      ),
    )
    .limit(1);

  if (!row[0]) {
    return NextResponse.json({
      success: true,
      data: { thresholds: { ...RECONCILE_DEFAULT_THRESHOLDS }, isDefault: true },
    });
  }
  try {
    const parsed = thresholdSchema.parse(JSON.parse(row[0].value));
    return NextResponse.json({
      success: true,
      data: { thresholds: parsed, isDefault: false },
    });
  } catch {
    // Corrupt row — surface defaults rather than 500. The PUT will
    // overwrite on next save.
    return NextResponse.json({
      success: true,
      data: { thresholds: { ...RECONCILE_DEFAULT_THRESHOLDS }, isDefault: true },
    });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, thresholdSchema);
  if (parsed.error) return parsed.error;

  const value = JSON.stringify(parsed.data);

  await db
    .insert(schema.settings)
    .values({
      key: SETTINGS_KEY,
      userId,
      value,
    })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value },
    });

  return NextResponse.json({
    success: true,
    data: { thresholds: parsed.data, isDefault: false },
  });
}
