import { describe, it, expect } from "vitest";
import { parseOfx } from "@/lib/ofx-parser";

const BANK_OFX = `OFXHEADER:100
DATA:OFXSGML
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<CURDEF>USD
<BANKACCTFROM>
<BANKID>123456789
<ACCTID>9876543210
<ACCTTYPE>CHECKING
</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240115120000
<TRNAMT>-50.00
<FITID>TXN001
<NAME>Coffee Shop
<MEMO>Morning coffee
</STMTTRN>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240120
<TRNAMT>3000.00
<FITID>TXN002
<NAME>Employer Inc
</STMTTRN>
</BANKTRANLIST>
<LEDGERBAL>
<BALAMT>5432.10
<DTASOF>20240120
</LEDGERBAL>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>`;

const CC_OFX = `<OFX>
<CREDITCARDMSGSRSV1>
<CCSTMTTRNRS>
<CCSTMTRS>
<CURDEF>CAD
<CCACCTFROM>
<ACCTID>4111111111111111
</CCACCTFROM>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240201
<TRNAMT>-25.99
<FITID>CC001
<NAME>Amazon
</STMTTRN>
</BANKTRANLIST>
</CCSTMTRS>
</CCSTMTTRNRS>
</CREDITCARDMSGSRSV1>
</OFX>`;

describe("parseOfx", () => {
  describe("bank statements", () => {
    it("parses transactions from a bank OFX file", () => {
      const result = parseOfx(BANK_OFX);
      expect(result.transactions).toHaveLength(2);
    });

    it("extracts correct transaction fields", () => {
      const result = parseOfx(BANK_OFX);
      const txn = result.transactions[0];
      expect(txn.date).toBe("2024-01-15");
      expect(txn.amount).toBe(-50);
      expect(txn.payee).toBe("Coffee Shop");
      expect(txn.fitId).toBe("TXN001");
      expect(txn.type).toBe("DEBIT");
    });

    it("extracts account info", () => {
      const result = parseOfx(BANK_OFX);
      expect(result.account.bankId).toBe("123456789");
      expect(result.account.accountId).toBe("9876543210");
      expect(result.account.accountType).toBe("CHECKING");
    });

    it("extracts balance", () => {
      const result = parseOfx(BANK_OFX);
      expect(result.balanceAmount).toBe(5432.10);
      expect(result.balanceDate).toBe("2024-01-20");
    });

    it("extracts currency", () => {
      const result = parseOfx(BANK_OFX);
      expect(result.currency).toBe("USD");
    });

    it("computes date range from sorted transactions", () => {
      const result = parseOfx(BANK_OFX);
      expect(result.dateRange).toEqual({
        start: "2024-01-15",
        end: "2024-01-20",
      });
    });

    it("sorts transactions by date", () => {
      const result = parseOfx(BANK_OFX);
      const dates = result.transactions.map((t) => t.date);
      expect(dates).toEqual([...dates].sort());
    });
  });

  describe("credit card statements", () => {
    it("parses credit card OFX", () => {
      const result = parseOfx(CC_OFX);
      expect(result.transactions).toHaveLength(1);
      expect(result.transactions[0].amount).toBe(-25.99);
      expect(result.transactions[0].fitId).toBe("CC001");
      expect(result.account.accountId).toBe("4111111111111111");
      expect(result.currency).toBe("CAD");
    });
  });

  describe("edge cases", () => {
    it("returns empty result for invalid input", () => {
      const result = parseOfx("not an OFX file at all");
      expect(result.transactions).toHaveLength(0);
      expect(result.balanceAmount).toBeNull();
    });

    it("strips SGML headers before <OFX> tag", () => {
      const result = parseOfx(BANK_OFX);
      expect(result.transactions.length).toBeGreaterThan(0);
    });

    it("handles OFX dates with timezone brackets", () => {
      const ofx = `<OFX><BANKMSGSRSV1><STMTTRNRS><STMTRS>
<CURDEF>CAD
<BANKACCTFROM><BANKID>1<ACCTID>2<ACCTTYPE>CHECKING</BANKACCTFROM>
<BANKTRANLIST>
<STMTTRN><TRNTYPE>DEBIT<DTPOSTED>20240301120000[0:GMT]<TRNAMT>-10.00<FITID>TZ1<NAME>Test</STMTTRN>
</BANKTRANLIST>
</STMTRS></STMTTRNRS></BANKMSGSRSV1></OFX>`;
      const result = parseOfx(ofx);
      expect(result.transactions[0].date).toBe("2024-03-01");
    });

    it("extracts fitId for deduplication", () => {
      const result = parseOfx(BANK_OFX);
      const fitIds = result.transactions.map((t) => t.fitId);
      expect(fitIds).toContain("TXN001");
      expect(fitIds).toContain("TXN002");
      // All unique
      expect(new Set(fitIds).size).toBe(fitIds.length);
    });
  });
});
