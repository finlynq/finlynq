import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq, desc } from "drizzle-orm";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const data = db
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
    .orderBy(desc(schema.snapshots.date))
    .all();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const snap = db.insert(schema.snapshots).values({
      accountId: body.accountId,
      date: body.date,
      value: body.value,
      note: body.note ?? "",
    }).returning().get();
    return NextResponse.json(snap, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  const id = parseInt(request.nextUrl.searchParams.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  db.delete(schema.snapshots).where(eq(schema.snapshots.id, id)).run();
  return NextResponse.json({ success: true });
}
