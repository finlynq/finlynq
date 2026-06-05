/**
 * Inbound-email provider selector (Epic B1). Picks the provider by
 * INBOUND_EMAIL_PROVIDER:
 *   - 'self-smtp' → Mailpit (self-hosted; basic-auth; fetch + delete)
 *   - 'resend'    → Resend (legacy; svix; no delete) — the default so an
 *                   unset env keeps the pre-migration behavior.
 */

import { resendProvider } from "./resend";
import { selfSmtpProvider } from "./self-smtp";
import type { InboundEmailProvider } from "./types";

export type { InboundEmailProvider, ParsedInboundEmail, InboundContent } from "./types";

export function getInboundProvider(): InboundEmailProvider {
  const sel = (process.env.INBOUND_EMAIL_PROVIDER || "resend").toLowerCase();
  return sel === "self-smtp" ? selfSmtpProvider : resendProvider;
}
