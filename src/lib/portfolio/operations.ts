/**
 * Portfolio operations — six high-level helpers for the dedicated
 * Buy/Sell/Swap/Transfer/Income-Expense/FX-Conversion workflows.
 *
 * Replaces the implicit "any transaction with portfolio_holding_id set is
 * a portfolio op" model with explicit, named operations. Each helper:
 *   - Validates inputs and resolves cash sleeves
 *   - Writes the correct row shape(s) in a single DB transaction
 *   - Calls the appropriate lot write-hook
 *   - Returns the inserted transaction ids + a structured result
 *
 * Phase 1 (2026-05-25): library-only. Routes / forms wire up in Phase 2.
 * The seed-demo uses these helpers directly to populate the demo with
 * each of the six operation shapes.
 *
 * Sign convention (cash effect on account, preserved from existing code):
 *   - Buy:  stock leg `qty>0, amount<0` (cash leaves);
 *           paired cash leg `qty<0, amount<0` (cash sleeve qty decreases)
 *   - Sell: stock leg `qty<0, amount>0` (cash arrives);
 *           paired cash leg `qty>0, amount>0` (cash sleeve qty increases)
 *   - Income (dividend/interest): single row on cash sleeve, qty>0, amount>0
 *   - Expense (fees): single row on cash sleeve, qty<0, amount<0
 *   - FX from-leg: cash sleeve A, qty<0, amount<0
 *   - FX to-leg:   cash sleeve B, qty>0, amount>0
 *   - In-kind transfer: source qty<0, dest qty>0, both same holding, no cash leg
 *
 * Cash leg `amount` mirrors `quantity` (1 unit = $1) so account-level
 * SUM(amount) stays consistent (stock leg + cash leg of a Buy net to
 * roughly 0; the holdings.value path is the authoritative balance for
 * investment accounts per CLAUDE.md).
 */

import { randomUUID } from "crypto";
import { and, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptField } from "@/lib/crypto/envelope";
import {
  openLotForBuyHook,
  closeLotsForSellHook,
  applyLotEffectsForLinkPair,
  resolveCashLegForTx,
} from "@/lib/portfolio/lots/write-hooks";
import { InvalidLinkPairError } from "@/lib/portfolio/lots/engine";
import type { LotSelectionStrategy } from "@/lib/portfolio/lots/types";
import type { TransactionSource } from "@/lib/tx-source";

// ─── Errors ──────────────────────────────────────────────────────────────

export class CashSleeveNotFoundError extends Error {
  readonly code = "cash_sleeve_not_found" as const;
  constructor(
    public userId: string,
    public accountId: number,
    public currency: string,
  ) {
    super(
      `No cash sleeve exists for user=${userId}, account=${accountId}, currency=${currency}. ` +
        `Create one via the account's "Cash sleeves" panel before recording this operation.`,
    );
    this.name = "CashSleeveNotFoundError";
  }
}

export class CurrencyMismatchError extends Error {
  readonly code = "currency_mismatch" as const;
  constructor(public expected: string, public got: string, public detail: string) {
    super(`Currency mismatch: expected ${expected}, got ${got}. ${detail}`);
    this.name = "CurrencyMismatchError";
  }
}

export class HoldingNotFoundError extends Error {
  readonly code = "holding_not_found" as const;
  constructor(public holdingId: number) {
    super(`Portfolio holding #${holdingId} not found.`);
    this.name = "HoldingNotFoundError";
  }
}

// ─── Internal helpers ────────────────────────────────────────────────────

interface HoldingRow {
  id: number;
  currency: string;
  isCash: boolean;
}

async function fetchHolding(userId: string, holdingId: number): Promise<HoldingRow> {
  const row = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
      isCash: schema.portfolioHoldings.isCash,
    })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.id, holdingId),
        eq(schema.portfolioHoldings.userId, userId),
      ),
    )
    .limit(1);
  const r = row[0];
  if (!r) throw new HoldingNotFoundError(holdingId);
  return { id: r.id, currency: r.currency, isCash: Boolean(r.isCash) };
}

