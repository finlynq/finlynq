import { describe, expect, it } from "vitest";
import { parseFlexCsv } from "./parse-csv";

describe("parseFlexCsv", () => {
  it("groups rows by section name and routes data into IbkrStatement", () => {
    const csv = `Account Information,Header,Account,Name,Currency
Account Information,Data,U1234567,John Doe,USD
Cash Transactions,Header,Account,Currency,Symbol,Settle Date,Amount,Type,Description,Action ID
Cash Transactions,Data,U1234567,USD,AAPL,2026-02-01,2.50,Dividends,AAPL CASH DIV,DIV-1
Cash Transactions,Data,U1234567,USD,,2026-01-05,-100.00,Deposits/Withdrawals,WIRE OUT,DEP-1
Trades,Header,Account,Currency,Asset Category,Symbol,Date/Time,Quantity,T. Price,Proceeds,Code,Comm/Fee,Trade ID
Trades,Data,U1234567,USD,STK,AAPL,"2026-01-15, 09:30:00",10,180,-1801,BUY,-1.00,T1
Open Positions,Header,Account,Symbol,Asset Category,Quantity,Currency
Open Positions,Data,U1234567,AAPL,STK,10,USD
`;
    const out = parseFlexCsv(csv);
    expect(out.statements).toHaveLength(1);
    const stmt = out.statements[0];
    expect(stmt.accountId).toBe("U1234567");
    expect(stmt.cashTransactions).toHaveLength(2);
    expect(stmt.cashTransactions[0].type).toBe("Dividends");
    expect(stmt.cashTransactions[0].symbol).toBe("AAPL");
    expect(stmt.cashTransactions[0].amount).toBe(2.5);
    expect(stmt.cashTransactions[1].symbol).toBe("");
    expect(stmt.trades).toHaveLength(1);
    expect(stmt.trades[0].symbol).toBe("AAPL");
    expect(stmt.trades[0].buySell).toBe("BUY");
    expect(stmt.openPositions).toHaveLength(1);
    expect(stmt.openPositions[0].symbol).toBe("AAPL");
  });

  it("re-parses a Header row mid-section and switches the column projection", () => {
    const csv = `Cash Transactions,Header,Account,Currency,Settle Date,Amount,Type,Description
Cash Transactions,Data,U1,USD,2026-01-01,1.00,Other,first
Cash Transactions,Header,Account,Currency,Settle Date,Amount,Type,Description,Action ID
Cash Transactions,Data,U1,USD,2026-01-02,2.00,Other,second,A-2
`;
    const out = parseFlexCsv(csv);
    expect(out.statements[0].cashTransactions).toHaveLength(2);
    expect(out.statements[0].cashTransactions[0].actionId).toBeUndefined();
    expect(out.statements[0].cashTransactions[1].actionId).toBe("A-2");
  });

  it("handles parens-wrapped negatives and thousand separators in numbers", () => {
    const csv = `Account Information,Header,Account,Name,Currency
Account Information,Data,U1,X,USD
Cash Transactions,Header,Account,Currency,Settle Date,Amount,Type,Description
Cash Transactions,Data,U1,USD,2026-01-01,"(1,234.56)",Other,d
`;
    const out = parseFlexCsv(csv);
    expect(out.statements[0].cashTransactions[0].amount).toBe(-1234.56);
  });
});
