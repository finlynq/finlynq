import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { resendProvider } from "@/lib/email-import/providers/resend";
import { selfSmtpProvider } from "@/lib/email-import/providers/self-smtp";
import { getInboundProvider } from "@/lib/email-import/providers";

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

describe("selfSmtpProvider.parsePayload (Mailpit summary)", () => {
  it("maps a Mailpit message summary; body/attachments fetched later", () => {
    const body = JSON.stringify({
      ID: "rqGUSEAm6JToZH7zrtfPNU",
      From: { Name: "Bank", Address: "alerts@bank.example" },
      To: [{ Name: "", Address: "import-deadbeef@finlynq.com" }],
      Subject: "You spent $42.17",
      Attachments: 0,
    });
    const p = selfSmtpProvider.parsePayload(body);
    expect(p).not.toBeNull();
    expect(p!.providerMessageId).toBe("rqGUSEAm6JToZH7zrtfPNU");
    expect(p!.from).toBe("alerts@bank.example");
    expect(p!.to).toEqual(["import-deadbeef@finlynq.com"]);
    expect(p!.subject).toBe("You spent $42.17");
    // Summary carries no body/attachment bytes — fetchContent fills these.
    expect(p!.text).toBeNull();
    expect(p!.html).toBeNull();
    expect(p!.attachments).toEqual([]);
  });

  it("returns null on unrecognizable shape", () => {
    expect(selfSmtpProvider.parsePayload(JSON.stringify({}))).toBeNull();
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
