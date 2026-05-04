/**
 * Issue #126 — investment-OFX/QFX dispatch on the reconcile preview route.
 *
 * Regression guard: an `<INVSTMTRS>` upload to /api/import/reconcile/preview
 * must NOT 400 with "No transactions found in OFX/QFX file" — the route now
 * detects the investment block and routes through `parseOfxToCanonical`
 * (the same path /api/import/preview uses). Bank/CC OFX still flows through
 * the legacy `parseOfx` parser.
 *
 * The reconcile classifier is mocked out so this test focuses on the
 * parser-routing fix, not the classifier itself (which is exercised by
 * src/lib/reconcile.ts's own unit tests).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const dek = Buffer.alloc(32, 1);

const mockAuthEnc = vi.fn();
vi.mock("@/lib/auth/require-encryption", () => ({
  requireEncryption: (...a: unknown[]) => mockAuthEnc(...a),
}));

// Capture the rows the route hands to the classifier so we can assert
// shape + count without exercising the (heavy) classifier itself.
const mockClassify = vi.fn();
vi.mock("@/lib/reconcile", async () => {
  const actual =
    await vi.importActual<typeof import("@/lib/reconcile")>("@/lib/reconcile");
  return {
    ...actual,
    classifyForReconcile: (...a: unknown[]) => mockClassify(...a),
  };
});

// Account lookup — return a single brokerage account for the user.
vi.mock("@/db", () => {
  const acct = {
    id: 42,
    nameCt: "v1:dummy", // decryptName is mocked below to return "Brokerage"
  };
  const get = vi.fn().mockReturnValue(acct);
  const where = vi.fn().mockReturnValue({ get });
  const from = vi.fn().mockReturnValue({ where });
  const select = vi.fn().mockReturnValue({ from });
  return {
    db: { select },
    schema: {
      accounts: {
        id: "accounts.id",
        nameCt: "accounts.name_ct",
        userId: "accounts.user_id",
      },
    },
  };
});

vi.mock("@/lib/crypto/encrypted-columns", () => ({
  decryptName: vi.fn().mockReturnValue("Brokerage"),
}));

// drizzle-orm builders — only `and` / `eq` are used in the route.
vi.mock("drizzle-orm", async () => {
  const actual = await vi.importActual<typeof import("drizzle-orm")>("drizzle-orm");
  return {
    ...actual,
    and: vi.fn(() => ({})),
    eq: vi.fn(() => ({})),
  };
});

import { POST } from "@/app/api/import/reconcile/preview/route";

// ─── Fixtures (synthetic; account id is made up) ──────────────────────────

const OFX_INVESTMENT_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:103
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<INVSTMTMSGSRSV1>
<INVSTMTTRNRS>
<INVSTMTRS>
<DTASOF>20260301
<CURDEF>USD
<INVACCTFROM>
<BROKERID>example.com
<ACCTID>1234567890
</INVACCTFROM>
<INVTRANLIST>
<DTSTART>20260101
<DTEND>20260301
<BUYSTOCK>
<INVBUY>
<INVTRAN>
<FITID>BUY-AAPL-001
<DTTRADE>20260115
</INVTRAN>
<SECID>
<UNIQUEID>AAPL
<UNIQUEIDTYPE>TICKER
</SECID>
<UNITS>10
<UNITPRICE>180.00
<COMMISSION>1.00
<TOTAL>-1801.00
<SUBACCTSEC>CASH
<SUBACCTFUND>CASH
</INVBUY>
<BUYTYPE>BUY
</BUYSTOCK>
<INCOME>
<INVTRAN>
<FITID>DIV-AAPL-002
<DTTRADE>20260220
</INVTRAN>
<SECID>
<UNIQUEID>AAPL
<UNIQUEIDTYPE>TICKER
</SECID>
<INCOMETYPE>DIV
<TOTAL>2.40
<SUBACCTSEC>CASH
<SUBACCTFUND>CASH
</INCOME>
</INVTRANLIST>
<INVPOSLIST>
</INVPOSLIST>
<INVBAL>
<AVAILCASH>1234.56
<MARGINBALANCE>0.00
<SHORTBALANCE>0.00
</INVBAL>
</INVSTMTRS>
</INVSTMTTRNRS>
</INVSTMTMSGSRSV1>
<SECLISTMSGSRSV1>
<SECLIST>
<STOCKINFO>
<SECINFO>
<SECID>
<UNIQUEID>AAPL
<UNIQUEIDTYPE>TICKER
</SECID>
<SECNAME>Apple Inc
<TICKER>AAPL
</SECINFO>
</STOCKINFO>
</SECLIST>
</SECLISTMSGSRSV1>
</OFX>`;

const OFX_BANK_SGML = `OFXHEADER:100
DATA:OFXSGML
VERSION:103
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>CAD
<BANKACCTFROM>
<BANKID>123456789
<ACCTID>9876543210
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20260115120000
<TRNAMT>-50.00
<FITID>TXN001
<NAME>Coffee Shop
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

// Build a multipart body the route's formData() can read.
function buildMultipart(file: { name: string; content: string }, accountId: string): NextRequest {
  const boundary = "----TEST" + Math.random().toString(36).slice(2);
  const parts: string[] = [];
  parts.push(`--${boundary}`);
  parts.push(`Content-Disposition: form-data; name="file"; filename="${file.name}"`);
  parts.push("Content-Type: application/octet-stream");
  parts.push("");
  parts.push(file.content);
  parts.push(`--${boundary}`);
  parts.push(`Content-Disposition: form-data; name="accountId"`);
  parts.push("");
  parts.push(accountId);
  parts.push(`--${boundary}--`);
  parts.push("");
  const body = parts.join("\r\n");
  return new NextRequest(
    new URL("http://localhost:3000/api/import/reconcile/preview"),
    {
      method: "POST",
      headers: { "Content-Type": `multipart/form-data; boundary=${boundary}` },
      body,
    } as never,
  );
}

describe("API /api/import/reconcile/preview — investment OFX/QFX dispatch (issue #126)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthEnc.mockResolvedValue({ ok: true, userId: "u1", dek, sessionId: "s1" });
    // Pass-through classifier: echo rows back as `new` so we can inspect them.
    mockClassify.mockImplementation(async (_userId, _dek, rows: unknown[]) => ({
      rows: (rows as Array<Record<string, unknown>>).map((r, i) => ({
        ...r,
        rowIndex: i,
        accountId: 42,
        hash: `hash-${i}`,
        status: "new",
      })),
      errors: [],
      counts: { new: rows.length, existing: 0, probableDuplicate: 0, errors: 0 },
    }));
  });

  it("routes <INVSTMTRS> .ofx through the canonical investment parser (no 400)", async () => {
    const req = buildMultipart(
      { name: "broker.ofx", content: OFX_INVESTMENT_SGML },
      "42",
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.format).toBe("ofx");
    // Investment fixture emits at least: BUY cash leg + BUY position leg +
    // BUY commission + DIV row = 4 rows. Don't pin the exact number — the
    // emitter may legitimately add legs in future revisions.
    expect(body.rows.length).toBeGreaterThan(0);
    // Every row was rewritten to the user-bound Finlynq account.
    for (const r of body.rows) {
      expect(r.account).toBe("Brokerage");
    }
    // The classifier was actually invoked with the canonical rows.
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("routes <INVSTMTRS> .qfx through the canonical investment parser (no 400)", async () => {
    const req = buildMultipart(
      { name: "broker.qfx", content: OFX_INVESTMENT_SGML },
      "42",
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.rows.length).toBeGreaterThan(0);
    expect(mockClassify).toHaveBeenCalledTimes(1);
  });

  it("routes plain bank OFX through the legacy parseOfx (regression guard)", async () => {
    const req = buildMultipart(
      { name: "checking.ofx", content: OFX_BANK_SGML },
      "42",
    );
    const res = await POST(req);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.format).toBe("ofx");
    // Bank fixture has exactly one STMTTRN — the legacy path returns one row.
    expect(body.rows.length).toBe(1);
    expect(body.rows[0].account).toBe("Brokerage");
    expect(body.rows[0].payee).toContain("Coffee Shop");
  });

  it("preserves portfolioHolding on canonical investment rows for downstream binding", async () => {
    const req = buildMultipart(
      { name: "broker.ofx", content: OFX_INVESTMENT_SGML },
      "42",
    );
    const res = await POST(req);
    const body = await res.json();
    // Position leg carries the holding name; cash legs carry "Cash".
    const holdings = new Set<string>(
      body.rows
        .map((r: Record<string, unknown>) => r.portfolioHolding)
        .filter((h: unknown): h is string => typeof h === "string"),
    );
    expect(holdings.has("Cash")).toBe(true);
    // Apple Inc comes from <SECNAME> in the SECLIST.
    expect(holdings.has("Apple Inc")).toBe(true);
  });
});
