/**
 * Issue #64 — parser tests for the unified investment-statement import
 * pipeline (OFX/QFX/IBKR FlexQuery XML).
 *
 * Synthetic fixtures only — repo is public. Account numbers / MIDs are made
 * up.
 */

import { describe, it, expect } from "vitest";
import {
  parseOfx,
  parseOfxInvestments,
  hasInvestmentStatement,
} from "@/lib/ofx-parser";
import { parseOfxToCanonical } from "@/lib/external-import/parsers/ofx";
import { parseQfxToCanonical } from "@/lib/external-import/parsers/qfx";
import { parseIbkrFlexXmlToCanonical } from "@/lib/external-import/parsers/ibkr-flexquery-xml";
import { detectInvestmentFileFormat } from "@/lib/external-import/parsers/detect";

// ─── Fixtures ──────────────────────────────────────────────────────────────

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
<FEES>0.50
<TOTAL>-1801.50
<SUBACCTSEC>CASH
<SUBACCTFUND>CASH
</INVBUY>
<BUYTYPE>BUY
</BUYSTOCK>
<SELLSTOCK>
<INVSELL>
<INVTRAN>
<FITID>SELL-AAPL-002
<DTTRADE>20260201
</INVTRAN>
<SECID>
<UNIQUEID>AAPL
<UNIQUEIDTYPE>TICKER
</SECID>
<UNITS>5
<UNITPRICE>200.00
<COMMISSION>1.00
<TOTAL>999.00
<SUBACCTSEC>CASH
<SUBACCTFUND>CASH
</INVSELL>
<SELLTYPE>SELL
</SELLSTOCK>
<INCOME>
<INVTRAN>
<FITID>DIV-AAPL-003
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
<INVBANKTRAN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20260105
<TRNAMT>500.00
<FITID>DEP-001
<NAME>ACH Deposit
</STMTTRN>
<SUBACCTFUND>CASH
</INVBANKTRAN>
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

