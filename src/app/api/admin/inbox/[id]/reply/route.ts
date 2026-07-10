/**
 * POST /api/admin/inbox/[id]/reply — reply to a contact-inbox email.
 *
 * Admin-only. Sends the maintainer's reply to the ORIGINAL sender
 * (row.from_address) via the app's existing email transport (Resend), so the
 * admin never has to open the Resend dashboard to respond.
 *
 * From-address: the reply is sent FROM the mailbox address the mail arrived on
 * (row.to_address, e.g. info@finlynq.com) — but ONLY when that address is on the
 * Resend-verified sending domain (derived from EMAIL_FROM); otherwise Resend
 * would 403 the send, so we fall back to the default EMAIL_FROM sender.
 * Reply-To is set to the same mailbox address so the recipient's reply threads
 * back into this inbox (once inbound receiving is wired to the app webhook).
 *
 * On a successful send the row is marked triaged (mirrors the PATCH triage
 * action). A send failure returns 502 and leaves the row untouched so the admin
 * can retry.
 */

import { NextRequest, NextResponse } from "next/server";
import { db, schema } from "@/db";
import { eq } from "drizzle-orm";
import { requireAdmin } from "@/lib/auth/require-admin";
import { sendEmail, contactReplyEmail } from "@/lib/email";
import { safeErrorMessage } from "@/lib/validate";

export const dynamic = "force-dynamic";

/** Loose RFC-ish address check — just enough to avoid handing garbage to Resend. */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** The verified sending domain, derived from EMAIL_FROM (default finlynq.com). */
function verifiedSendingDomain(): string {
  const from = process.env.EMAIL_FROM || "Finlynq <noreply@finlynq.com>";
  const m = /<([^>]+)>/.exec(from);
  const addr = (m ? m[1] : from).trim();
  const domain = addr.split("@")[1];
  return (domain || "finlynq.com").toLowerCase();
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  const auth = await requireAdmin(request);
  if (!auth.authenticated) return auth.response;
  const { id } = await params;
  const { userId } = auth.context;

  const parsed = (await request.json().catch(() => ({}))) as { body?: unknown };
  const replyBody = typeof parsed.body === "string" ? parsed.body.trim() : "";
  if (!replyBody) {
    return NextResponse.json({ error: "Reply body is required" }, { status: 400 });
  }
  if (replyBody.length > 50_000) {
    return NextResponse.json({ error: "Reply is too long" }, { status: 400 });
  }

  const row = await db
    .select()
    .from(schema.incomingEmails)
    .where(eq(schema.incomingEmails.id, id))
    .get();

  if (!row) {
    return NextResponse.json({ error: "Not found" }, { status: 404 });
  }

  const recipient = (row.fromAddress || "").trim();
  if (!EMAIL_RE.test(recipient)) {
    return NextResponse.json(
      { error: "This email has no valid reply address" },
      { status: 422 },
    );
  }

  // Send FROM the mailbox address only if it's on the verified domain.
  const mailbox = (row.toAddress || "").trim().toLowerCase();
  const onVerifiedDomain =
    EMAIL_RE.test(mailbox) && mailbox.endsWith(`@${verifiedSendingDomain()}`);
  const from = onVerifiedDomain
    ? `Finlynq <${mailbox}>`
    : process.env.EMAIL_FROM || "Finlynq <noreply@finlynq.com>";
  const replyTo = onVerifiedDomain ? mailbox : undefined;

  const baseSubject = row.subject?.trim() || "(no subject)";
  const subject = /^re:/i.test(baseSubject) ? baseSubject : `Re: ${baseSubject}`;

  try {
    await sendEmail(
      contactReplyEmail({
        to: recipient,
        from,
        replyTo,
        subject,
        replyBody,
        original: {
          fromAddress: recipient,
          receivedAt: row.receivedAt ? String(row.receivedAt) : null,
          bodyText: row.bodyText,
        },
      }),
    );
  } catch (e) {
    console.error("[admin-inbox-reply] send failed", e);
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to send reply") },
      { status: 502 },
    );
  }

  // Mark triaged on a successful send (admin has handled it).
  await db
    .update(schema.incomingEmails)
    .set({ triagedAt: new Date(), triagedBy: userId })
    .where(eq(schema.incomingEmails.id, id));

  return NextResponse.json({ ok: true, sentTo: recipient, from });
}
