/**
 * Inbound-email provider abstraction (Epic B1, 2026-06-05).
 *
 * Lifts the inline Resend logic in /api/import/email-webhook behind a single
 * interface so the same route can ingest from EITHER Resend (legacy, svix-
 * signed JSON) OR our self-hosted pipeline via the DevManager push relay (new,
 * HMAC-signed self-contained JSON). Selected at runtime by
 * INBOUND_EMAIL_PROVIDER.
 *
 * The webhook payloads differ in what they inline:
 *   - Resend inlines body text/html but NOT attachment bytes, so `fetchContent`
 *     fills the attachment gap via the Resend REST API.
 *   - self-smtp (DevManager push) inlines EVERYTHING — body + attachments
 *     (base64) — so `fetchContent` is a no-op for it.
 * The route merges payload + fetched content with a uniform "payload wins, else
 * fetched" rule, so a provider that inlines everything just never needs a fetch.
 */

import type { NextRequest } from "next/server";
import type { ResendAttachment } from "../parse-attachments";

export interface InboundAuthVerdict {
  spf?: string | null;
  dkim?: string | null;
  dmarc?: string | null;
}

/** Normalized inbound email, provider-agnostic. */
export interface ParsedInboundEmail {
  /** Provider message id — Resend received-email id OR the DevManager push
   *  payload's `message_id` (the underlying Mailpit id). Used for Resend
   *  attachment fetch-back and as the idempotency / dedupe key. */
  providerMessageId: string | null;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: ResendAttachment[];
  /** Resend exposes SPF/DKIM/DMARC verdicts; the DevManager relay does not pass
   *  them through (undefined) — it runs its own best-effort SPF upstream. */
  authVerdict?: InboundAuthVerdict;
}

/** Body + attachment bytes the webhook summary omitted. */
export interface InboundContent {
  text: string | null;
  html: string | null;
  attachments: ResendAttachment[];
}

export type AuthResult = { ok: true } | { ok: false; status: number };

export interface InboundEmailProvider {
  readonly name: "resend" | "self-smtp";
  /** Verify the webhook is authentic. Resend → svix signature; self-smtp →
   *  HMAC-SHA256 (X-Mail-Signature) from the DevManager push relay. */
  verifyAuth(request: NextRequest, rawBody: string): Promise<AuthResult>;
  /** Parse the (already-verified) raw JSON body into a normalized email.
   *  Returns null when the shape is unrecognizable. */
  parsePayload(rawBody: string): ParsedInboundEmail | null;
  /** Fetch body + attachment bytes the payload omitted. Resend → fetches
   *  attachment bytes; self-smtp → no-op (push payload is self-contained).
   *  Degrades to empty on any failure (warn-logged) so a fetch miss never
   *  5xx's the webhook. */
  fetchContent(messageId: string): Promise<InboundContent>;
  /** Delete the message from the provider after durable store. No-op for BOTH:
   *  Resend has no delete-received API; self-smtp's DevManager relay owns the
   *  Mailpit delete on our 2xx. */
  deleteReceived(messageId: string): Promise<void>;
}