/**
 * Look up the cash sleeve for (user, account, currency). Returns null if
 * none exists; callers decide whether to throw or create one. Operations
 * helpers throw CashSleeveNotFoundError when the sleeve is missing —
 * per the Phase 1 plan, cash sleeves are NOT auto-created; the user
 * provisions them via the account-detail UI.
 */
export async function findCashSleeve(
  userId: string,
  accountId: number,
  currency: string,
): Promise<HoldingRow | null> {
  const row = await db
    .select({
      id: schema.portfolioHoldings.id,
      currency: schema.portfolioHoldings.currency,
      isCash: schema.portfolioHoldings.isCash,
    })
    .from(schema.portfolioHoldings)
    .where(
      and(
        eq(schema.portfolioHoldings.userId, userId),
        eq(schema.portfolioHoldings.accountId, accountId),
        eq(schema.portfolioHoldings.currency, currency),
        eq(schema.portfolioHoldings.isCash, true),
      ),
    )
    .limit(1);
  const r = row[0];
  if (!r) return null;
  return { id: r.id, currency: r.currency, isCash: true };
}

async function requireCashSleeve(
  userId: string,
  accountId: number,
  currency: string,
): Promise<HoldingRow> {
  const sleeve = await findCashSleeve(userId, accountId, currency);
  if (!sleeve) throw new CashSleeveNotFoundError(userId, accountId, currency);
  return sleeve;
}

function enc(dek: Buffer | null, value: string): string {
  if (!dek) return value;
  // encryptField returns null for null/empty input; for non-empty input
  // it always returns a string. Coalesce to keep this helper's return
  // type narrow.
  return encryptField(dek, value) ?? "";
}

// ─── recordBuy ───────────────────────────────────────────────────────────

export interface RecordBuyInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  holdingId: number;
  qty: number;          // > 0
  totalCost: number;    // > 0 (absolute), in holding currency
  date: string;         // YYYY-MM-DD
  payee?: string;
  note?: string;
  tags?: string;
  source?: TransactionSource;
  /** Optional explicit cash sleeve to debit; defaults to (account, holding.currency) sleeve. */
  cashSleeveHoldingId?: number;
}

export interface RecordBuyResult {
  stockLegTxId: number;
  cashLegTxId: number;
  tradeLinkId: string;
  lotId: number | null;
}

export async function recordBuy(input: RecordBuyInput): Promise<RecordBuyResult> {
  if (input.qty <= 0) throw new Error(`recordBuy: qty must be > 0 (got ${input.qty})`);
  if (input.totalCost <= 0) throw new Error(`recordBuy: totalCost must be > 0 (got ${input.totalCost})`);

  const holding = await fetchHolding(input.userId, input.holdingId);
  if (holding.isCash) {
    throw new Error(`recordBuy: holding ${input.holdingId} is a cash sleeve; use FX Conversion instead.`);
  }

  // Resolve the cash sleeve to debit. Must match the holding's currency
  // (no implicit FX — user must FX-convert beforehand).
  let cashSleeve: HoldingRow;
  if (input.cashSleeveHoldingId != null) {
    cashSleeve = await fetchHolding(input.userId, input.cashSleeveHoldingId);
    if (!cashSleeve.isCash) {
      throw new Error(`recordBuy: holding ${input.cashSleeveHoldingId} is not a cash sleeve.`);
    }
    if (cashSleeve.currency !== holding.currency) {
      throw new CurrencyMismatchError(
        holding.currency,
        cashSleeve.currency,
        `Cash sleeve must match holding currency. To buy ${holding.currency}-denominated holdings with ${cashSleeve.currency} cash, FX-convert first.`,
      );
    }
  } else {
    cashSleeve = await requireCashSleeve(input.userId, input.accountId, holding.currency);
  }

  const tradeLinkId = randomUUID();
  const source: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");
  const tags = enc(input.dek, input.tags ?? "");

  // Stock leg: qty positive (acquired shares), amount negative (cash out of account)
  const stockInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: input.holdingId,
      quantity: input.qty,
      amount: -input.totalCost,
      currency: holding.currency,
      payee,
      note,
      tags,
      kind: "buy",
      tradeLinkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const stockLegTxId = stockInsert[0]!.id;

  // Cash leg: qty mirrors cash movement (-$N), amount=0 to avoid double-
  // counting in account-level sums (stock leg already has the -N amount).
  const cashInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: cashSleeve.id,
      quantity: -input.totalCost,
      amount: 0,
      currency: holding.currency,
      payee,
      note,
      tags,
      kind: "buy_cash_leg",
      tradeLinkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const cashLegTxId = cashInsert[0]!.id;

  // Open the lot. closeLotsForSell-style hook uses Math.abs(amount) so
  // the stock leg's `amount=-totalCost` produces cost_per_share = totalCost/qty.
  const lotId = await openLotForBuyHook(
    {
      id: stockLegTxId,
      userId: input.userId,
      date: input.date,
      amount: -input.totalCost,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: input.qty,
      accountId: input.accountId,
      categoryId: null,
      portfolioHoldingId: input.holdingId,
      tradeLinkId,
      source,
    },
    { holdingCurrency: holding.currency, origin: "buy" },
  );

  return { stockLegTxId, cashLegTxId, tradeLinkId, lotId };
}

