/**
 * /api/import/email-inbox/[id] (Epic C1).
 *
 *   GET    — decrypted detail (from/subject/body) for the sandboxed-iframe view.
 *   PATCH  — { action: 'record', accountId, categoryId } → materialize a
 *            deduped transaction (manually_recorded), or { action: 'discard' }.
 *   DELETE — local delete (+ provider.deleteReceived, a no-op now: the
 *            DevManager relay already deleted the Mailpit copy on the ingest 2xx;
 *            Resend has no delete API).
 *
 * All requireEncryption. Cross-tenant access → 404 (never 403). Bare JSON
 * responses (the REST envelope is MCP-only).
 */

import { NextRequest, NextResponse } from "next/server";
import { and, eq } from "drizzle-orm";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody } from "@/lib/validate";
import {
  recordEmailInboxRow,
  discardEmailInboxRow,
  decodeInbox,
} from "@/lib/email-import/process-pending-inbox";
import { getInboundProvider } from "@/lib/email-import/providers";

export const dynamic = "force-dynamic";

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  const rows = await db
    .select({
      id: schema.emailInbox.id,
      fromAddress: schema.emailInbox.fromAddress,
      subject: schema.emailInbox.subject,
      bodyText: schema.emailInbox.bodyText,
      bodyHtml: schema.emailInbox.bodyHtml,
      encryptionTier: schema.emailInbox.encryptionTier,
      receivedAt: schema.emailInbox.receivedAt,
      action: schema.emailInbox.action,
      sourceKind: schema.emailInbox.sourceKind,
      parseConfidence: schema.emailInbox.parseConfidence,
      matchedRuleId: schema.emailInbox.matchedRuleId,
      recordedTransactionId: schema.emailInbox.recordedTransactionId,
    })
    .from(schema.emailInbox)
    .where(and(eq(schema.emailInbox.id, id), eq(schema.emailInbox.userId, userId)))
    .limit(1);
  const r = rows[0];
  if (!r) return NextResponse.json({ error: "Not found" }, { status: 404 });

  return NextResponse.json({
    id: r.id,
    fromAddress: decodeInbox(r.encryptionTier, dek, r.fromAddress),
    subject: decodeInbox(r.encryptionTier, dek, r.subject),
    bodyText: decodeInbox(r.encryptionTier, dek, r.bodyText),
    bodyHtml: decodeInbox(r.encryptionTier, dek, r.bodyHtml),
    receivedAt: r.receivedAt.toISOString(),
    action: r.action,
    sourceKind: r.sourceKind,
    parseConfidence: r.parseConfidence,
    matchedRuleId: r.matchedRuleId,
    recordedTransactionId: r.recordedTransactionId,
  });
}

const patchSchema = z.union([
  z.object({
    action: z.literal("record"),
    accountId: z.number().int().positive(),
    categoryId: z.number().int().positive(),
  }),
  z.object({ action: z.literal("discard") }),
]);

export async function PATCH(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId, dek } = auth;
  const { id } = await params;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, patchSchema);
  if (parsed.error) return parsed.error;

  if (parsed.data.action === "discard") {
    const ok = await discardEmailInboxRow(userId, id);
    if (!ok) return NextResponse.json({ error: "Not found" }, { status: 404 });
    return NextResponse.json({ ok: true, action: "discarded" });
  }

  // action === 'record'
  const result = await recordEmailInboxRow(userId, dek, id, {
    accountId: parsed.data.accountId,
    categoryId: parsed.data.categoryId,
    finalAction: "manually_recorded",
  });
  if (result.status === "not_found") {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }
  if (result.status === "invalid") {
    return NextResponse.json(
      { error: "Cannot record this email", code: result.reason },
      { status: 400 },
    );
  }
  if (result.status === "duplicate") {
    return NextResponse.json({ ok: true, action: "duplicate_skipped" });
  }
  return NextResponse.json({
    ok: true,
    action: "manually_recorded",
    transactionId: result.transactionId,
  });
}

export async function DELETE(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;
  const { id } = await params;

  const rows = await db
    .select({
      id: schema.emailInbox.id,
      messageId: schema.emailInbox.messageId,
    })
    .from(schema.emailInbox)
    .where(and(eq(schema.emailInbox.id, id), eq(schema.emailInbox.userId, userId)))
    .limit(1);
  if (!rows[0]) return NextResponse.json({ error: "Not found" }, { status: 404 });

  await db.delete(schema.emailInbox).where(eq(schema.emailInbox.id, id));

  // Provider delete. No-op for both providers today (the DevManager relay
  // already removed the Mailpit copy at ingest; Resend has no delete API), but
  // kept best-effort so a future provider with a real delete still gets called.
  if (rows[0].messageId) {
    await getInboundProvider()
      .deleteReceived(rows[0].messageId)
      .catch((e) => console.warn("[email-inbox] provider delete failed", e));
  }

  return NextResponse.json({ ok: true });
}
