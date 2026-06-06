/**
 * Self-hosted inbound provider — DevManager push relay (revised 2026-06-05).
 *
 * SUPERSEDES the original Mailpit basic-auth *pull* design. We keep DevManager
 * as a filtering middleman: inbound mail lands in Mailpit on the DevManager box,
 * DevManager receives + filters it (recipient allowlist, attachment hard-deny,
 * size caps, rate limit, best-effort SPF), then PUSHes a self-contained
 * `NormalizedInboundEmail` JSON (attachments inline as base64) to this app's
 * webhook, HMAC-signed. The app NEVER talks to Mailpit — it only verifies the
 * signature and stores. DevManager DELETEs the Mailpit copy on our 2xx; on a
 * non-2xx it RETAINS + retries via its own ~2-min reconciliation sweep, so a
 * brief app outage loses nothing (no app-side poll backstop needed).
 *
 * Consequences vs the old pull design:
 *   - verifyAuth     → HMAC-SHA256 (X-Mail-Signature), NOT basic-auth.
 *   - parsePayload   → maps the pushed NormalizedInboundEmail; attachments are
 *                      already inline (base64) — no fetch.
 *   - fetchContent   → no-op (payload is self-contained).
 *   - deleteReceived → no-op (DevManager owns the Mailpit delete on our 2xx).
 *   - listPending    → removed (DevManager owns retry; the app has no Mailpit
 *                      network access to poll).
 *
 * Env:
 *   FINLYNQ_INBOUND_SECRET   shared HMAC secret (>=16 chars), identical on the
 *                            DevManager box (its `FINLYNQ_INBOUND_SECRET`).
 *
 * HMAC contract (mirror of DevManager's `signPayload`):
 *   headers:
 *     X-Mail-Timestamp   ISO-8601 UTC, e.g. 2026-06-05T17:03:59.123Z
 *     X-Mail-Signature   `sha256=<hex>` where
 *                        <hex> = HMAC_SHA256(secret, `${X-Mail-Timestamp}.${rawBody}`)
 *     X-Mail-Message-Id  the payload's message_id (informational)
 *   Sign/verify over the RAW request body bytes (before JSON.parse) — the route
 *   passes `await request.text()` to verifyAuth so whitespace/key-order can't
 *   break the MAC. Freshness (|now - timestamp| <= 5 min) is enforced HERE
 *   (DevManager does not) to bound replay. Failure → 401; missing secret → 500.
 */

import { createHmac, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import type { ResendAttachment } from "../parse-attachments";
import type {
  AuthResult,
  InboundContent,
  InboundEmailProvider,
  ParsedInboundEmail,
} from "./types";

/** Replay window for X-Mail-Timestamp. */
const SIGNATURE_FRESHNESS_MS = 5 * 60 * 1000;

/** Constant-time compare of two strings (already fixed-length hex here). */
function safeEqual(a: string, b: string): boolean {
  const ba = Buffer.from(a);
  const bb = Buffer.from(b);
  return ba.length === bb.length && timingSafeEqual(ba, bb);
}

class SelfSmtpProvider implements InboundEmailProvider {
  readonly name = "self-smtp" as const;

  async verifyAuth(request: NextRequest, rawBody: string): Promise<AuthResult> {
    const secret = process.env.FINLYNQ_INBOUND_SECRET;
    if (!secret || secret.length < 16) {
      console.error("[email-webhook] FINLYNQ_INBOUND_SECRET not set or too short (>=16 chars)");
      return { ok: false, status: 500 };
    }

    const timestamp = request.headers.get("x-mail-timestamp");
    const sigHeader = request.headers.get("x-mail-signature");
    if (!timestamp || !sigHeader) {
      return { ok: false, status: 401 };
    }

    // Freshness — bound replay. ISO-8601 → epoch ms.
    const ts = Date.parse(timestamp);
    if (!Number.isFinite(ts) || Math.abs(Date.now() - ts) > SIGNATURE_FRESHNESS_MS) {
      return { ok: false, status: 401 };
    }

    // Mirror of DevManager: HMAC over `${timestamp}.${rawBody}`, with the
    // literal "sha256=" prefix included in the compared string.
    const mac = createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex");
    const expected = `sha256=${mac}`;
    return safeEqual(expected, sigHeader) ? { ok: true } : { ok: false, status: 401 };
  }

  parsePayload(rawBody: string): ParsedInboundEmail | null {
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return null;
    }
    return normalizedToParsed(raw);
  }

  async fetchContent(): Promise<InboundContent> {
    // No-op — the DevManager push payload is self-contained (body + attachments
    // inline), so there is nothing to fetch back.
    return { text: null, html: null, attachments: [] };
  }

  async deleteReceived(): Promise<void> {
    // No-op — DevManager deletes the Mailpit copy on our 2xx. The app holds no
    // Mailpit credentials and never talks to the mail store.
  }
}

