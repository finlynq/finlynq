/**
 * GET /api/admin/email-inbox — cross-user operator oversight of email_inbox
 * (FINLYNQ-121). The cross-user counterpart to the per-user Email tab
 * (`/import?tab=email`, Epic C1) and a sibling of `/admin/inbox` (which covers
 * `incoming_emails`). Admin-only + managed-mode guarded, mirroring
 * `/admin/feedback`.
 *
 * ⚠️ LOAD-BEARING ENCRYPTION CONSTRAINT
 * `email_inbox.from_address` / `subject` / `body_text` are TWO-TIER encrypted:
 *   - `service` tier (`sv1:`, PF_STAGING_KEY) before the owner's next login —
 *     OPERATOR-decryptable (we hold the staging key on the server).
 *   - `user` tier (`v1:`, the owner's DEK) after the login sweep upgrades the
 *     row — an admin CANNOT decrypt these (same property as the feedback
 *     channel: an admin can never read user-DEK data).
 * So this endpoint is METADATA-FIRST: it ALWAYS returns action / source_kind /
 * parse_confidence / encryption_tier / received_at / message_id / matched_rule_id
 * / recorded_transaction_id / owning user. A decrypted from/subject PREVIEW is
 * returned ONLY for `service`-tier rows (operator key); `user`-tier from/subject
 * stay null (REDACTED) and the row carries `redacted: true`. body_text is NEVER
 * returned (no admin body-preview surface).
 *
 * Query params (all optional):
 *   ?userId=<uuid>        filter to one owning user
 *   ?action=<lifecycle>   pending|auto_recorded|duplicate_skipped|needs_review|
 *                         unparseable|discarded|manually_recorded
 *   ?sourceKind=body|attachment
 *   ?since=YYYY-MM-DD     received_at >= this date (inclusive)
 *   ?until=YYYY-MM-DD     received_at <  next day (inclusive of the day)
 *   ?limit=50 (max 100)   &offset=0
 *
 * Response: { rows, byUser, limit, offset, total } — bare JSON (admin screens
 * read bare shapes). `byUser` is the per-user grouped counts (total /
 * needs_review backlog / unparseable) over ALL rows matching the non-user
 * filters, independent of pagination.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema, getDialect } from "@/db";
import { and, desc, eq, gte, lt, sql, type SQL } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { decryptStaged } from "@/lib/crypto/staging-envelope";

export const dynamic = "force-dynamic";

const ACTIONS = new Set([
  "pending",
  "auto_recorded",
  "duplicate_skipped",
  "needs_review",
  "unparseable",
  "discarded",
  "manually_recorded",
]);

/**
 * Operator-key decode for the admin preview. Service-tier rows are decryptable
 * with PF_STAGING_KEY (which the server holds); user-tier rows are encrypted
 * with the owner's DEK, which the admin does NOT have — those stay redacted.
 * Never leaks ciphertext: a decrypt miss degrades to null.
 */
function adminPreview(tier: string | null, value: string | null): string | null {
  if (value == null || value === "") return null;
  if ((tier ?? "service") !== "service") return null; // user-tier ⇒ redacted
  try {
    return decryptStaged(value);
  } catch {
    return null; // never leak ciphertext on a decrypt miss
  }
}

function parseDay(v: string | null): Date | null {
  if (!v || !/^\d{4}-\d{2}-\d{2}$/.test(v)) return null;
  const d = new Date(`${v}T00:00:00.000Z`);
  return Number.isNaN(d.getTime()) ? null : d;
}

