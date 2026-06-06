/**
 * Shared inbound-email ingest (Epic B4 / A4).
 *
 * The per-recipient routing + staging + email_inbox write, extracted from the
 * webhook route so BOTH the webhook AND the poll-backstop cron run the exact
 * same path. Idempotent on the per-recipient dedupe key, so the webhook and a
 * later poll of the same (still-undeleted) Mailpit message never double-record.
 *
 * `ingestInboundEmail` does NOT delete the provider message — the caller does
 * that after a successful return (the webhook returns 200 then deletes; the
 * cron deletes per message). It THROWS on an import-path failure so the webhook
 * can return 500 (Resend retries / Mailpit keeps the message for the next poll).
 */

import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { checkRateLimit } from "@/lib/rate-limit";
import { routeAddress } from "./address-router";
import { parseResendAttachments } from "./parse-attachments";
import { stageEmailImport } from "./stage-email-import";
import { storeIncomingEmail, notifyAdminsOfIncoming } from "./store-incoming-email";
import { sendBounceIfAuthenticated } from "./bounce";
import { parseEmailBody } from "./parse-body";
import { storeEmailInbox, type EmailInboxAction } from "./store-email-inbox";
import type { RawTransaction } from "@/lib/import-pipeline";
import type { InboundEmailProvider, ParsedInboundEmail } from "./providers";

// 25 emails/hour/recipient address.
const INBOUND_RATE_MAX = 25;
const INBOUND_RATE_WINDOW_MS = 60 * 60 * 1000;

export interface IngestRouteResult {
  to: string;
  category: string;
  note?: string;
}

/** Enrich body + attachment bytes the webhook summary omitted ("payload wins,
 *  else fetched"). Never throws — degrades to what the payload carried. */
export async function enrichInbound(
  provider: InboundEmailProvider,
  parsed: ParsedInboundEmail,
): Promise<{ text: string | null; html: string | null; attachments: ParsedInboundEmail["attachments"] }> {
  let text = parsed.text;
  let html = parsed.html;
  let attachments = parsed.attachments;
  const messageId = parsed.providerMessageId;
  if (messageId && (attachments.length === 0 || (text == null && html == null))) {
    try {
      const content = await provider.fetchContent(messageId);
      if (text == null) text = content.text;
      if (html == null) html = content.html;
      if (attachments.length === 0) attachments = content.attachments;
    } catch (e) {
      console.warn("[email-ingest] fetchContent failed", e);
    }
  }
  return { text, html, attachments };
}

/**
 * Route + ingest one inbound email across all its recipients. Throws on an
 * import-path failure (the caller maps to 500 / leaves the message for retry).
 */
export async function ingestInboundEmail(
  provider: InboundEmailProvider,
  parsed: ParsedInboundEmail,
  opts: { svixId: string | null; receivedDate: string },
): Promise<IngestRouteResult[]> {
  const { text, html, attachments } = await enrichInbound(provider, parsed);
  const messageId = parsed.providerMessageId;
  const results: IngestRouteResult[] = [];

  for (const to of parsed.to) {
    const rl = checkRateLimit(
      `email-inbound:${to.toLowerCase()}`,
      INBOUND_RATE_MAX,
      INBOUND_RATE_WINDOW_MS,
    );
    if (!rl.allowed) {
      results.push({ to, category: "rate-limited" });
      continue;
    }

    const route = await routeAddress(to);

    if (route.category === "import" && route.userId) {
      const note = await ingestImportEmail({
        userId: route.userId,
        address: route.address,
        parsed,
        messageId,
        svixId: opts.svixId,
        text,
        html,
        attachments,
        receivedDate: opts.receivedDate,
      });
      results.push({ to: route.address, category: "import", note });
    } else if (route.category === "discard") {
      // Import-shaped but no user in this env (expired/rotated token or spam to
      // a guessed address the relay forwarded). Write NOTHING and report a 2xx
      // so the DevManager relay deletes the Mailpit copy. Idempotent: a re-push
      // of the same message_id just discards again (no row, no-op). No bounce,
      // no admin notify.
      results.push({ to: route.address, category: "discard" });
    } else {
      await storeIncomingEmail({
        category: route.category as "mailbox" | "trash",
        toAddress: route.address,
        fromAddress: parsed.from,
        subject: parsed.subject,
        bodyText: text,
        bodyHtml: html,
        attachmentCount: attachments.length,
        svixId: opts.svixId,
      });
      await notifyAdminsOfIncoming(
        route.category as "mailbox" | "trash",
        route.address,
      );
      if (route.category === "trash") {
        sendBounceIfAuthenticated({
          toAddress: route.address,
          fromAddress: parsed.from,
          subject: parsed.subject,
          authVerdict: parsed.authVerdict ?? {},
        }).catch((e) => console.warn("[email-ingest] bounce failed", e));
      }
      results.push({ to: route.address, category: route.category });
    }
  }

  return results;
}

