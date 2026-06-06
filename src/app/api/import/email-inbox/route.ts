/**
 * GET /api/import/email-inbox — the per-user Email tab list (Epic C1).
 *
 * Awaits the DEK-bearing sweep first so opening the tab auto-records any body
 * emails that match a user rule, then returns the (decrypted) inbox rows newest
 * first. requireEncryption — reads encrypted columns.
 *
 * Response: bare JSON array of EmailInboxItem (the REST envelope is MCP-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, desc, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  processPendingInboxEmails,
  decodeInbox,
  decodeStaged,
} from "@/lib/email-import/process-pending-inbox";

export const dynamic = "force-dynamic";

const LIST_LIMIT = 200;

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;

  // Self-heal on tab load (the documented pattern). Best-effort — a sweep
  // failure must never blank the list.
  try {
    await processPendingInboxEmails(userId, dek);
  } catch (e) {
    console.warn("[email-inbox] sweep failed on list", e);
  }

  const rows = await db
    .select({
      id: schema.emailInbox.id,
      fromAddress: schema.emailInbox.fromAddress,
      subject: schema.emailInbox.subject,
      encryptionTier: schema.emailInbox.encryptionTier,
      receivedAt: schema.emailInbox.receivedAt,
      action: schema.emailInbox.action,
      sourceKind: schema.emailInbox.sourceKind,
      parseConfidence: schema.emailInbox.parseConfidence,
      matchedRuleId: schema.emailInbox.matchedRuleId,
      recordedTransactionId: schema.emailInbox.recordedTransactionId,
      stagedImportId: schema.emailInbox.stagedImportId,
    })
    .from(schema.emailInbox)
    .where(eq(schema.emailInbox.userId, userId))
    .orderBy(desc(schema.emailInbox.receivedAt))
    .limit(LIST_LIMIT)
    .all();

  // Batch-load body candidates so the UI can preview what would be recorded.
  const stagedIds = rows
    .filter((r) => r.sourceKind === "body" && r.stagedImportId)
    .map((r) => r.stagedImportId as string);
  const candByStaged = new Map<
    string,
    { date: string; amount: number; currency: string; payee: string }
  >();
  if (stagedIds.length > 0) {
    const cands = await db
      .select({
        stagedImportId: schema.stagedTransactions.stagedImportId,
        date: schema.stagedTransactions.date,
        amount: schema.stagedTransactions.amount,
        currency: schema.stagedTransactions.currency,
        payee: schema.stagedTransactions.payee,
        encryptionTier: schema.stagedTransactions.encryptionTier,
      })
      .from(schema.stagedTransactions)
      .where(inArray(schema.stagedTransactions.stagedImportId, stagedIds))
      .all();
    for (const c of cands) {
      if (candByStaged.has(c.stagedImportId)) continue; // 1 candidate per body email
      candByStaged.set(c.stagedImportId, {
        date: c.date,
        amount: c.amount,
        currency: (c.currency ?? "USD").toUpperCase(),
        payee: decodeStaged(c.encryptionTier, dek, c.payee) ?? "",
      });
    }
  }

  const items = rows.map((r) => ({
    id: r.id,
    fromAddress: decodeInbox(r.encryptionTier, dek, r.fromAddress),
    subject: decodeInbox(r.encryptionTier, dek, r.subject),
    receivedAt: r.receivedAt.toISOString(),
    action: r.action,
    sourceKind: r.sourceKind as "attachment" | "body",
    parseConfidence: r.parseConfidence as "high" | "low" | null,
    matchedRuleId: r.matchedRuleId,
    recordedTransactionId: r.recordedTransactionId,
    stagedImportId: r.stagedImportId,
    candidate:
      r.sourceKind === "body" && r.stagedImportId
        ? candByStaged.get(r.stagedImportId) ?? null
        : null,
  }));

  return NextResponse.json(items);
}