export async function GET(request: NextRequest) {
  if (getDialect() !== "postgres") {
    return NextResponse.json(
      { error: "Admin features are only available in managed mode." },
      { status: 403 },
    );
  }
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;

  const url = new URL(request.url);
  const userIdParam = url.searchParams.get("userId");
  const actionParam = url.searchParams.get("action");
  const sourceKindParam = url.searchParams.get("sourceKind");
  const since = parseDay(url.searchParams.get("since"));
  const until = parseDay(url.searchParams.get("until"));
  const limit = Math.min(Number(url.searchParams.get("limit")) || 50, 100);
  const offset = Math.max(Number(url.searchParams.get("offset")) || 0, 0);

  // Filters that apply to BOTH the paginated rows and the per-user grouping.
  // The userId filter is row-only (the grouping is the cross-user pivot).
  const sharedConds: SQL[] = [];
  if (actionParam && ACTIONS.has(actionParam)) {
    sharedConds.push(eq(schema.emailInbox.action, actionParam));
  }
  if (sourceKindParam === "body" || sourceKindParam === "attachment") {
    sharedConds.push(eq(schema.emailInbox.sourceKind, sourceKindParam));
  }
  if (since) sharedConds.push(gte(schema.emailInbox.receivedAt, since));
  if (until) {
    const next = new Date(until.getTime() + 24 * 60 * 60 * 1000);
    sharedConds.push(lt(schema.emailInbox.receivedAt, next));
  }

  const rowConds = [...sharedConds];
  if (userIdParam) rowConds.push(eq(schema.emailInbox.userId, userIdParam));

  // ─── Per-user grouped counts (independent of pagination + userId filter) ───
  const grouped = await db
    .select({
      userId: schema.emailInbox.userId,
      username: schema.users.username,
      email: schema.users.email,
      total: sql<number>`count(*)::int`,
      needsReview: sql<number>`count(*) filter (where ${schema.emailInbox.action} = 'needs_review')::int`,
      unparseable: sql<number>`count(*) filter (where ${schema.emailInbox.action} = 'unparseable')::int`,
    })
    .from(schema.emailInbox)
    .leftJoin(schema.users, eq(schema.users.id, schema.emailInbox.userId))
    .where(sharedConds.length ? and(...sharedConds) : undefined)
    .groupBy(schema.emailInbox.userId, schema.users.username, schema.users.email)
    .orderBy(desc(sql`count(*)`));

  const byUser = grouped.map((g) => ({
    userId: g.userId,
    username: g.username,
    email: g.email,
    total: g.total,
    needsReview: g.needsReview,
    unparseable: g.unparseable,
    // Unparseable rate as a 0..1 fraction; null-safe on an empty group.
    unparseableRate: g.total > 0 ? g.unparseable / g.total : 0,
  }));
  const total = byUser.reduce((s, g) => s + g.total, 0);

  // ─── Paginated rows (metadata + service-tier preview) ──────────────────────
  const raw = await db
    .select({
      id: schema.emailInbox.id,
      userId: schema.emailInbox.userId,
      username: schema.users.username,
      email: schema.users.email,
      fromAddress: schema.emailInbox.fromAddress,
      subject: schema.emailInbox.subject,
      encryptionTier: schema.emailInbox.encryptionTier,
      action: schema.emailInbox.action,
      sourceKind: schema.emailInbox.sourceKind,
      parseConfidence: schema.emailInbox.parseConfidence,
      receivedAt: schema.emailInbox.receivedAt,
      messageId: schema.emailInbox.messageId,
      matchedRuleId: schema.emailInbox.matchedRuleId,
      recordedTransactionId: schema.emailInbox.recordedTransactionId,
    })
    .from(schema.emailInbox)
    .leftJoin(schema.users, eq(schema.users.id, schema.emailInbox.userId))
    .where(rowConds.length ? and(...rowConds) : undefined)
    .orderBy(desc(schema.emailInbox.receivedAt))
    .limit(limit)
    .offset(offset);

  const rows = raw.map((r) => {
    const isService = (r.encryptionTier ?? "service") === "service";
    return {
      id: r.id,
      userId: r.userId,
      username: r.username,
      email: r.email,
      encryptionTier: r.encryptionTier,
      // Preview ONLY for service-tier rows (operator key). user-tier ⇒ null.
      fromAddress: adminPreview(r.encryptionTier, r.fromAddress),
      subject: adminPreview(r.encryptionTier, r.subject),
      // True when content exists but the admin cannot read it (user-DEK). The UI
      // shows a "🔒 user-encrypted" placeholder rather than empty cells.
      redacted: !isService && (!!r.fromAddress || !!r.subject),
      action: r.action,
      sourceKind: r.sourceKind,
      parseConfidence: r.parseConfidence,
      receivedAt: r.receivedAt.toISOString(),
      messageId: r.messageId,
      matchedRuleId: r.matchedRuleId,
      recordedTransactionId: r.recordedTransactionId,
    };
  });

  return NextResponse.json({ rows, byUser, total, limit, offset });
}