// ─── recordSell ──────────────────────────────────────────────────────────

export interface RecordSellInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  holdingId: number;
  qty: number;             // > 0 (input is magnitude; we negate the stock-leg qty internally)
  totalProceeds: number;   // > 0
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  source?: TransactionSource;
  cashSleeveHoldingId?: number;
  /** Lot selection — defaults to FIFO. */
  lotSelection?: { method: LotSelectionStrategy; lotIds?: number[] };
}

export interface RecordSellResult {
  stockLegTxId: number;
  cashLegTxId: number;
  tradeLinkId: string;
  closuresWritten: number;
}

export async function recordSell(input: RecordSellInput): Promise<RecordSellResult> {
  if (input.qty <= 0) throw new Error(`recordSell: qty must be > 0 (got ${input.qty})`);
  if (input.totalProceeds <= 0) throw new Error(`recordSell: totalProceeds must be > 0 (got ${input.totalProceeds})`);

  const holding = await fetchHolding(input.userId, input.holdingId);
  if (holding.isCash) {
    throw new Error(`recordSell: holding ${input.holdingId} is a cash sleeve; use FX Conversion instead.`);
  }

  let cashSleeve: HoldingRow;
  if (input.cashSleeveHoldingId != null) {
    cashSleeve = await fetchHolding(input.userId, input.cashSleeveHoldingId);
    if (!cashSleeve.isCash) {
      throw new Error(`recordSell: holding ${input.cashSleeveHoldingId} is not a cash sleeve.`);
    }
    if (cashSleeve.currency !== holding.currency) {
      throw new CurrencyMismatchError(
        holding.currency,
        cashSleeve.currency,
        `Proceeds must land in a ${holding.currency} sleeve. FX-convert after if needed.`,
      );
    }
  } else {
    cashSleeve = await requireCashSleeve(input.userId, input.accountId, holding.currency);
  }

  const tradeLinkId = randomUUID();
  const source: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");
  const tags = enc(input.dek, input.tags ?? "");

  // Stock leg: qty negative (shares depleted), amount positive (cash arrives at account)
  const stockInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: input.holdingId,
      quantity: -input.qty,
      amount: input.totalProceeds,
      currency: holding.currency,
      payee,
      note,
      tags,
      kind: "sell",
      tradeLinkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const stockLegTxId = stockInsert[0]!.id;

  // Cash leg: qty positive (cash sleeve grows), amount=0 to avoid
  // double-counting (stock leg has the +N amount).
  const cashInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: cashSleeve.id,
      quantity: input.totalProceeds,
      amount: 0,
      currency: holding.currency,
      payee,
      note,
      tags,
      kind: "sell_cash_leg",
      tradeLinkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const cashLegTxId = cashInsert[0]!.id;

  const closuresWritten = await closeLotsForSellHook(
    {
      id: stockLegTxId,
      userId: input.userId,
      date: input.date,
      amount: input.totalProceeds,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: -input.qty,
      accountId: input.accountId,
      categoryId: null,
      portfolioHoldingId: input.holdingId,
      tradeLinkId,
      source,
    },
    {
      holdingCurrency: holding.currency,
      strategy: input.lotSelection?.method ?? "FIFO",
      lotIds: input.lotSelection?.lotIds,
    },
  );

  return {
    stockLegTxId,
    cashLegTxId,
    tradeLinkId,
    closuresWritten: closuresWritten ?? 0,
  };
}

