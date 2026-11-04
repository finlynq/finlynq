// Config-driven registry for the 8 portfolio operations. PURE + JSX-free so it
// is unit-testable; OperationFormScreen is the single renderer that interprets
// these configs (replaces porting the 8 standalone ~600-line web forms).
//
// Each OpConfig owns: the visible field list, initial state, validation, the
// POST body builder, the edit-prefill mapping, and the cash-sleeve precheck.
import type {
  AccountBalance,
  Category,
  PortfolioHoldingRow,
  PortfolioOpKey,
  PortfolioOpBody,
  OperationLoadData,
} from "../../../../shared/types";
import type { IconName } from "../../components/icon";
import { findCashSleeve } from "./holdings";

// --- Field descriptors --------------------------------------------------

type AccountKey = "accountId" | "sourceAccountId" | "destAccountId";
type HoldingKey = "holdingId" | "sourceHoldingId" | "destHoldingId";
type CurrencyKey = "currency" | "fromCurrency" | "toCurrency";
type NumberKey =
  | "qty"
  | "sourceQty"
  | "destQty"
  | "destCost"
  | "sourceProceeds"
  | "fromAmount"
  | "toAmount"
  | "feeAmount";
type TextKey = "payee" | "note" | "tags";

export type FieldSpec =
  | { kind: "account"; key: AccountKey; label: string; scope: "investment" | "nonInvestment" }
  | { kind: "holding"; key: HoldingKey; accountKey: AccountKey; label: string }
  | { kind: "relatedHolding"; accountKey: AccountKey; label: string }
  | { kind: "sleeveCurrency"; key: CurrencyKey; accountKey: AccountKey; label: string }
  | { kind: "currency"; key: CurrencyKey; label: string }
  | { kind: "number"; key: NumberKey; label: string; placeholder?: string; optional?: boolean }
  | { kind: "amount"; label: string }
  | { kind: "signToggle"; label: string }
  | { kind: "incomeType"; label: string }
  | { kind: "lotPicker"; label: string }
  | { kind: "category"; label: string }
  | { kind: "date"; label: string }
  | { kind: "text"; key: TextKey; label: string; placeholder?: string; multiline?: boolean };

// --- Form state ---------------------------------------------------------

/** Flat superset of every op's fields — numeric inputs are strings (raw text). */
export interface OpState {
  accountId: number | null;
  holdingId: number | null;
  sourceAccountId: number | null;
  destAccountId: number | null;
  sourceHoldingId: number | null;
  destHoldingId: number | null;
  relatedHoldingId: number | null;
  categoryId: number | null;
  /** Income-expense entry-type preset → server auto-categorization. */
  incomeType: "dividend" | "interest" | "fee" | "other";
  amount: string;
  qty: string;
  sourceQty: string;
  destQty: string;
  destCost: string;
  sourceProceeds: string;
  fromAmount: string;
  toAmount: string;
  feeAmount: string;
  currency: string;
  fromCurrency: string;
  toCurrency: string;
  isExpense: boolean;
  date: string;
  payee: string;
  note: string;
  tags: string;
  useLots: boolean;
  lotSelection: Array<{ lotId: number; qty: number }>;
}

export interface OpContext {
  accounts: AccountBalance[];
  holdings: PortfolioHoldingRow[];
  categories: Category[];
}

export interface OpConfig {
  key: PortfolioOpKey;
  title: string;
  submitLabel: string;
  icon: IconName;
  subtitle: string;
  fields: FieldSpec[];
  /** Big amount-card label (when the op uses the headline amount field). */
  amountLabel?: (state: OpState, ctx: OpContext) => string;
  /** First validation error, or null when the form may submit. */
  validate: (state: OpState, ctx: OpContext) => string | null;
  toBody: (state: OpState, ctx: OpContext) => PortfolioOpBody;
  /** Edit-prefill — guards `data.op === key` then maps to OpState patches. */
  prefillFromLoad: (data: OperationLoadData) => Partial<OpState>;
  /** Client-side cash-sleeve precheck (advisory; server is authority). */
  needsCashSleeve?: (state: OpState, ctx: OpContext) => { accountId: number; currency: string } | null;
}