const QFX_BANK = `OFXHEADER:100
DATA:OFXSGML
VERSION:103
SECURITY:NONE
ENCODING:USASCII
CHARSET:1252
COMPRESSION:NONE
OLDFILEUID:NONE
NEWFILEUID:NONE

<OFX>
<SIGNONMSGSRSV1>
<SONRS>
<STATUS>
<CODE>0
<SEVERITY>INFO
</STATUS>
<DTSERVER>20260301120000
<LANGUAGE>ENG
<INTU.BID>00000
<INTU.USERID>nobody
</SONRS>
</SIGNONMSGSRSV1>
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

const IBKR_FLEX_XML = `<?xml version="1.0" encoding="UTF-8"?>
<FlexQueryResponse queryName="MyQuery" type="AF">
<FlexStatements count="1">
<FlexStatement accountId="U1234567" fromDate="20260101" toDate="20260301" period="LastMonth" whenGenerated="20260301;120000">
<AccountInformation accountId="U1234567" acctAlias="Personal" currency="USD" name="Test User" />
<CashTransactions>
<CashTransaction accountId="U1234567" dateTime="20260105" currency="USD" symbol="" type="Deposits/Withdrawals" amount="500.00" description="Wire deposit" actionID="A001" />
<CashTransaction accountId="U1234567" dateTime="20260205" currency="USD" symbol="AAPL" type="Dividends" amount="2.40" description="AAPL DIVIDEND" actionID="A002" />
<CashTransaction accountId="U1234567" dateTime="20260205" currency="USD" symbol="AAPL" type="Withholding Tax" amount="-0.36" description="WTAX" actionID="A002" />
<CashTransaction accountId="U1234567" dateTime="20260205" currency="USD" symbol="AAPL" type="Withholding Tax" amount="0.36" description="WTAX cancel" actionID="A002" />
</CashTransactions>
<Trades>
<Trade accountId="U1234567" dateTime="20260115;093000" currency="USD" assetCategory="STK" symbol="AAPL" description="AAPL" quantity="10" tradePrice="180.00" netCash="-1801.00" buySell="BUY" ibCommission="-1.00" tradeID="T001" />
<Trade accountId="U1234567" dateTime="20260116;093000" currency="USD" assetCategory="CASH" symbol="EUR.USD" description="EUR/USD" quantity="500" tradePrice="1.10" netCash="-550.00" buySell="BUY" ibCommission="-2.00" tradeID="T002" />
</Trades>
<OpenPositions>
<OpenPosition accountId="U1234567" symbol="AAPL" assetCategory="STK" position="10" currency="USD" />
</OpenPositions>
<FxTranslations>
</FxTranslations>
</FlexStatement>
</FlexStatements>
</FlexQueryResponse>`;

// ─── ofx-parser.ts (extended) ──────────────────────────────────────────────

describe("hasInvestmentStatement", () => {
  it("returns true when INVSTMTRS is present", () => {
    expect(hasInvestmentStatement(OFX_INVESTMENT_SGML)).toBe(true);
  });
  it("returns false for plain bank QFX", () => {
    expect(hasInvestmentStatement(QFX_BANK)).toBe(false);
  });
});

describe("parseOfxInvestments", () => {
  it("returns one statement with the expected entry kinds", () => {
    const stmts = parseOfxInvestments(OFX_INVESTMENT_SGML);
    expect(stmts).toHaveLength(1);
    const s = stmts[0];
    expect(s.account.brokerId).toBe("example.com");
    expect(s.account.accountId).toBe("1234567890");
    expect(s.currency).toBe("USD");
    const kinds = s.entries.map((e) => e.kind).sort();
    expect(kinds).toEqual(["income", "trade", "trade", "transfer"]);
    expect(s.availCash).toBe(1234.56);
  });

  it("parses BUYSTOCK and SELLSTOCK with TICKER + commission + units", () => {
    const stmts = parseOfxInvestments(OFX_INVESTMENT_SGML);
    const trades = stmts[0].entries.filter((e) => e.kind === "trade");
    const buy = trades.find((t) => t.kind === "trade" && t.side === "BUY");
    const sell = trades.find((t) => t.kind === "trade" && t.side === "SELL");
    expect(buy && buy.kind === "trade" && buy.ticker).toBe("AAPL");
    expect(buy && buy.kind === "trade" && buy.units).toBe(10);
    expect(buy && buy.kind === "trade" && buy.unitPrice).toBe(180);
    expect(buy && buy.kind === "trade" && buy.commission).toBe(1);
    expect(buy && buy.kind === "trade" && buy.fees).toBe(0.5);
    expect(buy && buy.kind === "trade" && buy.total).toBe(-1801.5);
    expect(sell && sell.kind === "trade" && sell.units).toBe(5);
    expect(sell && sell.kind === "trade" && sell.total).toBe(999);
  });

  it("looks up the security display name from SECLIST", () => {
    const stmts = parseOfxInvestments(OFX_INVESTMENT_SGML);
    const buy = stmts[0].entries.find((e) => e.kind === "trade" && e.side === "BUY");
    expect(buy && buy.kind === "trade" && buy.secName).toBe("Apple Inc");
  });

  it("classifies INCOME blocks with their incomeType", () => {
    const stmts = parseOfxInvestments(OFX_INVESTMENT_SGML);
    const income = stmts[0].entries.find((e) => e.kind === "income");
    expect(income).toBeDefined();
    if (income && income.kind === "income") {
      expect(income.incomeType).toBe("DIV");
      expect(income.ticker).toBe("AAPL");
      expect(income.total).toBe(2.4);
    }
  });

  it("parses INVBANKTRAN as a transfer entry with no security", () => {
    const stmts = parseOfxInvestments(OFX_INVESTMENT_SGML);
    const tx = stmts[0].entries.find(
      (e) => e.kind === "transfer" && e.subKind === "INVBANKTRAN",
    );
    expect(tx).toBeDefined();
    if (tx && tx.kind === "transfer") {
      expect(tx.total).toBe(500);
      expect(tx.ticker).toBe("");
      expect(tx.memo).toBe("ACH Deposit");
    }
  });
});

describe("parseOfx (bank/CC backward compatibility)", () => {
  it("still parses QFX bank statements unchanged", () => {
    const r = parseOfx(QFX_BANK);
    expect(r.transactions).toHaveLength(1);
    expect(r.transactions[0].fitId).toBe("TXN001");
    expect(r.transactions[0].amount).toBe(-50);
    expect(r.account.bankId).toBe("123456789");
    expect(r.currency).toBe("CAD");
  });
});

// ─── canonical emitters ─────────────────────────────────────────────────────

describe("parseOfxToCanonical (investment)", () => {
  it("emits format=ofx and a single brokerage external account", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    expect(r.format).toBe("ofx");
    const inv = r.externalAccounts.find((a) => a.isInvestment);
    expect(inv).toBeDefined();
    expect(inv!.type).toBe("Brokerage");
    expect(inv!.currency).toBe("USD");
    expect(inv!.externalId).toMatch(/^ofx:invacct:example\.com:1234567890$/);
  });

  it("emits paired BUY rows: cash leg + position leg with same linkId", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    const buyCash = r.rows.find(
      (row) => row.fitId === "BUY-AAPL-001:cash",
    );
    const buyPos = r.rows.find(
      (row) => row.fitId === "BUY-AAPL-001:position",
    );
    expect(buyCash).toBeDefined();
    expect(buyPos).toBeDefined();
    expect(buyCash!.linkId).toBeDefined();
    expect(buyCash!.linkId).toBe(buyPos!.linkId);
    // Cash leg uses TOTAL directly (signed in OFX — negative for buy).
    expect(buyCash!.amount).toBe(-1801.5);
    expect(buyCash!.portfolioHolding).toBe("Cash");
    // Position leg: qty positive on BUY (per WP convention).
    expect(buyPos!.quantity).toBe(10);
    expect(buyPos!.portfolioHolding).toBe("Apple Inc");
  });

  it("emits paired SELL rows with negative qty on the position leg", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    const sellPos = r.rows.find(
      (row) => row.fitId === "SELL-AAPL-002:position",
    );
    expect(sellPos!.quantity).toBe(-5);
  });

  it("emits a separate negative cash row for COMMISSION + FEES", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    const comm = r.rows.find((row) => row.fitId === "BUY-AAPL-001:commission");
    const fees = r.rows.find((row) => row.fitId === "BUY-AAPL-001:fees");
    expect(comm).toBeDefined();
    expect(comm!.amount).toBe(-1);
    expect(comm!.portfolioHolding).toBe("Cash");
    expect(comm!.tags).toContain("trade-link:");
    expect(fees).toBeDefined();
    expect(fees!.amount).toBe(-0.5);
  });

  it("emits an INCOME row with ticker in the payee, holding=Cash", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    const div = r.rows.find((row) => row.fitId === "DIV-AAPL-003");
    expect(div).toBeDefined();
    expect(div!.payee).toContain("DIV");
    expect(div!.payee).toContain("AAPL");
    expect(div!.amount).toBe(2.4);
    expect(div!.portfolioHolding).toBe("Cash");
  });

  it("emits an INVBANKTRAN row with no quantity", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    const dep = r.rows.find((row) => row.fitId === "DEP-001");
    expect(dep).toBeDefined();
    expect(dep!.quantity).toBeUndefined();
    expect(dep!.amount).toBe(500);
    expect(dep!.portfolioHolding).toBe("Cash");
  });

  it("tags every emitted row with source:ofx", () => {
    const r = parseOfxToCanonical(OFX_INVESTMENT_SGML, "ofx");
    for (const row of r.rows) {
      expect(row.tags ?? "").toContain("source:ofx");
    }
  });

  it("produces no rows for a plain bank QFX (investment-only emitter)", () => {
    // parseOfxToCanonical emits bank-CC rows too, so a bank QFX file should
    // produce ONE external account + bank transactions but NO investment rows.
    const r = parseOfxToCanonical(QFX_BANK, "qfx");
    expect(r.externalAccounts.some((a) => a.isInvestment)).toBe(false);
    expect(r.rows.length).toBeGreaterThan(0);
    for (const row of r.rows) {
      expect(row.tags).toContain("source:qfx");
      expect(row.account).toMatch(/^ofx:acct:/);
    }
  });
});

describe("parseQfxToCanonical", () => {
  it("emits source:qfx tag (delegating to OFX emitter)", () => {
    const r = parseQfxToCanonical(QFX_BANK);
    expect(r.format).toBe("qfx");
    for (const row of r.rows) {
      expect(row.tags).toContain("source:qfx");
    }
  });
});

describe("parseIbkrFlexXmlToCanonical", () => {
  it("emits format=ibkr-xml and per-currency external accounts", () => {
    const r = parseIbkrFlexXmlToCanonical(IBKR_FLEX_XML);
    expect(r.format).toBe("ibkr-xml");
    const usd = r.externalAccounts.find((a) => a.currency === "USD");
    const eur = r.externalAccounts.find((a) => a.currency === "EUR");
    expect(usd).toBeDefined();
    // EUR sleeve created from the forex pair leg.
    expect(eur).toBeDefined();
  });

  it("nets self-cancelling withholding-tax actionId triplets to zero", () => {
    const r = parseIbkrFlexXmlToCanonical(IBKR_FLEX_XML);
    // The two cancelling WTAX rows (-0.36 + 0.36) on the same actionId
    // should drop entirely, leaving just the dividend.
    const wtaxRows = r.rows.filter((row) => row.payee.includes("Withholding"));
    expect(wtaxRows).toHaveLength(0);
    const divs = r.rows.filter((row) => row.payee.includes("Dividends"));
    expect(divs).toHaveLength(1);
  });

  it("emits paired buy rows for STK trades", () => {
    const r = parseIbkrFlexXmlToCanonical(IBKR_FLEX_XML);
    const cashLeg = r.rows.find(
      (row) => row.payee === "BUY AAPL" && row.portfolioHolding === "Cash",
    );
    const positionLeg = r.rows.find(
      (row) => row.payee === "BUY AAPL" && row.portfolioHolding === "AAPL",
    );
    expect(cashLeg).toBeDefined();
    expect(positionLeg).toBeDefined();
    expect(cashLeg!.linkId).toBe(positionLeg!.linkId);
    expect(positionLeg!.quantity).toBe(10);
  });

  it("emits same-account FX conversion for assetCategory=CASH trades", () => {
    const r = parseIbkrFlexXmlToCanonical(IBKR_FLEX_XML);
    const fxRows = r.rows.filter((row) => row.payee.startsWith("FX EUR.USD"));
    expect(fxRows).toHaveLength(2);
    expect(fxRows[0].linkId).toBe(fxRows[1].linkId);
    // Currencies on the two legs differ (one EUR, one USD).
    const ccys = new Set(fxRows.map((r) => r.currency));
    expect(ccys.size).toBe(2);
    // Both legs route through the per-account Cash sleeve.
    for (const row of fxRows) {
      expect(row.portfolioHolding).toBe("Cash");
    }
  });

  it("tags every emitted row with source:ibkr-xml", () => {
    const r = parseIbkrFlexXmlToCanonical(IBKR_FLEX_XML);
    for (const row of r.rows) {
      expect(row.tags).toContain("source:ibkr-xml");
    }
  });
});

// ─── format detector ────────────────────────────────────────────────────────

describe("detectInvestmentFileFormat", () => {
  it("classifies SGML OFX with OFXHEADER:100 as ofx-sgml", () => {
    expect(detectInvestmentFileFormat("statement.ofx", OFX_INVESTMENT_SGML).format).toBe("ofx-sgml");
  });
  it("classifies QFX-extension files as qfx regardless of payload", () => {
    expect(detectInvestmentFileFormat("statement.qfx", QFX_BANK).format).toBe("qfx");
  });
  it("classifies IBKR FlexQuery XML by root element", () => {
    expect(detectInvestmentFileFormat("flex.xml", IBKR_FLEX_XML).format).toBe("ibkr-flex");
  });
  it("classifies XML OFX as ofx-xml", () => {
    const xmlOfx = `<?xml version="1.0"?><OFX><BANKMSGSRSV1></BANKMSGSRSV1></OFX>`;
    expect(detectInvestmentFileFormat("statement.xml", xmlOfx).format).toBe("ofx-xml");
  });
  it("returns unknown for unrelated XML", () => {
    expect(detectInvestmentFileFormat("data.xml", `<?xml version="1.0"?><Foo/>`).format).toBe("unknown");
  });
});