// ─── recordSwap (= Sell + Buy in same account) ───────────────────────────

export interface RecordSwapInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  sourceHoldingId: number;
  sourceQty: number;
  sourceProceeds: number;
  destHoldingId: number;
  destQty: number;
  destCost: number;
  date: string;
  payee?: string;
  note?: string;
  source?: TransactionSource;
}

export interface RecordSwapResult {
  sell: RecordSellResult;
  buy: RecordBuyResult;
}

export async function recordSwap(input: RecordSwapInput): Promise<RecordSwapResult> {
  if (input.sourceHoldingId === input.destHoldingId) {
    throw new Error(`recordSwap: source and dest holdings must differ`);
  }
  // Currency-match check happens inside recordSell/recordBuy via the cash
  // sleeve resolution. Both ops resolve the same (account, currency)
  // sleeve, so the swap implicitly nets to ~0 on that sleeve.
  const sell = await recordSell({
    userId: input.userId,
    dek: input.dek,
    accountId: input.accountId,
    holdingId: input.sourceHoldingId,
    qty: input.sourceQty,
    totalProceeds: input.sourceProceeds,
    date: input.date,
    payee: input.payee ?? "Swap (sell)",
    note: input.note,
    source: input.source,
  });
  const buy = await recordBuy({
    userId: input.userId,
    dek: input.dek,
    accountId: input.accountId,
    holdingId: input.destHoldingId,
    qty: input.destQty,
    totalCost: input.destCost,
    date: input.date,
    payee: input.payee ?? "Swap (buy)",
    note: input.note,
    source: input.source,
  });
  return { sell, buy };
}

// ─── recordInKindTransfer ────────────────────────────────────────────────

export interface RecordInKindTransferInput {
  userId: string;
  dek: Buffer | null;
  sourceAccountId: number;
  destAccountId: number;
  /** Same holding referenced on both legs. Cash sleeves NOT allowed here. */
  holdingId: number;
  qty: number;
  date: string;
  payee?: string;
  note?: string;
  source?: TransactionSource;
}

export interface RecordInKindTransferResult {
  sourceTxId: number;
  destTxId: number;
  linkId: string;
  closuresWritten: number;
  destLotsWritten: number;
}

export async function recordInKindTransfer(
  input: RecordInKindTransferInput,
): Promise<RecordInKindTransferResult> {
  if (input.sourceAccountId === input.destAccountId) {
    throw new Error(`recordInKindTransfer: source and dest accounts must differ`);
  }
  if (input.qty <= 0) throw new Error(`recordInKindTransfer: qty must be > 0`);

  const holding = await fetchHolding(input.userId, input.holdingId);
  if (holding.isCash) {
    throw new Error(`recordInKindTransfer: holding ${input.holdingId} is a cash sleeve; use a generic transfer for cash.`);
  }

  const linkId = randomUUID();
  const source: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");

  const sourceInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.sourceAccountId,
      portfolioHoldingId: input.holdingId,
      quantity: -input.qty,
      amount: 0,
      currency: holding.currency,
      payee,
      note,
      kind: "in_kind_transfer_out",
      linkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const sourceTxId = sourceInsert[0]!.id;

  const destInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.destAccountId,
      portfolioHoldingId: input.holdingId,
      quantity: input.qty,
      amount: 0,
      currency: holding.currency,
      payee,
      note,
      kind: "in_kind_transfer_in",
      linkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const destTxId = destInsert[0]!.id;

  // Use the dispatcher so the engine classifies (same holding → transfer).
  const r = await applyLotEffectsForLinkPair(
    {
      id: sourceTxId,
      userId: input.userId,
      date: input.date,
      amount: 0,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: -input.qty,
      accountId: input.sourceAccountId,
      categoryId: null,
      portfolioHoldingId: input.holdingId,
      tradeLinkId: null,
      source,
    },
    {
      id: destTxId,
      userId: input.userId,
      date: input.date,
      amount: 0,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: input.qty,
      accountId: input.destAccountId,
      categoryId: null,
      portfolioHoldingId: input.holdingId,
      tradeLinkId: null,
      source,
    },
  );

  return {
    sourceTxId,
    destTxId,
    linkId,
    closuresWritten: r.closuresWritten,
    destLotsWritten: r.destLotsWritten,
  };
}