// --- helpers ------------------------------------------------------------

function todayStr(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(
    d.getDate()
  ).padStart(2, "0")}`;
}

const num = (s: string): number => {
  const v = parseFloat(s);
  return Number.isFinite(v) ? v : 0;
};

export function initialOpState(): OpState {
  return {
    accountId: null,
    holdingId: null,
    sourceAccountId: null,
    destAccountId: null,
    sourceHoldingId: null,
    destHoldingId: null,
    relatedHoldingId: null,
    categoryId: null,
    incomeType: "dividend",
    amount: "",
    qty: "",
    sourceQty: "",
    destQty: "",
    destCost: "",
    sourceProceeds: "",
    fromAmount: "",
    toAmount: "",
    feeAmount: "",
    currency: "",
    fromCurrency: "",
    toCurrency: "",
    isExpense: false,
    date: todayStr(),
    payee: "",
    note: "",
    tags: "",
    useLots: false,
    lotSelection: [],
  };
}

const trimOrUndef = (s: string): string | undefined => (s.trim() ? s.trim() : undefined);

function holdingCurrency(ctx: OpContext, holdingId: number | null): string | null {
  if (holdingId == null) return null;
  const h = ctx.holdings.find((x) => x.id === holdingId);
  return h ? (h.currency ?? "").toUpperCase() : null;
}

// --- The 8 configs ------------------------------------------------------

const buy: OpConfig = {
  key: "buy",
  title: "Buy",
  submitLabel: "Record buy",
  icon: "add",
  subtitle: "Acquire shares",
  fields: [
    { kind: "amount", label: "Total cost" },
    { kind: "account", key: "accountId", label: "Account", scope: "investment" },
    { kind: "holding", key: "holdingId", accountKey: "accountId", label: "Holding" },
    { kind: "number", key: "qty", label: "Quantity" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "payee", label: "Payee (optional)", placeholder: "Broker name" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  amountLabel: (s, ctx) => `Total cost · ${holdingCurrency(ctx, s.holdingId) ?? "—"}`,
  validate: (s) => {
    if (num(s.amount) <= 0) return "Enter a total cost";
    if (s.accountId == null) return "Pick an account";
    if (s.holdingId == null) return "Pick a holding";
    if (num(s.qty) <= 0) return "Enter a quantity";
    return null;
  },
  toBody: (s) => ({
    accountId: s.accountId!,
    holdingId: s.holdingId!,
    qty: num(s.qty),
    totalCost: num(s.amount),
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
    tags: trimOrUndef(s.tags),
    editId: undefined,
  }),
  prefillFromLoad: (d) =>
    d.op !== "buy"
      ? {}
      : {
          accountId: d.accountId ?? null,
          holdingId: d.holdingId ?? null,
          qty: d.qty != null ? String(d.qty) : "",
          amount: d.totalCost != null ? String(d.totalCost) : "",
          date: d.date ?? todayStr(),
          payee: d.payee ?? "",
          note: d.note ?? "",
          tags: d.tags ?? "",
        },
  needsCashSleeve: (s, ctx) => {
    const ccy = holdingCurrency(ctx, s.holdingId);
    if (s.accountId == null || !ccy) return null;
    return findCashSleeve(ctx.holdings, s.accountId, ccy)
      ? null
      : { accountId: s.accountId, currency: ccy };
  },
};

const sell: OpConfig = {
  key: "sell",
  title: "Sell",
  submitLabel: "Record sell",
  icon: "minus",
  subtitle: "Dispose · lots",
  fields: [
    { kind: "amount", label: "Total proceeds" },
    { kind: "account", key: "accountId", label: "Account", scope: "investment" },
    { kind: "holding", key: "holdingId", accountKey: "accountId", label: "Holding" },
    { kind: "lotPicker", label: "Lots" },
    { kind: "number", key: "qty", label: "Quantity" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "payee", label: "Payee (optional)" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  amountLabel: (s, ctx) => `Total proceeds · ${holdingCurrency(ctx, s.holdingId) ?? "—"}`,
  validate: (s) => {
    if (num(s.amount) <= 0) return "Enter total proceeds";
    if (s.accountId == null) return "Pick an account";
    if (s.holdingId == null) return "Pick a holding";
    if (num(s.qty) <= 0) return "Enter a quantity to sell";
    if (s.useLots && s.lotSelection.length === 0)
      return "Pick at least one lot (or turn off lot selection for FIFO)";
    return null;
  },
  toBody: (s) => ({
    accountId: s.accountId!,
    holdingId: s.holdingId!,
    qty: num(s.qty),
    totalProceeds: num(s.amount),
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
    tags: trimOrUndef(s.tags),
    lotSelection:
      s.useLots && s.lotSelection.length > 0
        ? { method: "SPECIFIC", lots: s.lotSelection }
        : undefined,
  }),
  prefillFromLoad: (d) =>
    d.op !== "sell"
      ? {}
      : {
          accountId: d.accountId ?? null,
          holdingId: d.holdingId ?? null,
          qty: d.qty != null ? String(d.qty) : "",
          amount: d.totalProceeds != null ? String(d.totalProceeds) : "",
          date: d.date ?? todayStr(),
          payee: d.payee ?? "",
          note: d.note ?? "",
          tags: d.tags ?? "",
        },
  needsCashSleeve: (s, ctx) => {
    const ccy = holdingCurrency(ctx, s.holdingId);
    if (s.accountId == null || !ccy) return null;
    return findCashSleeve(ctx.holdings, s.accountId, ccy)
      ? null
      : { accountId: s.accountId, currency: ccy };
  },
};

const swap: OpConfig = {
  key: "swap",
  title: "Swap",
  submitLabel: "Record swap",
  icon: "swap",
  subtitle: "Sell + buy",
  fields: [
    { kind: "account", key: "accountId", label: "Account", scope: "investment" },
    { kind: "holding", key: "sourceHoldingId", accountKey: "accountId", label: "Sell holding" },
    { kind: "number", key: "sourceQty", label: "Quantity sold" },
    { kind: "number", key: "sourceProceeds", label: "Proceeds" },
    { kind: "holding", key: "destHoldingId", accountKey: "accountId", label: "Buy holding" },
    { kind: "number", key: "destQty", label: "Quantity bought" },
    { kind: "number", key: "destCost", label: "Cost" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  validate: (s) => {
    if (s.accountId == null) return "Pick an account";
    if (s.sourceHoldingId == null) return "Pick the holding to sell";
    if (num(s.sourceQty) <= 0) return "Enter quantity sold";
    if (num(s.sourceProceeds) <= 0) return "Enter proceeds";
    if (s.destHoldingId == null) return "Pick the holding to buy";
    if (num(s.destQty) <= 0) return "Enter quantity bought";
    if (num(s.destCost) <= 0) return "Enter cost";
    if (s.sourceHoldingId === s.destHoldingId) return "Sell and buy holdings must differ";
    return null;
  },
  toBody: (s) => ({
    accountId: s.accountId!,
    sourceHoldingId: s.sourceHoldingId!,
    sourceQty: num(s.sourceQty),
    sourceProceeds: num(s.sourceProceeds),
    destHoldingId: s.destHoldingId!,
    destQty: num(s.destQty),
    destCost: num(s.destCost),
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
  }),
  prefillFromLoad: (d) =>
    d.op !== "swap"
      ? {}
      : {
          accountId: d.accountId ?? null,
          sourceHoldingId: d.sourceHoldingId ?? null,
          sourceQty: d.sourceQty != null ? String(d.sourceQty) : "",
          sourceProceeds: d.sourceProceeds != null ? String(d.sourceProceeds) : "",
          destHoldingId: d.destHoldingId ?? null,
          destQty: d.destQty != null ? String(d.destQty) : "",
          destCost: d.destCost != null ? String(d.destCost) : "",
          date: d.date ?? todayStr(),
          note: d.note ?? "",
        },
};

const transfer: OpConfig = {
  key: "transfer",
  title: "Transfer",
  submitLabel: "Record transfer",
  icon: "transfer",
  subtitle: "In-kind, acct→acct",
  fields: [
    { kind: "account", key: "sourceAccountId", label: "From account", scope: "investment" },
    { kind: "account", key: "destAccountId", label: "To account", scope: "investment" },
    { kind: "holding", key: "holdingId", accountKey: "sourceAccountId", label: "Holding" },
    { kind: "number", key: "qty", label: "Quantity" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  validate: (s) => {
    if (s.sourceAccountId == null) return "Pick a source account";
    if (s.destAccountId == null) return "Pick a destination account";
    if (s.sourceAccountId === s.destAccountId) return "From and To must differ";
    if (s.holdingId == null) return "Pick a holding";
    if (num(s.qty) <= 0) return "Enter a quantity";
    return null;
  },
  toBody: (s) => ({
    sourceAccountId: s.sourceAccountId!,
    destAccountId: s.destAccountId!,
    holdingId: s.holdingId!,
    qty: num(s.qty),
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
  }),
  prefillFromLoad: (d) =>
    d.op !== "transfer"
      ? {}
      : {
          sourceAccountId: d.sourceAccountId ?? null,
          destAccountId: d.destAccountId ?? null,
          holdingId: d.holdingId ?? null,
          qty: d.qty != null ? String(d.qty) : "",
          date: d.date ?? todayStr(),
          note: d.note ?? "",
        },
};

const incomeExpense: OpConfig = {
  key: "income-expense",
  title: "Income / Expense",
  submitLabel: "Record",
  icon: "dollar",
  subtitle: "Dividend · interest · fee",
  fields: [
    { kind: "amount", label: "Amount" },
    { kind: "signToggle", label: "Type" },
    { kind: "incomeType", label: "Entry type" },
    { kind: "account", key: "accountId", label: "Account", scope: "investment" },
    { kind: "sleeveCurrency", key: "currency", accountKey: "accountId", label: "Cash sleeve" },
    { kind: "relatedHolding", accountKey: "accountId", label: "Related holding (optional)" },
    { kind: "category", label: "Category (only used for “Other”)" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "payee", label: "Payee (optional)" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  amountLabel: (s) => `Amount · ${s.currency || "—"} (${s.isExpense ? "expense" : "income"})`,
  validate: (s) => {
    if (num(s.amount) <= 0) return "Enter an amount";
    if (s.accountId == null) return "Pick an account";
    if (!s.currency) return "Pick a cash sleeve currency";
    return null;
  },
  toBody: (s) => {
    // Preset entry types auto-resolve the category server-side; "other" sends
    // the manually-picked categoryId. Server precedence: explicit categoryId
    // wins, so for presets we omit it.
    const preset = s.incomeType !== "other";
    return {
      accountId: s.accountId!,
      currency: s.currency.toUpperCase(),
      amount: s.isExpense ? -Math.abs(num(s.amount)) : Math.abs(num(s.amount)),
      relatedHoldingId: s.relatedHoldingId ?? undefined,
      categoryId: preset ? undefined : (s.categoryId ?? undefined),
      incomeType: preset ? s.incomeType : undefined,
      date: s.date,
      payee: trimOrUndef(s.payee),
      note: trimOrUndef(s.note),
      tags: trimOrUndef(s.tags),
    };
  },
  prefillFromLoad: (d) =>
    d.op !== "income-expense"
      ? {}
      : {
          accountId: d.accountId ?? null,
          currency: (d.currency ?? "").toUpperCase(),
          amount: d.amount != null ? String(Math.abs(d.amount)) : "",
          isExpense: (d.amount ?? 0) < 0,
          relatedHoldingId: d.relatedHoldingId ?? null,
          // Editing keeps the row's existing category via the manual picker.
          incomeType: "other",
          categoryId: d.categoryId ?? null,
          date: d.date ?? todayStr(),
          payee: d.payee ?? "",
          note: d.note ?? "",
          tags: d.tags ?? "",
        },
  needsCashSleeve: (s, ctx) =>
    s.accountId != null && s.currency && !findCashSleeve(ctx.holdings, s.accountId, s.currency)
      ? { accountId: s.accountId, currency: s.currency.toUpperCase() }
      : null,
};

const fxConversion: OpConfig = {
  key: "fx-conversion",
  title: "FX Conversion",
  submitLabel: "Record conversion",
  icon: "fx",
  subtitle: "Currency sleeve → sleeve",
  fields: [
    { kind: "account", key: "accountId", label: "Account", scope: "investment" },
    { kind: "sleeveCurrency", key: "fromCurrency", accountKey: "accountId", label: "From currency" },
    { kind: "number", key: "fromAmount", label: "From amount" },
    { kind: "currency", key: "toCurrency", label: "To currency" },
    { kind: "number", key: "toAmount", label: "To amount" },
    { kind: "number", key: "feeAmount", label: "Fee (optional)", optional: true },
    { kind: "date", label: "Date" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  validate: (s) => {
    if (s.accountId == null) return "Pick an account";
    if (!s.fromCurrency) return "Pick the from currency";
    if (num(s.fromAmount) <= 0) return "Enter the from amount";
    if (!s.toCurrency) return "Pick the to currency";
    if (num(s.toAmount) <= 0) return "Enter the to amount";
    if (s.fromCurrency.toUpperCase() === s.toCurrency.toUpperCase())
      return "From and To currencies must differ";
    return null;
  },
  toBody: (s) => ({
    accountId: s.accountId!,
    fromCurrency: s.fromCurrency.toUpperCase(),
    fromAmount: num(s.fromAmount),
    toCurrency: s.toCurrency.toUpperCase(),
    toAmount: num(s.toAmount),
    feeAmount: num(s.feeAmount) > 0 ? num(s.feeAmount) : undefined,
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
  }),
  prefillFromLoad: (d) =>
    d.op !== "fx-conversion"
      ? {}
      : {
          accountId: d.accountId ?? null,
          fromCurrency: (d.fromCurrency ?? "").toUpperCase(),
          fromAmount: d.fromAmount != null ? String(d.fromAmount) : "",
          toCurrency: (d.toCurrency ?? "").toUpperCase(),
          toAmount: d.toAmount != null ? String(d.toAmount) : "",
          feeAmount: d.feeAmount != null ? String(d.feeAmount) : "",
          date: d.date ?? todayStr(),
          note: d.note ?? "",
        },
  needsCashSleeve: (s, ctx) =>
    s.accountId != null && s.fromCurrency && !findCashSleeve(ctx.holdings, s.accountId, s.fromCurrency)
      ? { accountId: s.accountId, currency: s.fromCurrency.toUpperCase() }
      : null,
};

const deposit: OpConfig = {
  key: "deposit",
  title: "Brokerage Deposit",
  submitLabel: "Record deposit",
  icon: "depositDown",
  subtitle: "Fund from bank",
  fields: [
    { kind: "amount", label: "Amount" },
    { kind: "account", key: "sourceAccountId", label: "From (bank)", scope: "nonInvestment" },
    { kind: "account", key: "destAccountId", label: "To (brokerage)", scope: "investment" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "payee", label: "Payee (optional)" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  amountLabel: (s, ctx) => {
    const acc = ctx.accounts.find((a) => a.accountId === s.sourceAccountId);
    return `Amount · ${acc?.currency ?? "—"}`;
  },
  validate: (s) => {
    if (num(s.amount) <= 0) return "Enter an amount";
    if (s.sourceAccountId == null) return "Pick a bank account";
    if (s.destAccountId == null) return "Pick a brokerage account";
    return null;
  },
  toBody: (s) => ({
    sourceAccountId: s.sourceAccountId!,
    destAccountId: s.destAccountId!,
    amount: num(s.amount),
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
    tags: trimOrUndef(s.tags),
  }),
  prefillFromLoad: (d) =>
    d.op !== "deposit"
      ? {}
      : {
          sourceAccountId: d.sourceAccountId ?? null,
          destAccountId: d.destAccountId ?? null,
          amount: d.amount != null ? String(d.amount) : "",
          date: d.date ?? todayStr(),
          payee: d.payee ?? "",
          note: d.note ?? "",
          tags: d.tags ?? "",
        },
};

const withdrawal: OpConfig = {
  key: "withdrawal",
  title: "Brokerage Withdrawal",
  submitLabel: "Record withdrawal",
  icon: "withdrawUp",
  subtitle: "Cash out to bank",
  fields: [
    { kind: "amount", label: "Amount" },
    { kind: "account", key: "sourceAccountId", label: "From (brokerage)", scope: "investment" },
    { kind: "account", key: "destAccountId", label: "To (bank)", scope: "nonInvestment" },
    { kind: "date", label: "Date" },
    { kind: "text", key: "payee", label: "Payee (optional)" },
    { kind: "text", key: "note", label: "Note (optional)", multiline: true },
  ],
  amountLabel: (s, ctx) => {
    const acc = ctx.accounts.find((a) => a.accountId === s.destAccountId);
    return `Amount · ${acc?.currency ?? "—"}`;
  },
  validate: (s) => {
    if (num(s.amount) <= 0) return "Enter an amount";
    if (s.sourceAccountId == null) return "Pick a brokerage account";
    if (s.destAccountId == null) return "Pick a bank account";
    return null;
  },
  toBody: (s) => ({
    sourceAccountId: s.sourceAccountId!,
    destAccountId: s.destAccountId!,
    amount: num(s.amount),
    date: s.date,
    payee: trimOrUndef(s.payee),
    note: trimOrUndef(s.note),
    tags: trimOrUndef(s.tags),
  }),
  prefillFromLoad: (d) =>
    d.op !== "withdrawal"
      ? {}
      : {
          sourceAccountId: d.sourceAccountId ?? null,
          destAccountId: d.destAccountId ?? null,
          amount: d.amount != null ? String(d.amount) : "",
          date: d.date ?? todayStr(),
          payee: d.payee ?? "",
          note: d.note ?? "",
          tags: d.tags ?? "",
        },
};

export const OP_CONFIGS: Record<PortfolioOpKey, OpConfig> = {
  buy,
  sell,
  swap,
  transfer,
  "income-expense": incomeExpense,
  "fx-conversion": fxConversion,
  deposit,
  withdrawal,
};

/** Display order for the 8-tile chooser (matches the locked mockup). */
export const OP_ORDER: PortfolioOpKey[] = [
  "buy",
  "sell",
  "swap",
  "transfer",
  "income-expense",
  "fx-conversion",
  "deposit",
  "withdrawal",
];

export function getOpConfig(op: PortfolioOpKey): OpConfig {
  return OP_CONFIGS[op];
}

/** Common currency codes for the free currency picker (FX dest, new holding). */
export const COMMON_CURRENCIES = [
  "CAD",
  "USD",
  "EUR",
  "GBP",
  "JPY",
  "AUD",
  "CHF",
  "CNY",
  "HKD",
  "INR",
  "SGD",
  "NZD",
  "MXN",
  "BRL",
  "XAU",
  "XAG",
];
