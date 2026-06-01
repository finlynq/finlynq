/**
 * PATCH /api/admin/feedback/[id] — update a feedback item's status / admin note.
 * Gated by requireAdmin + managed-mode guard; audit-logged.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema, getDialect } from "@/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { logAdminAction, clientIp } from "@/lib/admin-audit";

export const dynamic = "force-dynamic";

const patchSchema = z.object({
  status: z.enum(["new", "triaged", "resolved"]).optional(),
  adminNote: z.string().max(4000).nullable().optional(),
});

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const adminUserId = auth.context.userId;

  const feedbackId = Number((await params).id);
  if (!Number.isInteger(feedbackId) || feedbackId <= 0) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, patchSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;

    const [existing] = await db
      .select()
      .from(schema.feedback)
      .where(eq(schema.feedback.id, feedbackId));
    if (!existing) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const update: Partial<typeof schema.feedback.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (d.status !== undefined) update.status = d.status;
    if (d.adminNote !== undefined) update.adminNote = d.adminNote;

    const [row] = await db
      .update(schema.feedback)
      .set(update)
      .where(eq(schema.feedback.id, feedbackId))
      .returning();

    if (d.status !== undefined && d.status !== existing.status) {
      await logAdminAction({
        adminUserId,
        action: "feedback_status_change",
        before: { id: existing.id, status: existing.status },
        after: { id: row.id, status: row.status },
        ip: clientIp(request),
      });
    }

    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to update feedback.") },
      { status: 500 },
    );
  }
}
