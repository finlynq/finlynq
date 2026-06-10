/**
 * GET/PUT /api/settings/email-retention — per-user imported-email retention
 * window (FINLYNQ-138).
 *
 * Governs how long raw imported emails (`email_inbox`) are kept before the
 * cleanup sweep hard-deletes them. Stored as the `email_retention_days` key in
 * the `settings` key/value table (no migration — key/value table). The sweep
 * (src/lib/email-import/cleanup.ts) reads this LIVE at sweep time, so a change
 * here immediately governs all existing emails — no re-stamp.
 *
 * Scope: raw email only. staged_imports / staged_transactions keep their own
 * fixed 14-day pending TTL — this setting does NOT touch them.
 *
 * Bounded windows only: {7, 30, 60, 90} days. Out-of-range values AND any
 * keep-forever sentinel are rejected with HTTP 400. Default (unset) = 60 days,
 * preserving the pre-FINLYNQ-138 behavior.
 *
 * Request body (JSON): { retentionDays: number }
 * Response: { retentionDays: number, options: number[] }
 */

import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import {
  EMAIL_RETENTION_SETTING_KEY,
  EMAIL_RETENTION_OPTIONS,
  parseRetentionDays,
  resolveRetentionDays,
  type EmailRetentionDays,
} from "@/lib/email-import/retention";

export const dynamic = "force-dynamic";

/** Read the per-user window. Defaults to 60 days when unset. */
export async function getEmailRetentionDays(
  userId: string,
): Promise<EmailRetentionDays> {
  const row = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(
      and(
        eq(schema.settings.key, EMAIL_RETENTION_SETTING_KEY),
        eq(schema.settings.userId, userId),
      ),
    )
    .get();
  return resolveRetentionDays(row?.value);
}

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  const retentionDays = await getEmailRetentionDays(auth.context.userId);
  return NextResponse.json({
    retentionDays,
    options: EMAIL_RETENTION_OPTIONS,
  });
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const retentionDays = parseRetentionDays(
    (body as { retentionDays?: unknown } | null)?.retentionDays,
  );
  // Out-of-range values AND any keep-forever sentinel land here → 400.
  if (retentionDays == null) {
    return NextResponse.json(
      {
        error: `retentionDays must be one of ${EMAIL_RETENTION_OPTIONS.join(", ")} days`,
        code: "retention-out-of-range",
      },
      { status: 400 },
    );
  }

  await db
    .insert(schema.settings)
    .values({
      key: EMAIL_RETENTION_SETTING_KEY,
      userId: auth.context.userId,
      value: String(retentionDays),
    })
    .onConflictDoUpdate({
      target: [schema.settings.key, schema.settings.userId],
      set: { value: String(retentionDays) },
    });

  return NextResponse.json({
    retentionDays,
    options: EMAIL_RETENTION_OPTIONS,
  });
}
