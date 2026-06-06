import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHmac } from "crypto";
import type { NextRequest } from "next/server";
import { resendProvider } from "@/lib/email-import/providers/resend";
import { selfSmtpProvider } from "@/lib/email-import/providers/self-smtp";
import { getInboundProvider } from "@/lib/email-import/providers";

/** Minimal NextRequest stub — verifyAuth only reads request.headers.get(). */
function reqWithHeaders(h: Record<string, string>): NextRequest {
  return { headers: new Headers(h) } as unknown as NextRequest;
}

/** Sign exactly like DevManager's signPayload (mirror of the provider). */
function sign(secret: string, timestamp: string, rawBody: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${rawBody}`).digest("hex")}`;
}

describe("resendProvider.parsePayload", () => {
  it("parses a nested-data Resend payload", () => {
    const body = JSON.stringify({
      type: "email.received",
      data: {
        id: "re_abc123",
        from: { address: "sender@example.com" },
        to: [{ address: "import-deadbeef@finlynq.com" }],
        subject: "Statement",
        text: "body text",
        html: "<p>body</p>",
        attachments: [
          { filename: "stmt.csv", content_type: "text/csv", content: "ZGF0YQ==" },
        ],
        spf_verdict: "pass",
      },
    });
    const p = resendProvider.parsePayload(body);
    expect(p).not.toBeNull();
    expect(p!.providerMessageId).toBe("re_abc123");
    expect(p!.from).toBe("sender@example.com");
    expect(p!.to).toEqual(["import-deadbeef@finlynq.com"]);
    expect(p!.subject).toBe("Statement");
    expect(p!.text).toBe("body text");
    expect(p!.attachments).toHaveLength(1);
    expect(p!.attachments[0].filename).toBe("stmt.csv");
    expect(p!.authVerdict?.spf).toBe("pass");
  });

  it("returns null when from/to are missing", () => {
    expect(resendProvider.parsePayload(JSON.stringify({ data: {} }))).toBeNull();
    expect(resendProvider.parsePayload("not json")).toBeNull();
  });
});

describe("selfSmtpProvider.parsePayload (DevManager push payload)", () => {
  it("maps a self-contained NormalizedInboundEmail; routes the matched recipient", () => {
    const body = JSON.stringify({
      message_id: "rqGUSEAm6JToZH7zrtfPNU",
      smtp_message_id: "<abc@bank.example>",
      from: { name: "Bank", address: "alerts@bank.example" },
      to: [
        { name: null, address: "import-deadbeef@finlynq.com" },
        { name: null, address: "someone-else@finlynq.com" },
      ],
      recipient: "import-deadbeef@finlynq.com",
      subject: "You spent $42.17",
      text: "You spent $42.17 at STARBUCKS",
      html: "<p>You spent $42.17</p>",
      attachments: [
        { filename: "stmt.csv", content_type: "text/csv", size: 4, content_base64: "ZGF0YQ==" },
      ],
      received_at: "2026-06-05T10:00:00Z",
    });
    const p = selfSmtpProvider.parsePayload(body);
    expect(p).not.toBeNull();
    expect(p!.providerMessageId).toBe("rqGUSEAm6JToZH7zrtfPNU");
    expect(p!.from).toBe("alerts@bank.example");
    // Only the matched `recipient` is routed — not the cc'd address.
    expect(p!.to).toEqual(["import-deadbeef@finlynq.com"]);
    expect(p!.subject).toBe("You spent $42.17");
    // Push payload is self-contained — body + attachments inline.
    expect(p!.text).toBe("You spent $42.17 at STARBUCKS");
    expect(p!.html).toBe("<p>You spent $42.17</p>");
    expect(p!.attachments).toHaveLength(1);
    expect(p!.attachments[0].filename).toBe("stmt.csv");
    expect(p!.attachments[0].contentType).toBe("text/csv");
    expect(p!.attachments[0].content).toBe("ZGF0YQ==");
  });

  it("falls back to the `to` list when `recipient` is absent", () => {
    const body = JSON.stringify({
      message_id: "id1",
      from: { address: "alerts@bank.example" },
      to: [{ address: "import-deadbeef@finlynq.com" }],
    });
    const p = selfSmtpProvider.parsePayload(body);
    expect(p!.to).toEqual(["import-deadbeef@finlynq.com"]);
  });

  it("returns null on unrecognizable shape or missing from/to", () => {
    expect(selfSmtpProvider.parsePayload(JSON.stringify({}))).toBeNull();
    expect(selfSmtpProvider.parsePayload(JSON.stringify({ from: { address: "x@y.z" } }))).toBeNull();
    expect(selfSmtpProvider.parsePayload("not json")).toBeNull();
  });
});

