/**
 * GET /api/announcements — active announcements for the current user.
 *
 * Returns published, unexpired announcements left-joined with the caller's
 * `announcement_reads` so each row carries a `read` flag. Pinned items sort
 * first (they drive the in-app banner). Bare-JSON array (REST convention).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, desc, eq, gt, isNull, or } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";
import type { Announcement } from "@shared/types";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const rows = await db
    .select({
      id: schema.announcements.id,
      title: schema.announcements.title,
      body: schema.announcements.body,
      category: schema.announcements.category,
      severity: schema.announcements.severity,
      pinned: schema.announcements.pinned,
      publishedAt: schema.announcements.publishedAt,
      expiresAt: schema.announcements.expiresAt,
      createdAt: schema.announcements.createdAt,
      readAt: schema.announcementReads.readAt,
    })
    .from(schema.announcements)
    .leftJoin(
      schema.announcementReads,
      and(
        eq(schema.announcementReads.announcementId, schema.announcements.id),
        eq(schema.announcementReads.userId, userId),
      ),
    )
    .where(
      and(
        eq(schema.announcements.published, true),
        or(
          isNull(schema.announcements.expiresAt),
          gt(schema.announcements.expiresAt, new Date()),
        ),
      ),
    )
    .orderBy(
      desc(schema.announcements.pinned),
      desc(schema.announcements.publishedAt),
      desc(schema.announcements.createdAt),
    );

  const data: Announcement[] = rows.map((r) => ({
    id: r.id,
    title: r.title,
    body: r.body,
    category: r.category,
    severity: (r.severity === "warning" ? "warning" : "info"),
    pinned: r.pinned,
    publishedAt: r.publishedAt ? new Date(r.publishedAt).toISOString() : null,
    expiresAt: r.expiresAt ? new Date(r.expiresAt).toISOString() : null,
    createdAt: new Date(r.createdAt).toISOString(),
    read: r.readAt != null,
  }));

  return NextResponse.json(data);
}
