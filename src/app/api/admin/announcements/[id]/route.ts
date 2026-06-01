/**
 * Admin announcement item API.
 *
 *  PATCH  /api/admin/announcements/[id] — edit / publish-toggle / set expiry.
 *  DELETE /api/admin/announcements/[id] — delete (announcement_reads cascade).
 *
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

function managedOnly() {
  return NextResponse.json(
    { error: "Admin features are only available in managed mode." },
    { status: 403 },
  );
}

const patchSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  body: z.string().min(1).max(10000).optional(),
  category: z.enum(["news", "update", "maintenance"]).optional(),
  severity: z.enum(["info", "warning"]).optional(),
  pinned: z.boolean().optional(),
  published: z.boolean().optional(),
  expiresAt: z.string().nullable().optional(),
});

function parseId(id: string): number | null {
  const n = Number(id);
  return Number.isInteger(n) && n > 0 ? n : null;
}

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (getDialect() !== "postgres") return managedOnly();
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const adminUserId = auth.context.userId;

  const announcementId = parseId((await params).id);
  if (announcementId === null) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, patchSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;

    const [existing] = await db
      .select()
      .from(schema.announcements)
      .where(eq(schema.announcements.id, announcementId));
    if (!existing) {
      return NextResponse.json({ error: "Not found." }, { status: 404 });
    }

    const update: Partial<typeof schema.announcements.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (d.title !== undefined) update.title = d.title;
    if (d.body !== undefined) update.body = d.body;
    if (d.category !== undefined) update.category = d.category;
    if (d.severity !== undefined) update.severity = d.severity;
    if (d.pinned !== undefined) update.pinned = d.pinned;
    if (d.published !== undefined) {
      update.published = d.published;
      // Stamp publishedAt the first time it goes live; clear when unpublished.
      if (d.published && !existing.publishedAt) update.publishedAt = new Date();
      if (!d.published) update.publishedAt = null;
    }
    if (d.expiresAt !== undefined) {
      if (d.expiresAt === null || d.expiresAt === "") {
        update.expiresAt = null;
      } else {
        const dt = new Date(d.expiresAt);
        if (Number.isNaN(dt.getTime())) {
          return NextResponse.json({ error: "Invalid expiresAt." }, { status: 400 });
        }
        update.expiresAt = dt;
      }
    }

    const [row] = await db
      .update(schema.announcements)
      .set(update)
      .where(eq(schema.announcements.id, announcementId))
      .returning();

    await logAdminAction({
      adminUserId,
      action: "announcement_updated",
      before: { published: existing.published, pinned: existing.pinned },
      after: { id: row.id, published: row.published, pinned: row.pinned },
      ip: clientIp(request),
    });

    return NextResponse.json(row);
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to update announcement.") },
      { status: 500 },
    );
  }
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  if (getDialect() !== "postgres") return managedOnly();
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const adminUserId = auth.context.userId;

  const announcementId = parseId((await params).id);
  if (announcementId === null) {
    return NextResponse.json({ error: "Invalid id." }, { status: 400 });
  }

  const [row] = await db
    .delete(schema.announcements)
    .where(eq(schema.announcements.id, announcementId))
    .returning();

  if (!row) {
    return NextResponse.json({ error: "Not found." }, { status: 404 });
  }

  await logAdminAction({
    adminUserId,
    action: "announcement_deleted",
    before: { id: row.id, title: row.title },
    ip: clientIp(request),
  });

  return NextResponse.json({ ok: true });
}
