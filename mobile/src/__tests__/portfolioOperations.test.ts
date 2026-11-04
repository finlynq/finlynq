import {
  OP_ORDER,
  OP_CONFIGS,
  getOpConfig,
  initialOpState,
  type OpState,
  type OpContext,
} from "../lib/portfolio/operations";
import type {
  AccountBalance,
  PortfolioHoldingRow,
  Category,
  BuyOpBody,
  SellOpBody,
  IncomeExpenseOpBody,
  FxConversionOpBody,
} from "../../../shared/types";

function state(p: Partial<OpState> = {}): OpState {
  return { ...initialOpState(), ...p };
}

const accounts: AccountBalance[] = [
  {
    accountId: 1,
    accountName: "RRSP",
    accountType: "A",
    accountGroup: "Investments",
    currency: "USD",
    balance: 0,
    convertedBalance: 0,
    displayCurrency: "CAD",
    isInvestment: true,
  },
];
const nvda: PortfolioHoldingRow = {
  id: 10,
  accountId: 1,
  name: "Nvidia",
  symbol: "NVDA",
  currency: "USD",
  isCrypto: 0,
  isCash: false,
  note: "",
  currentShares: 40,
  accountName: "RRSP",
};
const usdSleeve: PortfolioHoldingRow = { ...nvda, id: 11, symbol: null, isCash: true };
const categories: Category[] = [{ id: 5, type: "I", group: "Investing", name: "Dividends", note: "" }];

const ctxNoSleeve: OpContext = { accounts, holdings: [nvda], categories };
const ctxWithSleeve: OpContext = { accounts, holdings: [nvda, usdSleeve], categories };

describe("registry shape", () => {
  it("exposes 8 ops in display order", () => {
    expect(OP_ORDER).toHaveLength(8);
    expect(Object.keys(OP_CONFIGS).sort()).toEqual(
      [...OP_ORDER].sort()
    );
  });
});

describe("buy", () => {
  const cfg = getOpConfig("buy");
  it("validates required fields", () => {
    expect(cfg.validate(state(), ctxNoSleeve)).toBeTruthy();
    expect(
      cfg.validate(state({ amount: "1000", accountId: 1, holdingId: 10, qty: "3" }), ctxNoSleeve)
    ).toBeNull();
  });
  it("builds the POST body", () => {
    const body = cfg.toBody(
      state({ amount: "1000", accountId: 1, holdingId: 10, qty: "3", payee: " Broker " }),
      ctxNoSleeve
    ) as BuyOpBody;
    expect(body.accountId).toBe(1);
    expect(body.holdingId).toBe(10);
    expect(body.qty).toBe(3);
    expect(body.totalCost).toBe(1000);
    expect(body.payee).toBe("Broker");
  });
  it("prefills only when the loaded op matches", () => {
    expect(cfg.prefillFromLoad({ op: "sell", primaryTxId: 1 })).toEqual({});
    const patch = cfg.prefillFromLoad({
      op: "buy",
      primaryTxId: 9,
      accountId: 1,
      holdingId: 10,
      qty: 3,
      totalCost: 1500,
    });
    expect(patch.amount).toBe("1500");
    expect(patch.holdingId).toBe(10);
  });
  it("flags a missing cash sleeve, clears once present", () => {
    const s = state({ accountId: 1, holdingId: 10, qty: "1", amount: "10" });
    expect(cfg.needsCashSleeve?.(s, ctxNoSleeve)).toEqual({ accountId: 1, currency: "USD" });
    expect(cfg.needsCashSleeve?.(s, ctxWithSleeve)).toBeNull();
  });
});

describe("sell", () => {
  const cfg = getOpConfig("sell");
  it("requires lots when the picker is on", () => {
    const base = state({ amount: "100", accountId: 1, holdingId: 10, qty: "1", useLots: true });
    expect(cfg.validate(base, ctxWithSleeve)).toBeTruthy();
    expect(
      cfg.validate({ ...base, lotSelection: [{ lotId: 1, qty: 1 }] }, ctxWithSleeve)
    ).toBeNull();
  });
  it("sends lotSelection only when lots are picked", () => {
    const withLots = cfg.toBody(
      state({
        amount: "100",
        accountId: 1,
        holdingId: 10,
        qty: "1",
        useLots: true,
        lotSelection: [{ lotId: 2, qty: 1 }],
      }),
      ctxWithSleeve
    ) as SellOpBody;
    expect(withLots.lotSelection).toEqual({ method: "SPECIFIC", lots: [{ lotId: 2, qty: 1 }] });
    const fifo = cfg.toBody(
      state({ amount: "100", accountId: 1, holdingId: 10, qty: "1", useLots: false }),
      ctxWithSleeve
    ) as SellOpBody;
    expect(fifo.lotSelection).toBeUndefined();
  });
});

