/**
 * PATCH /api/accounts/[id]/mode — Reconcile v4 Phase 1 (2026-05-27)
 *
 * Updates an account's pipeline policy. The new `accounts.mode` column
 * is one of:
 *
 *   'auto'    — Auto-pilot: rules fire at upload, rows land in ledger
 *   'approve' — Approve-each: bank-write auto, ledger needs one click
 *   'manual'  — Manual review: legacy two-pane staging + reconcile flow
 *
 * Surfaced by the lens-chip dropdown's "Save as default" toast on the
 * upcoming /inbox surface (Phase 2). Owner-scoped — a stranger trying
 * to flip another tenant's account gets a 404.
 *
 * Request body (JSON):
 *   { mode: "auto" | "approve" | "manual" }
 *
 * Response shapes:
 *   200 — { success: true, data: { id, mode } }
 *   400 — { error: "..." } (missing/invalid mode)
 *   404 — { error: "Not found" } (stranger or no such account)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

const VALID_MODES = ["auto", "approve", "manual"] as const;
type AccountMode = (typeof VALID_MODES)[number];

function isAccountMode(value: unknown): value is AccountMode {
  return (
    typeof value === "string" &&
    (VALID_MODES as readonly string[]).includes(value)
  );
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id: rawId } = await params;

  const id = Number(rawId);
  if (!Number.isFinite(id)) {
    return NextResponse.json({ error: "Invalid account id" }, { status: 400 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const mode = (body as { mode?: unknown } | null)?.mode;
  if (!isAccountMode(mode)) {
    return NextResponse.json(
      { error: "mode must be one of 'auto', 'approve', 'manual'" },
      { status: 400 },
    );
  }

  try {
    const updated = await db
      .update(schema.accounts)
      .set({ mode })
      .where(
        and(
          eq(schema.accounts.id, id),
          eq(schema.accounts.userId, userId),
        ),
      )
      .returning({
        id: schema.accounts.id,
        mode: schema.accounts.mode,
      });

    if (updated.length === 0) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    return NextResponse.json({
      success: true,
      data: { id: updated[0].id, mode: updated[0].mode },
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to update account mode") },
      { status: 500 },
    );
  }
}