// ─── recordPortfolioIncomeOrExpense ──────────────────────────────────────

export interface RecordPortfolioIncomeOrExpenseInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  /** Currency of the cash sleeve to credit/debit. */
  currency: string;
  amount: number;        // positive = income, negative = expense
  /** Optional: the holding the income/expense relates to (for reporting). */
  relatedHoldingId?: number | null;
  categoryId?: number | null;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  source?: TransactionSource;
}

export interface RecordPortfolioIncomeOrExpenseResult {
  txId: number;
  cashSleeveHoldingId: number;
  kind: "portfolio_income" | "portfolio_expense";
}

export async function recordPortfolioIncomeOrExpense(
  input: RecordPortfolioIncomeOrExpenseInput,
): Promise<RecordPortfolioIncomeOrExpenseResult> {
  if (input.amount === 0) {
    throw new Error(`recordPortfolioIncomeOrExpense: amount cannot be 0`);
  }
  const cashSleeve = await requireCashSleeve(input.userId, input.accountId, input.currency);
  const kind: "portfolio_income" | "portfolio_expense" =
    input.amount > 0 ? "portfolio_income" : "portfolio_expense";

  const source: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");
  const tags = enc(input.dek, input.tags ?? "");

  const inserted = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: cashSleeve.id,
      relatedHoldingId: input.relatedHoldingId ?? null,
      categoryId: input.categoryId ?? null,
      quantity: input.amount, // matches sign of amount; cash sleeve qty = $ qty
      amount: input.amount,
      currency: input.currency,
      payee,
      note,
      tags,
      kind,
      source,
    })
    .returning({ id: schema.transactions.id });

  return {
    txId: inserted[0]!.id,
    cashSleeveHoldingId: cashSleeve.id,
    kind,
  };
}

// ─── recordFxConversion ──────────────────────────────────────────────────

export interface RecordFxConversionInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  fromCurrency: string;
  fromAmount: number;    // > 0 — amount debited from the source sleeve
  toCurrency: string;
  toAmount: number;      // > 0 — amount credited to the destination sleeve
  /** Optional fee: amount + currency + which sleeve absorbs the fee. */
  feeAmount?: number;
  feeCurrency?: string;
  feeOnSleeveCurrency?: string;
  date: string;
  payee?: string;
  note?: string;
  source?: TransactionSource;
}

export interface RecordFxConversionResult {
  fromTxId: number;
  toTxId: number;
  feeTxId: number | null;
  linkId: string;
}