export const selfSmtpProvider = new SelfSmtpProvider();

// ─── NormalizedInboundEmail (DevManager push payload) ────────────────────────
//
// {
//   "message_id": "<mailpit id>",        // stable; our dedupe/idempotency key
//   "smtp_message_id": "<...@host>|null",
//   "from": { "name": "Bank|null", "address": "alerts@bank.com" },
//   "to":   [ { "name": null, "address": "import-<hex>@<domain>" } ],
//   "recipient": "import-<hex>@<domain>", // the matched address that routed it
//   "subject": "...",
//   "text": "...|null",
//   "html": "<p>...</p>|null",
//   "attachments": [ { "filename", "content_type", "size", "content_base64" } ],
//   "received_at": "2026-06-05T10:00:00Z"
// }

interface NormalizedAddress {
  name?: string | null;
  address?: string | null;
}
interface NormalizedAttachment {
  filename?: string;
  content_type?: string;
  size?: number;
  content_base64?: string;
}

/** Map the DevManager push payload → ParsedInboundEmail (attachments inline). */
function normalizedToParsed(raw: unknown): ParsedInboundEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;

  const providerMessageId =
    typeof data.message_id === "string" ? data.message_id : null;

  const from = extractAddress(data.from);
  if (!from) return null;

  // DevManager already ran the recipient allowlist, so `recipient` is THE
  // matched import address — route only that, not every `to`/cc recipient
  // (which would spuriously land in the mailbox/trash router). Fall back to the
  // `to` list only if `recipient` is somehow absent.
  const to: string[] = [];
  if (typeof data.recipient === "string" && data.recipient.trim()) {
    to.push(data.recipient.trim());
  } else {
    for (const a of extractAddressList(data.to)) to.push(a);
  }
  if (to.length === 0) return null;

  const subject = typeof data.subject === "string" ? data.subject : null;
  const text = typeof data.text === "string" ? data.text : null;
  const html = typeof data.html === "string" ? data.html : null;

  const attachments: ResendAttachment[] = [];
  if (Array.isArray(data.attachments)) {
    for (const a of data.attachments) {
      if (!a || typeof a !== "object") continue;
      const rec = a as NormalizedAttachment;
      if (typeof rec.filename !== "string" || typeof rec.content_base64 !== "string") continue;
      attachments.push({
        filename: rec.filename,
        contentType: typeof rec.content_type === "string" ? rec.content_type : undefined,
        content: rec.content_base64,
      });
    }
  }

  return { providerMessageId, from, to, subject, text, html, attachments };
}

function extractAddress(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const a = raw as NormalizedAddress;
    if (typeof a.address === "string") return a.address;
  }
  return null;
}

function extractAddressList(raw: unknown): string[] {
  const out: string[] = [];
  if (Array.isArray(raw)) {
    for (const item of raw) {
      const a = extractAddress(item);
      if (a) out.push(a);
    }
  } else {
    const single = extractAddress(raw);
    if (single) out.push(single);
  }
  return out;
}
