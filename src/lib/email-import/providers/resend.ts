/**
 * Resend inbound provider (Epic B1). Wraps the pre-existing svix-verify +
 * tolerant payload parse + attachment-fetch logic that previously lived inline
 * in /api/import/email-webhook. Byte-identical behavior — just relocated behind
 * the InboundEmailProvider interface.
 *
 * `deleteReceived` is a no-op: Resend exposes no delete-received-email API (the
 * very gap that motivated the Mailpit migration).
 */

import type { NextRequest } from "next/server";
import {
  extractSvixHeaders,
  verifySvixSignature,
  SvixVerifyError,
} from "@/lib/webhooks/svix";
import { fetchResendAttachments, fetchResendReceivedBody } from "../fetch-resend-attachments";
import type { ResendAttachment } from "../parse-attachments";
import type {
  AuthResult,
  InboundContent,
  InboundEmailProvider,
  ParsedInboundEmail,
} from "./types";

class ResendProvider implements InboundEmailProvider {
  readonly name = "resend" as const;

  async verifyAuth(request: NextRequest, rawBody: string): Promise<AuthResult> {
    const secret = process.env.RESEND_WEBHOOK_SECRET;
    if (!secret) {
      console.error("[email-webhook] RESEND_WEBHOOK_SECRET not set");
      return { ok: false, status: 500 };
    }
    try {
      verifySvixSignature(rawBody, extractSvixHeaders(request.headers), secret);
      return { ok: true };
    } catch (e) {
      if (e instanceof SvixVerifyError) {
        console.warn(`[email-webhook] svix verify failed: ${e.reason}`);
        return { ok: false, status: 401 };
      }
      throw e;
    }
  }

  parsePayload(rawBody: string): ParsedInboundEmail | null {
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return null;
    }
    return extractResendPayload(raw);
  }

  async fetchContent(messageId: string): Promise<InboundContent> {
    // Resend's `email.received` webhook is metadata-only — NEITHER the body nor
    // the attachment bytes are inlined. Fetch both from the HTTP API. (Called by
    // `enrichInbound` only when the payload didn't already carry text/html —
    // harmless if a future Resend payload does inline them.)
    const [{ text, html }, attachments] = await Promise.all([
      fetchResendReceivedBody(messageId),
      fetchResendAttachments(messageId),
    ]);
    return { text, html, attachments };
  }

  async deleteReceived(): Promise<void> {
    // No-op — Resend has no delete-received-email API.
  }
}

export const resendProvider = new ResendProvider();

// ─── Resend payload shape — tolerant parser (relocated from route.ts) ────────

/**
 * Resend's public Inbound payload shape isn't 100% pinned. Accept a few common
 * variants (nested `data` envelope, `email`/`address` field names,
 * `content`/`content_b64`). Returns null if we can't find from/to fields.
 */
function extractResendPayload(raw: unknown): ParsedInboundEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const outer = raw as Record<string, unknown>;
  const data =
    outer.data && typeof outer.data === "object"
      ? (outer.data as Record<string, unknown>)
      : outer;

  const providerMessageId =
    typeof data.id === "string"
      ? data.id
      : typeof data.email_id === "string"
        ? data.email_id
        : typeof outer.id === "string"
          ? outer.id
          : null;

  const from = extractEmail(data.from);
  if (!from) return null;

  const toRaw = data.to;
  const to: string[] = [];
  if (Array.isArray(toRaw)) {
    for (const t of toRaw) {
      const addr = extractEmail(t);
      if (addr) to.push(addr);
    }
  } else {
    const single = extractEmail(toRaw);
    if (single) to.push(single);
  }
  if (to.length === 0) return null;

  const subject = typeof data.subject === "string" ? data.subject : null;
  const text = typeof data.text === "string" ? data.text : null;
  const html = typeof data.html === "string" ? data.html : null;

  const attachments: ResendAttachment[] = [];
  const attsRaw = data.attachments;
  if (Array.isArray(attsRaw)) {
    for (const a of attsRaw) {
      if (!a || typeof a !== "object") continue;
      const rec = a as Record<string, unknown>;
      const filename =
        typeof rec.filename === "string"
          ? rec.filename
          : typeof rec.name === "string"
            ? rec.name
            : null;
      const content =
        typeof rec.content === "string"
          ? rec.content
          : typeof rec.content_b64 === "string"
            ? rec.content_b64
            : typeof rec.contentBase64 === "string"
              ? rec.contentBase64
              : null;
      if (!filename || !content) continue;
      const contentType =
        typeof rec.content_type === "string"
          ? rec.content_type
          : typeof rec.contentType === "string"
            ? rec.contentType
            : undefined;
      attachments.push({ filename, contentType, content });
    }
  }

  const authVerdict = {
    spf:
      typeof data.spf_verdict === "string"
        ? data.spf_verdict
        : typeof data.spf === "string"
          ? data.spf
          : null,
    dkim:
      typeof data.dkim_verdict === "string"
        ? data.dkim_verdict
        : typeof data.dkim === "string"
          ? data.dkim
          : null,
    dmarc:
      typeof data.dmarc_verdict === "string"
        ? data.dmarc_verdict
        : typeof data.dmarc === "string"
          ? data.dmarc
          : null,
  };

  return { providerMessageId, from, to, subject, text, html, attachments, authVerdict };
}

function extractEmail(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const rec = raw as Record<string, unknown>;
    if (typeof rec.email === "string") return rec.email;
    if (typeof rec.address === "string") return rec.address;
  }
  return null;
}
