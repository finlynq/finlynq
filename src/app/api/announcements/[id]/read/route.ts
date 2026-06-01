/**
 * POST /api/announcements/[id]/read — mark an announcement read/dismissed for
 * the current user. Idempotent: a unique (user_id, announcement_id) PK means a
 * repeat call is a no-op via onConflictDoNothing.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";

export const dynamic = "force-dynamic";

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const { id } = await params;
  const announcementId = Number(id);
  if (!Number.isInteger(announcementId) || announcementId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  await db
    .insert(schema.announcementReads)
    .values({ userId, announcementId })
    .onConflictDoNothing();

  return NextResponse.json({ ok: true });
}
