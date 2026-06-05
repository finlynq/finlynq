/**
 * Self-hosted Mailpit inbound provider (Epic B1 / B4). Mailpit POSTs a message
 * *summary* JSON to MP_WEBHOOK_URL with basic-auth embedded in the URL (it
 * can't send custom secret headers). The summary carries NO body/attachment
 * bytes, so `fetchContent` pulls the full message via the Mailpit REST API,
 * and `deleteReceived` removes it after we've durably stored it.
 *
 * Env:
 *   MAILPIT_API_URL              base URL, e.g. https://mail.finlynq.com
 *   MAILPIT_API_USER/PASS        MP_UI_AUTH basic-auth for the REST API
 *   MAILPIT_WEBHOOK_USER/PASS    basic-auth Mailpit embeds in MP_WEBHOOK_URL
 *                                (falls back to the API creds if unset)
 *
 * Mailpit API:
 *   GET    /api/v1/message/{ID}             full body + attachment parts
 *   GET    /api/v1/message/{ID}/part/{PID}  raw part bytes
 *   DELETE /api/v1/messages  (body {IDs:[…]}) delete after store
 */

import { createHash, timingSafeEqual } from "crypto";
import type { NextRequest } from "next/server";
import type { ResendAttachment } from "../parse-attachments";
import type {
  AuthResult,
  InboundContent,
  InboundEmailProvider,
  ParsedInboundEmail,
} from "./types";

function apiBase(): string {
  return (process.env.MAILPIT_API_URL || "").replace(/\/+$/, "");
}

