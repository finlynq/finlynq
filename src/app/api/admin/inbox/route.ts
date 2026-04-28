/**
 * GET /api/admin/inbox
 *
 * List incoming_emails rows for admin triage. Admin-only.
 *
 * Query params:
 *   ?category=mailbox|trash  (default: both)
 *   ?count=1                 → return `{ mailbox: number, trash: number }` for nav badge
 *
 * Otherwise returns full rows minus body_html (which can be large; fetched
 * separately via /api/admin/inbox/[id] for the sandboxed preview).
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, desc, eq, gt, isNull, or, sql } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const countOnly = request.nextUrl.searchParams.get("count") === "1";
  const category = request.nextUrl.searchParams.get("category");
  const now = new Date();

  // Mailbox rows never expire (expires_at IS NULL). Trash rows with
  // expires_at in the past are stale (cleanup cron hasn't run yet) — filter.
  const notExpired = or(
    isNull(schema.incomingEmails.expiresAt),
    gt(schema.incomingEmails.expiresAt, now),
  );

  if (countOnly) {
    const rows = await db
      .select({
        category: schema.incomingEmails.category,
        c: sql<number>`count(*)::int`,
      })
      .from(schema.incomingEmails)
      .where(and(notExpired, isNull(schema.incomingEmails.triagedAt)))
      .groupBy(schema.incomingEmails.category)
      .all();
    const out = { mailbox: 0, trash: 0 };
    for (const r of rows) {
      if (r.category === "mailbox") out.mailbox = r.c;
      else if (r.category === "trash") out.trash = r.c;
    }
    return NextResponse.json(out);
  }

  const conds = [notExpired];
  if (category === "mailbox" || category === "trash") {
    conds.push(eq(schema.incomingEmails.category, category));
  }

  const rows = await db
    .select({
      id: schema.incomingEmails.id,
      category: schema.incomingEmails.category,
      toAddress: schema.incomingEmails.toAddress,
      fromAddress: schema.incomingEmails.fromAddress,
      subject: schema.incomingEmails.subject,
      bodyText: schema.incomingEmails.bodyText,
      attachmentCount: schema.incomingEmails.attachmentCount,
      receivedAt: schema.incomingEmails.receivedAt,
      expiresAt: schema.incomingEmails.expiresAt,
      triagedAt: schema.incomingEmails.triagedAt,
    })
    .from(schema.incomingEmails)
    .where(and(...conds))
    .orderBy(desc(schema.incomingEmails.receivedAt))
    .limit(200)
    .all();

  return NextResponse.json(rows);
}
