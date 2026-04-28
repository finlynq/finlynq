/**
 * GET    /api/admin/inbox/[id]      — full email incl. body_html (for sandboxed preview)
 * DELETE /api/admin/inbox/[id]      — delete the email
 * POST   /api/admin/inbox/[id]/mark — mark as triaged OR promote trash → mailbox
 *
 * Mark is defined below alongside DELETE since it's essentially the same
 * one-row mutation. (Mark-as-triaged set triaged_at; promote-to-mailbox
 * additionally clears expires_at so the row stops being auto-deleted.)
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const { id } = await params;

  const row = await db
    .select()
    .from(schema.incomingEmails)
    .where(eq(schema.incomingEmails.id, id))
    .get();

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  return NextResponse.json(row);
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const { id } = await params;

  const result = await db
    .delete(schema.incomingEmails)
    .where(eq(schema.incomingEmails.id, id));

  const rc = (result as unknown as { rowCount?: number }).rowCount ?? null;
  if (rc === 0) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  return NextResponse.json({ ok: true });
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const { id } = await params;
  const { userId } = auth.context;

  const body = await request.json().catch(() => ({})) as {
    action?: "triage" | "promote-to-mailbox";
  };

  if (body.action === "promote-to-mailbox") {
    // Move a trash row into the mailbox — clears expires_at so the cleanup
    // cron stops targeting it, and flips category. Audit log: record who
    // promoted via triaged_by.
    await db.update(schema.incomingEmails)
      .set({
        category: "mailbox",
        expiresAt: null,
        triagedAt: new Date(),
        triagedBy: userId,
      })
      .where(and(
        eq(schema.incomingEmails.id, id),
        eq(schema.incomingEmails.category, "trash"),
      ));
    return NextResponse.json({ ok: true });
  }

  // Default action: mark as triaged (admin has seen it, clears nav badge).
  await db.update(schema.incomingEmails)
    .set({
      triagedAt: new Date(),
      triagedBy: userId,
    })
    .where(eq(schema.incomingEmails.id, id));
  return NextResponse.json({ ok: true });
}