function apiAuthHeader(): string | null {
  const user = process.env.MAILPIT_API_USER;
  const pass = process.env.MAILPIT_API_PASS;
  if (!user || !pass) return null;
  return `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
}

/** Constant-time compare of two strings via fixed-length SHA-256 digests. */
function safeEqual(a: string, b: string): boolean {
  const da = createHash("sha256").update(a).digest();
  const db = createHash("sha256").update(b).digest();
  return timingSafeEqual(da, db);
}

class SelfSmtpProvider implements InboundEmailProvider {
  readonly name = "self-smtp" as const;

  async verifyAuth(request: NextRequest): Promise<AuthResult> {
    const user = process.env.MAILPIT_WEBHOOK_USER || process.env.MAILPIT_API_USER;
    const pass = process.env.MAILPIT_WEBHOOK_PASS || process.env.MAILPIT_API_PASS;
    if (!user || !pass) {
      console.error("[email-webhook] MAILPIT_WEBHOOK_USER/PASS not set");
      return { ok: false, status: 500 };
    }
    const header = request.headers.get("authorization") || "";
    const m = /^Basic\s+(.+)$/i.exec(header.trim());
    if (!m) return { ok: false, status: 401 };
    let decoded: string;
    try {
      decoded = Buffer.from(m[1], "base64").toString("utf8");
    } catch {
      return { ok: false, status: 401 };
    }
    return safeEqual(decoded, `${user}:${pass}`)
      ? { ok: true }
      : { ok: false, status: 401 };
  }

  parsePayload(rawBody: string): ParsedInboundEmail | null {
    let raw: unknown;
    try {
      raw = JSON.parse(rawBody);
    } catch {
      return null;
    }
    return summaryToParsed(raw);
  }

  async listPending(limit: number): Promise<ParsedInboundEmail[]> {
    const base = apiBase();
    const auth = apiAuthHeader();
    if (!base || !auth) return [];
    try {
      const resp = await fetch(`${base}/api/v1/messages?limit=${limit}`, {
        headers: { Authorization: auth },
      });
      if (!resp.ok) {
        console.warn(`[email-webhook] mailpit list HTTP ${resp.status}`);
        return [];
      }
      const data = (await resp.json()) as { messages?: unknown[] };
      const msgs = Array.isArray(data.messages) ? data.messages : [];
      const out: ParsedInboundEmail[] = [];
      for (const m of msgs) {
        const parsed = summaryToParsed(m);
        if (parsed) out.push(parsed);
      }
      return out;
    } catch (e) {
      console.warn("[email-webhook] mailpit list error:", e);
      return [];
    }
  }

  async fetchContent(messageId: string): Promise<InboundContent> {
    const base = apiBase();
    const auth = apiAuthHeader();
    if (!base || !auth) {
      console.warn("[email-webhook] MAILPIT_API_URL/USER/PASS not set — cannot fetch message");
      return { text: null, html: null, attachments: [] };
    }

    let msg: MailpitMessage | null = null;
    try {
      const resp = await fetch(
        `${base}/api/v1/message/${encodeURIComponent(messageId)}`,
        { headers: { Authorization: auth } },
      );
      if (!resp.ok) {
        console.warn(`[email-webhook] mailpit get-message HTTP ${resp.status} for ${messageId}`);
        return { text: null, html: null, attachments: [] };
      }
      msg = (await resp.json()) as MailpitMessage;
    } catch (e) {
      console.warn(`[email-webhook] mailpit get-message error for ${messageId}:`, e);
      return { text: null, html: null, attachments: [] };
    }

    const text = typeof msg.Text === "string" ? msg.Text : null;
    const html = typeof msg.HTML === "string" ? msg.HTML : null;

    const attachments: ResendAttachment[] = [];
    const parts = Array.isArray(msg.Attachments) ? msg.Attachments : [];
    for (const part of parts) {
      const partId = part.PartID;
      const filename = part.FileName;
      if (!partId || !filename) continue;
      try {
        const partResp = await fetch(
          `${base}/api/v1/message/${encodeURIComponent(messageId)}/part/${encodeURIComponent(partId)}`,
          { headers: { Authorization: auth } },
        );
        if (!partResp.ok) {
          console.warn(`[email-webhook] mailpit get-part HTTP ${partResp.status} for ${messageId}/${partId}`);
          continue;
        }
        const buf = Buffer.from(await partResp.arrayBuffer());
        attachments.push({
          filename,
          contentType: part.ContentType,
          content: buf.toString("base64"),
        });
      } catch (e) {
        console.warn(`[email-webhook] mailpit get-part error for ${messageId}/${partId}:`, e);
      }
    }

    return { text, html, attachments };
  }

  async deleteReceived(messageId: string): Promise<void> {
    const base = apiBase();
    const auth = apiAuthHeader();
    if (!base || !auth) return;
    try {
      const resp = await fetch(`${base}/api/v1/messages`, {
        method: "DELETE",
        headers: { Authorization: auth, "Content-Type": "application/json" },
        body: JSON.stringify({ IDs: [messageId] }),
      });
      if (!resp.ok) {
        console.warn(`[email-webhook] mailpit delete HTTP ${resp.status} for ${messageId}`);
      }
    } catch (e) {
      console.warn(`[email-webhook] mailpit delete error for ${messageId}:`, e);
    }
  }
}

export const selfSmtpProvider = new SelfSmtpProvider();

// ─── Mailpit shapes (tolerant) ───────────────────────────────────────────────

interface MailpitAddress {
  Name?: string;
  Address?: string;
}
interface MailpitPart {
  PartID?: string;
  FileName?: string;
  ContentType?: string;
  Size?: number;
}
interface MailpitMessage {
  Text?: string;
  HTML?: string;
  Attachments?: MailpitPart[];
}

/** Map a Mailpit message summary (webhook payload OR a list item) →
 *  ParsedInboundEmail. Body/attachment bytes are fetched per message later. */
function summaryToParsed(raw: unknown): ParsedInboundEmail | null {
  if (!raw || typeof raw !== "object") return null;
  const data = raw as Record<string, unknown>;
  const providerMessageId =
    typeof data.ID === "string"
      ? data.ID
      : typeof data.id === "string"
        ? data.id
        : null;
  const from = extractAddress(data.From);
  if (!from) return null;
  const to = extractAddressList(data.To);
  if (to.length === 0) return null;
  const subject = typeof data.Subject === "string" ? data.Subject : null;
  return { providerMessageId, from, to, subject, text: null, html: null, attachments: [] };
}

function extractAddress(raw: unknown): string | null {
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object") {
    const a = raw as MailpitAddress;
    if (typeof a.Address === "string") return a.Address;
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
