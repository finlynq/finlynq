import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { verifyOwnership, OwnershipError } from "@/lib/verify-ownership";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  // Stream D Phase 4 — plaintext accountName dropped.
  const raw = await db
    .select({
      id: schema.snapshots.id,
      accountId: schema.snapshots.accountId,
      accountNameCt: schema.accounts.nameCt,
      date: schema.snapshots.date,
      value: schema.snapshots.value,
      note: schema.snapshots.note,
    })
    .from(schema.snapshots)
    .leftJoin(schema.accounts, eq(schema.snapshots.accountId, schema.accounts.id))
    .where(eq(schema.snapshots.userId, userId))
    .orderBy(desc(schema.snapshots.date))
    .all();
  const data = decryptNamedRows(raw, auth.context.dek, {
    accountNameCt: "accountName",
  });
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();

    const snapshotSchema = z.object({
      accountId: z.number(),
      date: z.string(),
      value: z.number(),
      note: z.string().optional(),
    });
    const parsed = validateBody(body, snapshotSchema);
    if (parsed.error) return parsed.error;

    // Cross-tenant FK guard (H-1). Without this, a snapshot row for user B's
    // account_id would land under user A's user_id and surface in A's UI
    // (or just silently corrupt B's account-balance history).
    await verifyOwnership(auth.context.userId, {
      accountIds: [parsed.data.accountId],
    });

    const snap = await db.insert(schema.snapshots).values({
      userId: auth.context.userId,
      accountId: parsed.data.accountId,
      date: parsed.data.date,
      value: parsed.data.value,
      note: parsed.data.note ?? "",
    }).returning().get();
    return NextResponse.json(snap, { status: 201 });
  } catch (error: unknown) {
    if (error instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const message = safeErrorMessage(error, "Failed to create snapshot");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.snapshots).where(and(eq(schema.snapshots.id, id), eq(schema.snapshots.userId, auth.context.userId)));
  return NextResponse.json({ success: true });
}
