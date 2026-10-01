import {
  buildAccountSections,
  sumNetWorth,
  accountMetaLine,
  accountDisplayName,
} from "../lib/account-sections";
import { EMPTY_DROPDOWN_ORDER } from "../lib/sort-helpers";
import type { AccountBalance } from "../../../shared/types";

function acct(p: Partial<AccountBalance> & { accountId: number }): AccountBalance {
  return {
    accountName: `Acct ${p.accountId}`,
    accountType: "A",
    accountGroup: "",
    currency: "USD",
    balance: 0,
    convertedBalance: 0,
    displayCurrency: "USD",
    ...p,
  };
}

const balances: AccountBalance[] = [
  acct({ accountId: 1, accountName: "Visa", accountType: "L", accountGroup: "Cards", convertedBalance: -500 }),
  acct({ accountId: 2, accountName: "Chequing", accountGroup: "Banking", convertedBalance: 1000 }),
  acct({ accountId: 3, accountName: "Savings", accountGroup: "banking", convertedBalance: 2000 }),
  acct({ accountId: 4, accountName: "Old savings", accountGroup: "Banking", convertedBalance: 300, archived: true }),
  acct({ accountId: 5, accountName: "Brokerage", accountGroup: "Investments", convertedBalance: 7000 }),
  acct({ accountId: 6, accountName: "Loan", accountType: "L", accountGroup: "", convertedBalance: -100 }),
];

describe("buildAccountSections", () => {
  it("sections by type first (Assets, then Liabilities), then by group", () => {
    const sections = buildAccountSections(balances, { A: ["Investments"], L: [] }, EMPTY_DROPDOWN_ORDER);
    expect(sections.map((s) => [s.accountType, s.title, s.typeHeader])).toEqual([
      ["A", "Investments", "Assets"],
      ["A", "Banking", null],
      ["L", "Cards", "Liabilities"],
      ["L", "Other", null],
    ]);
  });

  it("hides archived rows unless asked, and merges group spellings case-insensitively", () => {
    const hidden = buildAccountSections(balances, { A: [], L: [] }, EMPTY_DROPDOWN_ORDER);
    const banking = hidden.find((s) => s.title === "Banking")!;
    expect(banking.data.map((b) => b.accountId)).toEqual([2, 3]);

    const shown = buildAccountSections(balances, { A: [], L: [] }, EMPTY_DROPDOWN_ORDER, true);
    expect(shown.find((s) => s.title === "Banking")!.data.map((b) => b.accountId)).toEqual([2, 4, 3]);
  });
});

describe("sumNetWorth", () => {
  it("includes archived accounts", () => {
    expect(sumNetWorth(balances)).toBe(-500 + 1000 + 2000 + 300 + 7000 - 100);
  });
});

describe("accountDisplayName", () => {
  it("prefers the alias, then name, then Account #id", () => {
    expect(accountDisplayName({ accountId: 1, accountName: "Visa", alias: "Travel card" })).toBe("Travel card");
    expect(accountDisplayName({ accountId: 1, accountName: "Visa", alias: null })).toBe("Visa");
    expect(accountDisplayName({ accountId: 9, accountName: null, alias: null })).toBe("Account #9");
  });
});

describe("accountMetaLine", () => {
  it("skips an empty group instead of rendering a leading separator", () => {
    expect(accountMetaLine({ group: "", currency: "USD", type: "A" })).toBe("USD");
    expect(accountMetaLine({ group: "Cards", currency: "CAD", type: "L", archived: true })).toBe(
      "Cards · CAD · Liability · Archived",
    );
  });
});
