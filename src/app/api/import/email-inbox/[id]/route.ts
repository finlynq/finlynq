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
import { parseEmailBody } from "@/lib/email-import/parse-body";

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

  const subject = decodeInbox(r.encryptionTier, dek, r.subject);
  const bodyText = decodeInbox(r.encryptionTier, dek, r.bodyText);
  const bodyHtml = decodeInbox(r.encryptionTier, dek, r.bodyHtml);

  // Re-run the (pure) body parser on the decrypted body so the Email tab can
  // show WHAT we identified + WHY a parse is low-confidence. Derived at read —
  // no stored signals column. Body emails only (attachments don't body-parse).
  let candidate: ReturnType<typeof parseEmailBody>["candidate"] | null = null;
  let signals: ReturnType<typeof parseEmailBody>["signals"] | null = null;
  if (r.sourceKind === "body") {
    const p = parseEmailBody({
      text: bodyText,
      html: bodyHtml,
      subject,
      receivedDate: r.receivedAt.toISOString().slice(0, 10),
    });
    candidate = p.candidate;
    signals = p.signals ?? null;
  }

  return NextResponse.json({
    id: r.id,
    fromAddress: decodeInbox(r.encryptionTier, dek, r.fromAddress),
    subject,
    bodyText,
    bodyHtml,
    receivedAt: r.receivedAt.toISOString(),
    action: r.action,
    sourceKind: r.sourceKind,
    parseConfidence: r.parseConfidence,
    matchedRuleId: r.matchedRuleId,
    recordedTransactionId: r.recordedTransactionId,
    candidate,
    signals,
  });
}

const patchSchema = z.union([
  z.object({
    action: z.literal("record"),
    accountId: z.number().int().positive(),
    // Category is required in category/expense mode; OPTIONAL in transfer mode
    // (FINLYNQ-189) — the record path resolves the canonical Transfer category.
    categoryId: z.number().int().positive().nullable().optional(),
    // FINLYNQ-189 — transfer destination. When set, record a TRANSFER from
    // accountId → this account instead of a categorized income/expense. v1 is
    // same-currency only; cross-currency is refused (400 transfer_currency_mismatch).
    transferDestAccountId: z.number().int().positive().nullable().optional(),
    // Optional transforms — rule mapping (when recording from a rule) and/or
    // per-email manual corrections. Applied in recordEmailInboxRow before the
    // hash/materialize (per-email overrides win; see apply-transform.ts).
    flipSign: z.boolean().optional(),
    dateSource: z.enum(["parsed", "received"]).optional(),
    payeeOverride: z.string().max(120).optional(),
    amount: z.number().optional(),
    date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    payee: z.string().max(120).optional(),
    // Recorded-currency override (ISO). Omitted ⇒ use the account currency.
    currency: z.string().regex(/^[A-Za-z]{3,4}$/).optional(),
    // "Record anyway" — bypass the strict (fuzzy) ledger-duplicate hold-back.
    force: z.boolean().optional(),
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

  // action === 'record'. Transfer mode (FINLYNQ-189) when transferDestAccountId
  // is set; else category/expense mode, which needs a category.
  const isTransfer = parsed.data.transferDestAccountId != null;
  if (!isTransfer && parsed.data.categoryId == null) {
    return NextResponse.json(
      { error: "Cannot record this email", code: "no_category" },
      { status: 400 },
    );
  }

  const result = await recordEmailInboxRow(userId, dek, id, {
    accountId: parsed.data.accountId,
    categoryId: parsed.data.categoryId ?? null,
    transferDestAccountId: parsed.data.transferDestAccountId ?? null,
    currencyOverride: parsed.data.currency,
    finalAction: "manually_recorded",
    force: parsed.data.force,
    transform: {
      flipSign: parsed.data.flipSign,
      dateSource: parsed.data.dateSource,
      payeeOverride: parsed.data.payeeOverride,
      amountOverride: parsed.data.amount,
      dateOverride: parsed.data.date,
      payeeOverridePerEmail: parsed.data.payee,
    },
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
  if (result.status === "possible_duplicate") {
    // Not recorded — the row stays needs_review. The client offers
    // "Record anyway" (re-PATCH with force:true).
    return NextResponse.json({
      ok: false,
      action: "possible_duplicate",
      duplicateOfTransactionId: result.duplicateOfTransactionId,
    });
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
