/**
 * GET /api/import/staged
 *
 * List the current user's pending staged imports — both email-delivered
 * rows and upload-staged rows — awaiting review at /import/pending.
 *
 * Query params:
 *   ?count=1  → return only `{ pending: number }` for lightweight nav badge polling
 *
 * Otherwise returns an array of:
 *   { id, source, fromAddress, subject, receivedAt, totalRowCount,
 *     duplicateCount, expiresAt, originalFilename, fileFormat }
 *
 * `source` is 'email' or 'upload'. Email rows populate fromAddress + subject;
 * upload rows populate originalFilename + fileFormat (issue #153).
 *
 * Rows are user-scoped via userId filter. Expired rows (expires_at < now)
 * are filtered out in case the cleanup cron hasn't run yet.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { and, desc, eq, gt, sql } from "drizzle-orm";
import { requireAuth } from "@/lib/auth/require-auth";

export const dynamic = "force-dynamic";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  const countOnly = request.nextUrl.searchParams.get("count") === "1";
  const now = new Date();

  if (countOnly) {
    const row = await db
      .select({ c: sql<number>`count(*)::int` })
      .from(schema.stagedImports)
      .where(and(
        eq(schema.stagedImports.userId, userId),
        eq(schema.stagedImports.status, "pending"),
        gt(schema.stagedImports.expiresAt, now),
      ))
      .get();
    return NextResponse.json({ pending: row?.c ?? 0 });
  }

  const rows = await db
    .select({
      id: schema.stagedImports.id,
      source: schema.stagedImports.source,
      fromAddress: schema.stagedImports.fromAddress,
      subject: schema.stagedImports.subject,
      receivedAt: schema.stagedImports.receivedAt,
      totalRowCount: schema.stagedImports.totalRowCount,
      duplicateCount: schema.stagedImports.duplicateCount,
      expiresAt: schema.stagedImports.expiresAt,
      // Issue #153: upload-source rows surface filename + format on the list
      // so the review UI can show "{filename} · CSV" instead of an empty
      // "(no subject)" + "from (unknown)".
      originalFilename: schema.stagedImports.originalFilename,
      fileFormat: schema.stagedImports.fileFormat,
    })
    .from(schema.stagedImports)
    .where(and(
      eq(schema.stagedImports.userId, userId),
      eq(schema.stagedImports.status, "pending"),
      gt(schema.stagedImports.expiresAt, now),
    ))
    .orderBy(desc(schema.stagedImports.receivedAt))
    .all();

  return NextResponse.json(rows);
}