describe("income-expense", () => {
  const cfg = getOpConfig("income-expense");
  it("signs the amount by the expense toggle", () => {
    const income = cfg.toBody(
      state({ amount: "50", accountId: 1, currency: "USD", isExpense: false }),
      ctxWithSleeve
    ) as IncomeExpenseOpBody;
    expect(income.amount).toBe(50);
    const expense = cfg.toBody(
      state({ amount: "50", accountId: 1, currency: "USD", isExpense: true }),
      ctxWithSleeve
    ) as IncomeExpenseOpBody;
    expect(expense.amount).toBe(-50);
  });
  it("derives the expense toggle from a negative loaded amount", () => {
    expect(cfg.prefillFromLoad({ op: "income-expense", primaryTxId: 1, amount: -12 }).isExpense).toBe(true);
    expect(cfg.prefillFromLoad({ op: "income-expense", primaryTxId: 1, amount: 12 }).isExpense).toBe(false);
  });
  it("a preset entry type lets the server choose the category, ignoring a picked one", () => {
    const body = cfg.toBody(
      state({ amount: "50", accountId: 1, currency: "USD", incomeType: "dividend", categoryId: 9 }),
      ctxWithSleeve
    ) as IncomeExpenseOpBody & { incomeType?: string };
    expect(body.incomeType).toBe("dividend");
    expect(body.categoryId).toBeUndefined();
  });
  it("entry type Other sends the picked category and no preset", () => {
    const body = cfg.toBody(
      state({ amount: "50", accountId: 1, currency: "USD", incomeType: "other", categoryId: 9 }),
      ctxWithSleeve
    ) as IncomeExpenseOpBody & { incomeType?: string };
    expect(body.incomeType).toBeUndefined();
    expect(body.categoryId).toBe(9);
  });
  it("editing keeps the row's own category rather than re-resolving a preset", () => {
    const loaded = cfg.prefillFromLoad({ op: "income-expense", primaryTxId: 1, amount: 12, categoryId: 9 });
    expect(loaded.incomeType).toBe("other");
    expect(loaded.categoryId).toBe(9);
  });
  it("a new entry starts as a dividend", () => {
    expect(initialOpState().incomeType).toBe("dividend");
  });
});

describe("fx-conversion", () => {
  const cfg = getOpConfig("fx-conversion");
  it("rejects same from/to currency", () => {
    const s = state({ accountId: 1, fromCurrency: "USD", fromAmount: "10", toCurrency: "USD", toAmount: "13" });
    expect(cfg.validate(s, ctxWithSleeve)).toMatch(/differ/i);
  });
  it("omits a zero fee", () => {
    const body = cfg.toBody(
      state({ accountId: 1, fromCurrency: "USD", fromAmount: "10", toCurrency: "CAD", toAmount: "13", feeAmount: "0" }),
      ctxWithSleeve
    ) as FxConversionOpBody;
    expect(body.feeAmount).toBeUndefined();
    expect(body.fromCurrency).toBe("USD");
    expect(body.toCurrency).toBe("CAD");
  });
});

describe("transfer / swap / deposit / withdrawal validate", () => {
  it("transfer needs distinct accounts", () => {
    const cfg = getOpConfig("transfer");
    expect(cfg.validate(state({ sourceAccountId: 1, destAccountId: 1, holdingId: 10, qty: "1" }), ctxWithSleeve)).toMatch(/differ/i);
  });
  it("swap needs distinct holdings", () => {
    const cfg = getOpConfig("swap");
    const s = state({
      accountId: 1,
      sourceHoldingId: 10,
      sourceQty: "1",
      sourceProceeds: "5",
      destHoldingId: 10,
      destQty: "1",
      destCost: "5",
    });
    expect(cfg.validate(s, ctxWithSleeve)).toMatch(/differ/i);
  });
  it("deposit + withdrawal build amount bodies", () => {
    const dep = getOpConfig("deposit").toBody(
      state({ amount: "500", sourceAccountId: 2, destAccountId: 1 }),
      ctxWithSleeve
    );
    expect((dep as { amount: number }).amount).toBe(500);
    const wd = getOpConfig("withdrawal").toBody(
      state({ amount: "200", sourceAccountId: 1, destAccountId: 2 }),
      ctxWithSleeve
    );
    expect((wd as { amount: number }).amount).toBe(200);
  });
});