describe("selfSmtpProvider.verifyAuth (HMAC push)", () => {
  const SECRET = "test-inbound-secret-0123456789";
  const orig = process.env.FINLYNQ_INBOUND_SECRET;
  beforeEach(() => {
    process.env.FINLYNQ_INBOUND_SECRET = SECRET;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.FINLYNQ_INBOUND_SECRET;
    else process.env.FINLYNQ_INBOUND_SECRET = orig;
  });

  const body = JSON.stringify({ message_id: "id", from: { address: "a@b.c" }, recipient: "import-x@finlynq.com" });

  it("accepts a valid signature + fresh timestamp", async () => {
    const ts = new Date().toISOString();
    const res = await selfSmtpProvider.verifyAuth(
      reqWithHeaders({ "x-mail-timestamp": ts, "x-mail-signature": sign(SECRET, ts, body) }),
      body,
    );
    expect(res).toEqual({ ok: true });
  });

  it("rejects a tampered body (401)", async () => {
    const ts = new Date().toISOString();
    const res = await selfSmtpProvider.verifyAuth(
      reqWithHeaders({ "x-mail-timestamp": ts, "x-mail-signature": sign(SECRET, ts, body) }),
      body + " ",
    );
    expect(res).toEqual({ ok: false, status: 401 });
  });

  it("rejects a wrong secret (401)", async () => {
    const ts = new Date().toISOString();
    const res = await selfSmtpProvider.verifyAuth(
      reqWithHeaders({ "x-mail-timestamp": ts, "x-mail-signature": sign("other-secret-abcdefghij", ts, body) }),
      body,
    );
    expect(res).toEqual({ ok: false, status: 401 });
  });

  it("rejects a stale timestamp (>5min, 401)", async () => {
    const ts = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    const res = await selfSmtpProvider.verifyAuth(
      reqWithHeaders({ "x-mail-timestamp": ts, "x-mail-signature": sign(SECRET, ts, body) }),
      body,
    );
    expect(res).toEqual({ ok: false, status: 401 });
  });

  it("rejects missing headers (401)", async () => {
    expect(await selfSmtpProvider.verifyAuth(reqWithHeaders({}), body)).toEqual({ ok: false, status: 401 });
  });

  it("500s when the secret is unset or too short", async () => {
    delete process.env.FINLYNQ_INBOUND_SECRET;
    const ts = new Date().toISOString();
    expect(
      await selfSmtpProvider.verifyAuth(
        reqWithHeaders({ "x-mail-timestamp": ts, "x-mail-signature": "sha256=deadbeef" }),
        body,
      ),
    ).toEqual({ ok: false, status: 500 });
    process.env.FINLYNQ_INBOUND_SECRET = "short";
    expect(
      await selfSmtpProvider.verifyAuth(
        reqWithHeaders({ "x-mail-timestamp": ts, "x-mail-signature": "sha256=deadbeef" }),
        body,
      ),
    ).toEqual({ ok: false, status: 500 });
  });
});

describe("getInboundProvider", () => {
  const orig = process.env.INBOUND_EMAIL_PROVIDER;
  beforeEach(() => {
    delete process.env.INBOUND_EMAIL_PROVIDER;
  });
  afterEach(() => {
    if (orig === undefined) delete process.env.INBOUND_EMAIL_PROVIDER;
    else process.env.INBOUND_EMAIL_PROVIDER = orig;
  });

  it("defaults to resend", () => {
    expect(getInboundProvider().name).toBe("resend");
  });
  it("selects self-smtp when env is set", () => {
    process.env.INBOUND_EMAIL_PROVIDER = "self-smtp";
    expect(getInboundProvider().name).toBe("self-smtp");
  });
});