export async function recordFxConversion(
  input: RecordFxConversionInput,
): Promise<RecordFxConversionResult> {
  if (input.fromAmount <= 0) throw new Error(`recordFxConversion: fromAmount must be > 0`);
  if (input.toAmount <= 0) throw new Error(`recordFxConversion: toAmount must be > 0`);
  if (input.fromCurrency === input.toCurrency) {
    throw new Error(`recordFxConversion: from and to currencies must differ`);
  }

  const fromSleeve = await requireCashSleeve(input.userId, input.accountId, input.fromCurrency);
  const toSleeve = await requireCashSleeve(input.userId, input.accountId, input.toCurrency);

  const linkId = randomUUID();
  const source: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");

  // From-leg: cash sleeve A, qty<0 + amount<0 (cash leaves)
  const fromInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: fromSleeve.id,
      quantity: -input.fromAmount,
      amount: -input.fromAmount,
      currency: input.fromCurrency,
      payee,
      note,
      kind: "fx_from",
      linkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const fromTxId = fromInsert[0]!.id;

  // To-leg: cash sleeve B, qty>0 + amount>0 (cash arrives)
  const toInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: toSleeve.id,
      quantity: input.toAmount,
      amount: input.toAmount,
      currency: input.toCurrency,
      payee,
      note,
      kind: "fx_to",
      linkId,
      source,
    })
    .returning({ id: schema.transactions.id });
  const toTxId = toInsert[0]!.id;

  // Run the engine dispatcher to classify the pair as FX (logs warnings,
  // refuses if for some reason the pair fails classification — defensive).
  await applyLotEffectsForLinkPair(
    {
      id: fromTxId,
      userId: input.userId,
      date: input.date,
      amount: -input.fromAmount,
      currency: input.fromCurrency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: -input.fromAmount,
      accountId: input.accountId,
      categoryId: null,
      portfolioHoldingId: fromSleeve.id,
      tradeLinkId: null,
      source,
    },
    {
      id: toTxId,
      userId: input.userId,
      date: input.date,
      amount: input.toAmount,
      currency: input.toCurrency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: input.toAmount,
      accountId: input.accountId,
      categoryId: null,
      portfolioHoldingId: toSleeve.id,
      tradeLinkId: null,
      source,
    },
  );

  // Optional fee leg — third row sharing the same link_id, on the
  // user-picked sleeve.
  let feeTxId: number | null = null;
  if (input.feeAmount != null && input.feeAmount > 0) {
    const feeCcy = input.feeOnSleeveCurrency ?? input.feeCurrency ?? input.fromCurrency;
    const feeSleeve = await requireCashSleeve(input.userId, input.accountId, feeCcy);
    const feeIns = await db
      .insert(schema.transactions)
      .values({
        userId: input.userId,
        date: input.date,
        accountId: input.accountId,
        portfolioHoldingId: feeSleeve.id,
        quantity: -input.feeAmount,
        amount: -input.feeAmount,
        currency: feeCcy,
        payee,
        note,
        kind: "fx_fee",
        linkId,
        source,
      })
      .returning({ id: schema.transactions.id });
    feeTxId = feeIns[0]!.id;
  }

  return { fromTxId, toTxId, feeTxId, linkId };
}

// ─── canEditPortfolioRow — edit/delete guard ─────────────────────────────
//
// Returns { allowed: true } when the tx has no downstream lot closures
// blocking edits, otherwise { allowed: false, reason, blockingTxIds } so
// the API + UI can surface a clear refusal listing the dependent rows.
//
// Rule (per user 2026-05-23): any closure on a lot opened by this tx
// blocks edits — sell or transfer_out. Transfer-out is included because
// the cost basis cascades to the destination lot which may itself have
// been sold.

export interface EditGuardResult {
  allowed: boolean;
  reason?: string;
  blockingClosureTxIds?: number[];
}

export async function canEditPortfolioRow(
  userId: string,
  txId: number,
): Promise<EditGuardResult> {
  // Find all lots opened by this tx.
  const lots = await db
    .select({ id: schema.holdingLots.id })
    .from(schema.holdingLots)
    .where(
      and(
        eq(schema.holdingLots.userId, userId),
        eq(schema.holdingLots.openTxId, txId),
      ),
    );
  if (lots.length === 0) return { allowed: true };

  const lotIds = lots.map((l) => l.id);

  // Any closure references one of these lots?
  const closures = await db
    .select({
      closeTxId: schema.holdingLotClosures.closeTxId,
      closeKind: schema.holdingLotClosures.closeKind,
    })
    .from(schema.holdingLotClosures)
    .where(
      and(
        eq(schema.holdingLotClosures.userId, userId),
        sql`${schema.holdingLotClosures.lotId} IN (${sql.join(lotIds.map((i) => sql`${i}`), sql`, `)})`,
      ),
    );

  if (closures.length === 0) return { allowed: true };

  return {
    allowed: false,
    reason:
      `This transaction opens a lot that has been sold or transferred out. ` +
      `Delete the ${closures.length} dependent transaction(s) first, then retry.`,
    blockingClosureTxIds: closures.map((c) => c.closeTxId),
  };
}

// Re-export for callers that catch on these types.
export { InvalidLinkPairError };
