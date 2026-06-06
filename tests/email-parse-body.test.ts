import { describe, it, expect } from "vitest";
import { parseEmailBody } from "@/lib/email-import/parse-body";

describe("parseEmailBody", () => {
  it("parses a classic bank 'you spent' alert (high confidence)", () => {
    const r = parseEmailBody({
      subject: "Transaction alert",
      text: "You spent $42.17 at STARBUCKS on Jun 5, 2026 with card ending 1234.",
    });
    expect(r.confidence).toBe("high");
    expect(r.candidate).not.toBeNull();
    expect(r.candidate!.amount).toBeCloseTo(-42.17);
    expect(r.candidate!.currency).toBe("USD");
    expect(r.candidate!.date).toBe("2026-06-05");
    expect(r.candidate!.payee.toUpperCase()).toContain("STARBUCKS");
    expect(r.candidate!.last4).toBe("1234"); // display only
  });

  it("treats a credit/deposit as positive (inflow)", () => {
    const r = parseEmailBody({
      subject: "Deposit notification",
      text: "A deposit of $1,500.00 was credited to your account on 2026-06-01.",
    });
    expect(r.candidate).not.toBeNull();
    expect(r.candidate!.amount).toBeCloseTo(1500);
    expect(r.candidate!.date).toBe("2026-06-01");
  });

  it("recognizes CAD via the C$ symbol", () => {
    const r = parseEmailBody({
      text: "You were charged C$84.99 at LOBLAWS on 2026-05-20.",
    });
    expect(r.candidate!.currency).toBe("CAD");
    expect(r.candidate!.amount).toBeCloseTo(-84.99);
  });

  it("recognizes a trailing ISO code (amount-then-code order)", () => {
    const r = parseEmailBody({
      text: "Payment of 73.50 EUR sent to ACME GmbH on 2026-04-12.",
    });
    expect(r.candidate!.currency).toBe("EUR");
    expect(r.candidate!.amount).toBeCloseTo(-73.5);
    expect(r.candidate!.payee.toUpperCase()).toContain("ACME");
  });

  it("parses an Interac e-transfer notice", () => {
    const r = parseEmailBody({
      subject: "INTERAC e-Transfer: You received money",
      text: "Hi, you received $200.00 from JANE DOE on 2026-03-15. The money was deposited.",
    });
    expect(r.candidate!.amount).toBeCloseTo(200);
    expect(r.candidate!.payee.toUpperCase()).toContain("JANE");
  });

  it("parses a PayPal-style receipt (HTML body, tags stripped)", () => {
    const r = parseEmailBody({
      subject: "Receipt for your payment",
      html: "<html><body><p>You sent <b>£19.99</b> to <a>Spotify Ltd</a> on 2026-02-02.</p></body></html>",
    });
    expect(r.candidate!.currency).toBe("GBP");
    expect(r.candidate!.amount).toBeCloseTo(-19.99);
    expect(r.candidate!.payee.toUpperCase()).toContain("SPOTIFY");
  });

  it("downgrades to low when multiple distinct amounts appear", () => {
    const r = parseEmailBody({
      text: "Subtotal $40.00, tax $2.17, you spent $42.17 at STORE on 2026-06-05.",
    });
    expect(r.confidence).toBe("low");
    expect(r.candidate).not.toBeNull();
  });

  it("does not double-count the same amount mentioned twice", () => {
    const r = parseEmailBody({
      text: "You spent $42.17 at CAFE on 2026-06-05. Amount: $42.17.",
    });
    expect(r.confidence).toBe("high");
  });

  it("downgrades to low when only the received-date fallback is available", () => {
    const r = parseEmailBody({
      subject: "Card charge",
      text: "You were charged $9.99 at NETFLIX.",
      receivedDate: "2026-06-05",
    });
    expect(r.confidence).toBe("low");
    expect(r.candidate!.date).toBe("2026-06-05");
  });

  it("returns null candidate + null confidence for non-financial text", () => {
    const r = parseEmailBody({
      subject: "Lunch tomorrow?",
      text: "Hey, are we still on for lunch tomorrow at noon? Let me know.",
    });
    expect(r.candidate).toBeNull();
    expect(r.confidence).toBeNull();
  });

  it("returns null when no date and no fallback are available", () => {
    const r = parseEmailBody({
      text: "You spent $9.99 at NETFLIX.",
    });
    expect(r.candidate).toBeNull();
    expect(r.confidence).toBeNull();
  });

  it("never folds the last-4 into the amount", () => {
    const r = parseEmailBody({
      text: "You spent $5.00 at SHOP on 2026-06-05 with card ending 4321.",
    });
    expect(r.candidate!.amount).toBeCloseTo(-5);
    expect(r.candidate!.last4).toBe("4321");
  });

  it("handles a bare $ as USD (app default)", () => {
    const r = parseEmailBody({
      text: "Charged $12.34 at MERCHANT on 2026-06-05.",
    });
    expect(r.candidate!.currency).toBe("USD");
  });

  it("flags an ambiguous numeric date as low", () => {
    const r = parseEmailBody({
      text: "You spent $20.00 at CAFE on 03/04/2026.",
    });
    // 03/04 could be Mar 4 or Apr 3 → ambiguous → low.
    expect(r.confidence).toBe("low");
    expect(r.candidate).not.toBeNull();
  });
});

describe("parseEmailBody — signals", () => {
  it("reports a single detected amount + clean signals on a high-confidence parse", () => {
    const r = parseEmailBody({
      text: "You spent $42.17 at STARBUCKS on Jun 5, 2026 with card ending 1234.",
    });
    expect(r.signals).toBeDefined();
    expect(r.signals!.detectedAmounts).toHaveLength(1);
    expect(r.signals!.detectedAmounts[0]).toEqual({ value: 42.17, currency: "USD" });
    expect(r.signals!.multipleAmounts).toBe(false);
    expect(r.signals!.usedFallbackDate).toBe(false);
    expect(r.signals!.dateAmbiguous).toBe(false);
    expect(r.signals!.signExplicit).toBe(true); // "spent"
    expect(r.signals!.last4).toBe("1234");
  });

  it("flags multipleAmounts when distinct amounts appear", () => {
    const r = parseEmailBody({
      text: "Subtotal $40.00, tax $2.17, you spent $42.17 at STORE on 2026-06-05.",
    });
    expect(r.signals!.multipleAmounts).toBe(true);
    expect(r.signals!.detectedAmounts.length).toBeGreaterThan(1);
  });

  it("flags usedFallbackDate when the date comes from the received-date fallback", () => {
    const r = parseEmailBody({
      text: "You were charged $9.99 at NETFLIX.",
      receivedDate: "2026-06-05",
    });
    expect(r.signals!.usedFallbackDate).toBe(true);
  });

  it("flags dateAmbiguous for a numeric DD/MM-vs-MM/DD date", () => {
    const r = parseEmailBody({ text: "You spent $20.00 at CAFE on 03/04/2026." });
    expect(r.signals!.dateAmbiguous).toBe(true);
  });

  it("reports signExplicit=false when no debit/credit verb is present", () => {
    const r = parseEmailBody({ text: "$15.00 at SHOP on 2026-06-05." });
    expect(r.signals!.signExplicit).toBe(false);
  });

  it("returns empty detectedAmounts signals when no amount is found", () => {
    const r = parseEmailBody({ subject: "Lunch?", text: "Are we on for lunch tomorrow?" });
    expect(r.candidate).toBeNull();
    expect(r.signals).toBeDefined();
    expect(r.signals!.detectedAmounts).toHaveLength(0);
  });
});