/**
 * Ingest one import-addressed email for one recipient: attachments → staging,
 * else heuristic body parse → 1-row staging, ALWAYS an `email_inbox` row.
 * Idempotent on the per-recipient dedupe key.
 */
async function ingestImportEmail(args: {
  userId: string;
  address: string;
  parsed: ParsedInboundEmail;
  messageId: string | null;
  svixId: string | null;
  text: string | null;
  html: string | null;
  attachments: ParsedInboundEmail["attachments"];
  receivedDate: string;
}): Promise<string> {
  const { userId, address, parsed, messageId, svixId, text, html, attachments, receivedDate } = args;

  const dedupeKey = `${messageId ?? svixId ?? "noid"}:${address}`;

  const pre = await db
    .select({ id: schema.emailInbox.id })
    .from(schema.emailInbox)
    .where(eq(schema.emailInbox.dedupeKey, dedupeKey))
    .limit(1);
  if (pre[0]?.id) return "duplicate";

  let sourceKind: "attachment" | "body";
  let action: EmailInboxAction;
  let stagedImportId: string | null = null;
  let parseConfidence: "high" | "low" | null = null;
  let totalRowCount = 0;

  const { rows, csvFallbackMeta } = await parseResendAttachments(attachments, userId);
  if (rows.length > 0) {
    sourceKind = "attachment";
    action = "needs_review";
    const stageResult = await stageEmailImport({
      userId,
      rows,
      source: "email",
      fromAddress: parsed.from,
      subject: parsed.subject,
      svixId,
      headers: csvFallbackMeta?.headers ?? null,
      sampleRows: csvFallbackMeta?.sampleRows ?? null,
    });
    stagedImportId = stageResult.stagedImportId;
    totalRowCount = stageResult.totalRowCount;
  } else {
    sourceKind = "body";
    const body = parseEmailBody({ text, html, subject: parsed.subject, receivedDate });
    if (body.candidate && body.confidence != null) {
      action = "needs_review";
      parseConfidence = body.confidence;
      const raw: RawTransaction = {
        date: body.candidate.date,
        account: "",
        amount: body.candidate.amount,
        payee: body.candidate.payee,
        currency: body.candidate.currency,
        note: body.candidate.note,
      };
      const stageResult = await stageEmailImport({
        userId,
        rows: [raw],
        source: "email",
        fromAddress: parsed.from,
        subject: parsed.subject,
        svixId,
      });
      stagedImportId = stageResult.stagedImportId;
      totalRowCount = stageResult.totalRowCount;
    } else {
      action = "unparseable";
    }
  }

  const stored = await storeEmailInbox({
    userId,
    dedupeKey,
    messageId,
    fromAddress: parsed.from,
    subject: parsed.subject,
    bodyText: text,
    bodyHtml: html,
    sourceKind,
    action,
    stagedImportId,
    parseConfidence,
  });

  if (!stored.alreadyExisted && action !== "unparseable") {
    await db.insert(schema.notifications).values({
      type: "import",
      title: "New email import pending",
      message:
        sourceKind === "attachment"
          ? `${totalRowCount} transaction(s) from ${parsed.from} waiting at /import?tab=email`
          : `A transaction from ${parsed.from} is waiting to be recorded at /import?tab=email`,
      read: 0,
      createdAt: new Date().toISOString(),
      userId,
    });
  }

  return action;
}
