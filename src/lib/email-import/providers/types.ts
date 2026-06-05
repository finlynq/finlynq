/**
 * Inbound-email provider abstraction (Epic B1, 2026-06-05).
 *
 * Lifts the inline Resend logic in /api/import/email-webhook behind a single
 * interface so the same route can ingest from EITHER Resend (legacy, svix-
 * signed JSON, no delete API) OR our self-hosted Mailpit (new, basic-auth'd
 * JSON summary, full fetch + delete). Selected at runtime by
 * INBOUND_EMAIL_PROVIDER.
 *
 * The webhook payloads differ in what they inline:
 *   - Resend inlines body text/html but NOT attachment bytes.
 *   - Mailpit inlines NEITHER (the webhook is a message *summary*).
 * So `parsePayload` returns whatever the summary carries and `fetchContent`
 * fills the gaps via the provider's REST API. The route merges them with a
 * uniform "payload wins, else fetched" rule.
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
  /** Provider message id — Resend received-email id OR Mailpit message ID.
   *  Used for fetch-back, the deleteReceived contract, and idempotency. */
  providerMessageId: string | null;
  from: string;
  to: string[];
  subject: string | null;
  text: string | null;
  html: string | null;
  attachments: ResendAttachment[];
  /** Resend exposes SPF/DKIM/DMARC verdicts; Mailpit does not (undefined). */
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
   *  basic-auth creds (Mailpit embeds them in MP_WEBHOOK_URL). */
  verifyAuth(request: NextRequest, rawBody: string): Promise<AuthResult>;
  /** Parse the (already-verified) raw JSON body into a normalized email.
   *  Returns null when the shape is unrecognizable. */
  parsePayload(rawBody: string): ParsedInboundEmail | null;
  /** Fetch body + attachment bytes the summary omitted. Degrades to empty on
   *  any failure (warn-logged) so a fetch miss never 5xx's the webhook. */
  fetchContent(messageId: string): Promise<InboundContent>;
  /** Delete the message from the provider after durable store. No-op for
   *  Resend (no delete-received API); real DELETE for Mailpit. */
  deleteReceived(messageId: string): Promise<void>;
}
