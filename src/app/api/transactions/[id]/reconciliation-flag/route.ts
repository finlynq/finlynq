/**
 * POST   /api/transactions/[id]/reconciliation-flag
 * DELETE /api/transactions/[id]/reconciliation-flag
 *
 * DB-side reconciliation annotations for the two-pane reconciliation UI
 * (FINLYNQ-56). The user flags a DB-side `transactions` row as
 * "the bank statement is missing this transaction I entered manually" —
 * a no-op for the approve flow (flags are display-only on the live
 * `transactions` table), but persists past staging cleanup so the user
 * can re-find them later.
 *
 * Body (POST):
 *   {
 *     flag_kind: "missing_from_statement",  // only kind today
 *     note?: string                          // optional free-text
 *   }
 *
 * Idempotency: POST never returns a 409 on duplicate flag — we just
 * INSERT a new row. The UI is expected to call DELETE first if the user
 * is changing the note. DELETE is fully idempotent — second DELETE
 * returns `data: { removed: 0 }`.
 *
 * Auth: requireEncryption() — uniform with the rest of the staging
 * surface. The flags table is plaintext (no DEK needed to write it) but
 * keeping the auth shape consistent prevents accidental session-cookie
 * downgrade attacks.
 *
 * Cross-tenant attacks return 404 on the parent `transactions` row.
 */

import { NextRequest, NextResponse } from "next/server";
import { randomUUID } from "crypto";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";

export const dynamic = "force-dynamic";

const PostSchema = z.object({
  flag_kind: z.enum(["missing_from_statement"]),
  note: z.string().max(2000).optional(),
});

async function verifyTransactionOwnership(
  transactionId: number,
  userId: string,
): Promise<boolean> {
  const tx = await db
    .select({ id: schema.transactions.id })
    .from(schema.transactions)
    .where(and(
      eq(schema.transactions.id, transactionId),
      eq(schema.transactions.userId, userId),
    ))
    .get();
  return !!tx;
}

function parseTransactionId(raw: string): number | null {
  const n = parseInt(raw, 10);
  return Number.isFinite(n) && n > 0 ? n : null;
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  const { id: idRaw } = await params;
  const transactionId = parseTransactionId(idRaw);
  if (transactionId == null) {
    return NextResponse.json({ error: "Invalid transaction id" }, { status: 400 });
  }

  let body: z.infer<typeof PostSchema>;
  try {
    const json = await request.json();
    body = PostSchema.parse(json);
  } catch (e) {
    return NextResponse.json(
      {
        error:
          e instanceof z.ZodError ? e.issues[0]?.message ?? "Invalid body" : "Invalid JSON",
      },
      { status: 400 },
    );
  }

  if (!(await verifyTransactionOwnership(transactionId, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const newId = randomUUID();
  await db.insert(schema.transactionReconciliationFlags).values({
    id: newId,
    transactionId,
    userId,
    flagKind: body.flag_kind,
    note: body.note ?? null,
  });

  return NextResponse.json(
    { success: true, data: { id: newId, flag_kind: body.flag_kind } },
    { status: 201 },
  );
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  const { id: idRaw } = await params;
  const transactionId = parseTransactionId(idRaw);
  if (transactionId == null) {
    return NextResponse.json({ error: "Invalid transaction id" }, { status: 400 });
  }

  // Optional flag_kind query param — defaults to 'missing_from_statement'
  // (the only kind today, so this is forward-compat plumbing). If a
  // future kind needs targeted deletion, the UI passes ?flag_kind=...
  const flagKind =
    request.nextUrl.searchParams.get("flag_kind") ?? "missing_from_statement";

  if (!(await verifyTransactionOwnership(transactionId, userId))) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const result = await db
    .delete(schema.transactionReconciliationFlags)
    .where(and(
      eq(schema.transactionReconciliationFlags.transactionId, transactionId),
      eq(schema.transactionReconciliationFlags.userId, userId),
      eq(schema.transactionReconciliationFlags.flagKind, flagKind),
    ));

  // Drizzle returns different shapes per dialect; rowCount is the canonical
  // post-DELETE count. Missing / undefined → treat as 0 for idempotency
  // (second DELETE returns 200 with removed: 0 — no error).
  const removed = (result as unknown as { rowCount?: number }).rowCount ?? 0;
  return NextResponse.json({ success: true, data: { removed } });
}
