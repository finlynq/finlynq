/**
 * GET    /api/import/staged/[id]  — detail + preview rows for approval
 * DELETE /api/import/staged/[id]  — reject (deletes staged rows via cascade)
 *
 * Approve lives at /api/import/staged/[id]/approve (separate file — it needs
 * DEK auth whereas detail + reject only need session auth).
 *
 * All routes are user-scoped via userId filter. 404 if the staged_import
 * doesn't belong to the caller.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq, asc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { decryptStaged } from "@/lib/crypto/staging-envelope";
import { tryDecryptField } from "@/lib/crypto/envelope";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  // Switched from requireAuth to requireEncryption (2026-05-06): rows can now
  // be at either 'service' or 'user' encryption tier; user-tier rows need the
  // DEK to decrypt. Forcing DEK presence for service-tier rows too keeps the
  // route a single shape and matches CLAUDE.md "reads use requireAuth() OR
  // requireEncryption() depending on whether they touch encrypted columns".
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  const staged = await db
    .select()
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ))
    .get();

  if (!staged) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const rows = await db
    .select({
      id: schema.stagedTransactions.id,
      date: schema.stagedTransactions.date,
      amount: schema.stagedTransactions.amount,
      currency: schema.stagedTransactions.currency,
      payee: schema.stagedTransactions.payee,
      category: schema.stagedTransactions.category,
      accountName: schema.stagedTransactions.accountName,
      note: schema.stagedTransactions.note,
      rowIndex: schema.stagedTransactions.rowIndex,
      isDuplicate: schema.stagedTransactions.isDuplicate,
      encryptionTier: schema.stagedTransactions.encryptionTier,
    })
    .from(schema.stagedTransactions)
    .where(eq(schema.stagedTransactions.stagedImportId, id))
    .orderBy(asc(schema.stagedTransactions.rowIndex))
    .all();

  // Branch on encryption_tier per row (2026-05-06): mixed tiers are expected
  // mid-upgrade (the login-time job is async). 'user' rows are v1: ciphertext
  // under the session DEK; 'service' rows are sv1: under PF_STAGING_KEY.
  const decryptedRows = rows.map((r) => {
    const decode = (v: string | null): string | null => {
      if (v == null) return null;
      return r.encryptionTier === "user"
        ? tryDecryptField(dek, v) // returns null on auth-tag failure
        : decryptStaged(v);
    };
    return {
      ...r,
      payee: decode(r.payee),
      category: decode(r.category),
      accountName: decode(r.accountName),
      note: decode(r.note),
    };
  });

  return NextResponse.json({ staged, rows: decryptedRows });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const { id } = await params;

  // Delete is scoped — if the id doesn't belong to this user, row count = 0
  // and we surface 404 without leaking that the id exists for someone else.
  const result = await db
    .delete(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.id, id),
      eq(schema.stagedImports.userId, userId),
    ));

  // Drizzle returns different shapes per dialect; check rowCount via any-cast.
  const rc = (result as unknown as { rowCount?: number }).rowCount ?? null;
  if (rc === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json({ ok: true });
}
