/**
 * Admin announcements API.
 *
 *  GET  /api/admin/announcements — list ALL announcements (incl. drafts).
 *  POST /api/admin/announcements — create a new announcement.
 *
 * Gated by requireAdmin + the managed-mode (postgres) guard. Mutations are
 * audit-logged via logAdminAction. Announcement content is plaintext by
 * design (operator broadcast content, not per-user data) — see schema-pg.ts.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema, getDialect } from "@/db";
import { desc } from "drizzle-orm";
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

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") return managedOnly();
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const rows = await db
    .select()
    .from(schema.announcements)
    .orderBy(desc(schema.announcements.createdAt));

  return NextResponse.json(rows);
}

const createSchema = z.object({
  title: z.string().min(1).max(200),
  body: z.string().min(1).max(10000),
  category: z.enum(["news", "update", "maintenance"]).optional(),
  severity: z.enum(["info", "warning"]).optional(),
  pinned: z.boolean().optional(),
  published: z.boolean().optional(),
  // ISO timestamp or null. Parsed defensively below.
  expiresAt: z.string().nullable().optional(),
});

export async function POST(request: NextRequest) {
  if (getDialect() !== "postgres") return managedOnly();
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const adminUserId = auth.context.userId;

  try {
    const body = await request.json();
    const parsed = validateBody(body, createSchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;

    let expiresAt: Date | null = null;
    if (d.expiresAt) {
      const dt = new Date(d.expiresAt);
      if (Number.isNaN(dt.getTime())) {
        return NextResponse.json({ error: "Invalid expiresAt." }, { status: 400 });
      }
      expiresAt = dt;
    }

    const published = d.published ?? false;
    const [row] = await db
      .insert(schema.announcements)
      .values({
        title: d.title,
        body: d.body,
        category: d.category ?? "news",
        severity: d.severity ?? "info",
        pinned: d.pinned ?? false,
        published,
        publishedAt: published ? new Date() : null,
        expiresAt,
        createdBy: adminUserId,
      })
      .returning();

    await logAdminAction({
      adminUserId,
      action: "announcement_created",
      after: { id: row.id, title: row.title, published: row.published },
      ip: clientIp(request),
    });

    return NextResponse.json(row, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to create announcement.") },
      { status: 500 },
    );
  }
}
