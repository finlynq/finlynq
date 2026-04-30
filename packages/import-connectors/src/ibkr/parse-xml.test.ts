import { describe, expect, it } from "vitest";
import { findElements, parseAttributes, parseFlexXml } from "./parse-xml";

describe("parseAttributes", () => {
  it("extracts attribute pairs", () => {
    const attrs = parseAttributes(' accountId="U1" currency="USD" amount="-100.00"');
    expect(attrs).toEqual({ accountId: "U1", currency: "USD", amount: "-100.00" });
  });

  it("decodes XML entities", () => {
    const attrs = parseAttributes(' description="A &amp; B &lt;C&gt;"');
    expect(attrs.description).toBe("A & B <C>");
  });
});

describe("findElements", () => {
  it("finds self-closing tags", () => {
    const xml = `<X a="1"/><X a="2"/>`;
    const out = findElements(xml, "X");
    expect(out).toEqual([{ a: "1" }, { a: "2" }]);
  });

  it("finds opening tags too", () => {
    const xml = `<Foo a="1"><Bar/></Foo>`;
    expect(findElements(xml, "Foo")).toEqual([{ a: "1" }]);
  });
});

describe("parseFlexXml", () => {
  it("walks <FlexStatement> blocks and groups rows by sub-account", () => {
    const xml = `
<FlexQueryResponse>
  <FlexStatements>
    <FlexStatement accountId="U1" fromDate="20260101" toDate="20260131">
      <AccountInformation accountId="U1" name="A" currency="USD"/>
      <CashTransactions>
        <CashTransaction accountId="U1" currency="USD" dateTime="20260105;120000" amount="100.00" type="Deposits/Withdrawals" description="d1"/>
      </CashTransactions>
      <Trades>
        <Trade accountId="U1" currency="USD" assetCategory="STK" symbol="AAPL" tradeDate="20260115" quantity="5" tradePrice="180" netCash="-901" buySell="BUY" ibCommission="-1"/>
      </Trades>
    </FlexStatement>
    <FlexStatement accountId="U2">
      <AccountInformation accountId="U2" name="B" currency="CAD"/>
      <CashTransactions>
        <CashTransaction accountId="U2" currency="CAD" dateTime="20260106;120000" amount="50.00" type="Deposits/Withdrawals" description="d2"/>
      </CashTransactions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;
    const out = parseFlexXml(xml);
    expect(out.statements).toHaveLength(2);
    const u1 = out.statements.find((s) => s.accountId === "U1")!;
    const u2 = out.statements.find((s) => s.accountId === "U2")!;
    expect(u1.cashTransactions).toHaveLength(1);
    expect(u1.trades).toHaveLength(1);
    expect(u1.trades[0].symbol).toBe("AAPL");
    expect(u1.trades[0].buySell).toBe("BUY");
    expect(u1.trades[0].quantity).toBe(5);
    expect(u1.fromDate).toBe("2026-01-01");
    expect(u1.toDate).toBe("2026-01-31");
    expect(u2.cashTransactions[0].currency).toBe("CAD");
  });

  it("normalizes the IB compact dateTime format", () => {
    const xml = `
<FlexQueryResponse>
  <FlexStatements>
    <FlexStatement accountId="U1">
      <AccountInformation accountId="U1" name="A" currency="USD"/>
      <CashTransactions>
        <CashTransaction accountId="U1" currency="USD" dateTime="20260105;120000" amount="1" type="Other" description="d"/>
      </CashTransactions>
    </FlexStatement>
  </FlexStatements>
</FlexQueryResponse>`;
    const out = parseFlexXml(xml);
    expect(out.statements[0].cashTransactions[0].date).toBe("2026-01-05");
  });
});
