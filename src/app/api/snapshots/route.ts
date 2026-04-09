import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, and, desc } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const data = await db
    .select({
      id: schema.snapshots.id,
      accountId: schema.snapshots.accountId,
      accountName: schema.accounts.name,
      date: schema.snapshots.date,
      value: schema.snapshots.value,
      note: schema.snapshots.note,
    })
    .from(schema.snapshots)
    .leftJoin(schema.accounts, eq(schema.snapshots.accountId, schema.accounts.id))
    .where(eq(schema.snapshots.userId, userId))
    .orderBy(desc(schema.snapshots.date))
    .all();
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

    const snap = await db.insert(schema.snapshots).values({
      userId: auth.context.userId,
      accountId: parsed.data.accountId,
      date: parsed.data.date,
      value: parsed.data.value,
      note: parsed.data.note ?? "",
    }).returning().get();
    return NextResponse.json(snap, { status: 201 });
  } catch (error: unknown) {
    const message = safeErrorMessage(error, "Failed to create snapshot");
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await db.delete(schema.snapshots).where(and(eq(schema.snapshots.id, id), eq(schema.snapshots.userId, auth.context.userId))).run();
  return NextResponse.json({ success: true });
}
