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
 * Sign convention — a Buy is an internal swap inside the account (cash → asset),
 * so the stock leg + cash leg `amount` sum to ~0. The same applies to Sell
 * (asset → cash). Income / Expense / FX involve real cash movement and
 * mirror the cash effect on both fields of the single (or paired) leg:
 *
 *   - Buy:  stock leg `qty>0, amount>0` (asset acquired, value positive on the books);
 *           paired cash leg `qty<0, amount<0` (cash departed). Sum = 0.
 *   - Sell: stock leg `qty<0, amount<0` (asset depleted from book);
 *           paired cash leg `qty>0, amount>0` (cash arrived). Sum = 0.
 *   - Income (dividend/interest): single row on cash sleeve, qty>0, amount>0
 *   - Expense (fees): single row on cash sleeve, qty<0, amount<0
 *   - FX from-leg: cash sleeve A, qty<0, amount<0
 *   - FX to-leg:   cash sleeve B, qty>0, amount>0
 *   - In-kind transfer: source qty<0, dest qty>0, both same holding, no cash leg
 *
 * **Note** (2026-05-25, post user-feedback): the original Phase 1 implementation
 * put the cash effect on the stock leg (`amount=-totalCost`) with `amount=0`
 * on the cash leg, which displayed as "AAPL: -$2000" in the transactions
 * ledger — confusing because AAPL acquisition is a positive event. The current
 * convention puts the cash effect on the cash leg where it belongs.
 *
 * The lot engine uses `Math.abs(amount)` for `cost_per_share`, so the
 * stock-leg sign flip does NOT change realized-gain or cost-basis math. The
 * `holdings.value` path is the authoritative balance for investment accounts
 * per CLAUDE.md (not SUM(amount) on transactions).
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
import { closeCashLotsHook, openCashLotHook } from "@/lib/portfolio/lots/cash-hooks";
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

  // Stock leg: qty positive (acquired shares), amount POSITIVE (asset value
  // acquired). The stock leg's amount represents the book value of the new
  // position, NOT the cash effect — that lives on the paired cash leg below.
  const stockInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: input.holdingId,
      quantity: input.qty,
      amount: input.totalCost,
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

  // Cash leg: qty + amount both negative (cash sleeve qty decreases, cash
  // amount departs the books). Sum with stock leg = 0 (internal swap).
  const cashInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: cashSleeve.id,
      quantity: -input.totalCost,
      amount: -input.totalCost,
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

  // Open the lot. The hook uses Math.abs(amount) for cost_per_share so the
  // sign of the stock-leg amount doesn't change cost-basis math.
  const lotId = await openLotForBuyHook(
    {
      id: stockLegTxId,
      userId: input.userId,
      date: input.date,
      amount: input.totalCost,
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

  // Phase 5c (2026-05-26): the cash leg (qty<0 on the cash sleeve) closes
  // cash lots FIFO so the FX gain on holding the cash over time surfaces
  // in /portfolio/realized-gains when the user later runs an FX conversion.
  await closeCashLotsHook(
    {
      id: cashLegTxId,
      userId: input.userId,
      date: input.date,
      amount: -input.totalCost,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: -input.totalCost,
      accountId: input.accountId,
      categoryId: null,
      portfolioHoldingId: cashSleeve.id,
      tradeLinkId,
      kind: "buy_cash_leg",
      source,
    },
    { sleeveCurrency: holding.currency, closeKind: "buy_sell" },
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
  /** Lot selection — defaults to FIFO. Phase 3: `lots` carries per-lot
   *  qty when the LotPicker is in per-lot mode; `lotIds` is the legacy
   *  shape (closes the full remaining qty of each named lot). */
  lotSelection?: {
    method: LotSelectionStrategy;
    lotIds?: number[];
    lots?: Array<{ lotId: number; qty: number }>;
  };
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

  // Stock leg: qty negative (shares depleted), amount NEGATIVE (asset value
  // leaves the book). The stock leg's amount is the book-value delta; the
  // cash effect lives on the paired cash leg.
  const stockInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: input.holdingId,
      quantity: -input.qty,
      amount: -input.totalProceeds,
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

  // Cash leg: qty + amount both positive (cash sleeve grows, cash arrives
  // on the books). Sum with stock leg = 0 (internal swap).
  const cashInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: cashSleeve.id,
      quantity: input.totalProceeds,
      amount: input.totalProceeds,
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
      amount: -input.totalProceeds,
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
      perLotQty: input.lotSelection?.lots,
    },
  );

  // Phase 5c: the cash leg (qty>0 on the cash sleeve) opens a fresh cash
  // lot at the sell date's FX rate. A future FX conversion that consumes
  // this cash will compute its FX gain against this lot's open rate.
  await openCashLotHook(
    {
      id: cashLegTxId,
      userId: input.userId,
      date: input.date,
      amount: input.totalProceeds,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: input.totalProceeds,
      accountId: input.accountId,
      categoryId: null,
      portfolioHoldingId: cashSleeve.id,
      tradeLinkId,
      kind: "sell_cash_leg",
      source,
    },
    { sleeveCurrency: holding.currency },
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
  swapLinkId: string;
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
  // Phase 4 — stamp a swap_link_id on all 4 rows so the load endpoint
  // can return the full swap state for edit.
  const swapLinkId = randomUUID();
  await db
    .update(schema.transactions)
    .set({ swapLinkId, updatedAt: sql`NOW()` })
    .where(
      and(
        eq(schema.transactions.userId, input.userId),
        sql`${schema.transactions.id} IN (${sql.join(
          [sell.stockLegTxId, sell.cashLegTxId, buy.stockLegTxId, buy.cashLegTxId].map(
            (i) => sql`${i}`,
          ),
          sql`, `,
        )})`,
      ),
    );
  return { sell, buy, swapLinkId };
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
  const txId = inserted[0]!.id;

  // Phase 5c (2026-05-26): cash-sleeve lot effects.
  //   - income (amount>0): opens a cash lot for the dividend / interest
  //   - expense (amount<0): FIFO-closes cash lots
  const lotTx = {
    id: txId,
    userId: input.userId,
    date: input.date,
    amount: input.amount,
    currency: input.currency,
    enteredAmount: null,
    enteredCurrency: null,
    quantity: input.amount,
    accountId: input.accountId,
    categoryId: input.categoryId ?? null,
    portfolioHoldingId: cashSleeve.id,
    tradeLinkId: null,
    kind,
    source,
  };
  if (input.amount > 0) {
    await openCashLotHook(lotTx, { sleeveCurrency: input.currency });
  } else {
    await closeCashLotsHook(lotTx, {
      sleeveCurrency: input.currency,
      closeKind: "income_expense",
    });
  }

  return {
    txId,
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

    // Phase 5c (2026-05-26): FX fee reduces the fee sleeve — close cash lots.
    await closeCashLotsHook(
      {
        id: feeTxId,
        userId: input.userId,
        date: input.date,
        amount: -input.feeAmount,
        currency: feeCcy,
        enteredAmount: null,
        enteredCurrency: null,
        quantity: -input.feeAmount,
        accountId: input.accountId,
        categoryId: null,
        portfolioHoldingId: feeSleeve.id,
        tradeLinkId: null,
        kind: "fx_fee",
        source,
      },
      { sleeveCurrency: feeCcy, closeKind: "income_expense" },
    );
  }

  return { fromTxId, toTxId, feeTxId, linkId };
}

// ─── recordBrokerageDeposit / recordBrokerageWithdrawal ──────────────────
//
// Cash moves between a non-investment account and a brokerage's cash
// sleeve. Phase 2 follow-up (2026-05-26):
//
//   - Deposit:    non-investment account → brokerage cash sleeve
//                 (e.g. CAD chequing → USD brokerage USD-cash sleeve)
//   - Withdrawal: brokerage cash sleeve → non-investment account
//
// Cross-currency is refused application-layer — the brokerage cash
// sleeve currency MUST match the non-investment account currency. Users
// FX-convert first via a separate FX Conversion op if needed.
//
// Two transaction rows sharing a `link_id` (NOT `trade_link_id`):
//   Deposit:   source leg on non-investment acct (qty=0, amount<0)
//              dest leg on cash sleeve holding   (qty>0, amount>0)
//   Withdrawal: source leg on cash sleeve holding (qty<0, amount<0)
//               dest leg on non-investment acct  (qty=0, amount>0)
//
// No lot side effects — cash sleeves are not yet lot-tracked (Phase 5
// will introduce that for FX gain accounting; until then deposits +
// withdrawals are pure ledger moves).

interface AccountRow {
  id: number;
  currency: string;
  isInvestment: boolean;
}

async function fetchAccount(userId: string, accountId: number): Promise<AccountRow> {
  const row = await db
    .select({
      id: schema.accounts.id,
      currency: schema.accounts.currency,
      isInvestment: schema.accounts.isInvestment,
    })
    .from(schema.accounts)
    .where(
      and(
        eq(schema.accounts.id, accountId),
        eq(schema.accounts.userId, userId),
      ),
    )
    .limit(1);
  const r = row[0];
  if (!r) throw new Error(`Account #${accountId} not found.`);
  return { id: r.id, currency: r.currency, isInvestment: Boolean(r.isInvestment) };
}

export interface RecordBrokerageDepositInput {
  userId: string;
  dek: Buffer | null;
  /** Non-investment account that funds the deposit (source). */
  sourceAccountId: number;
  /** Investment account whose cash sleeve receives the deposit. */
  destAccountId: number;
  /** Cash sleeve `portfolio_holdings.id` on the dest account; resolved
   *  from destAccountId + dest sleeve currency when omitted. */
  destCashSleeveHoldingId?: number;
  /** Positive amount in the (shared) currency. */
  amount: number;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  source?: TransactionSource;
}

export interface RecordBrokerageDepositResult {
  sourceTxId: number;
  destTxId: number;
  linkId: string;
}

export async function recordBrokerageDeposit(
  input: RecordBrokerageDepositInput,
): Promise<RecordBrokerageDepositResult> {
  if (input.amount <= 0) throw new Error(`recordBrokerageDeposit: amount must be > 0`);
  if (input.sourceAccountId === input.destAccountId) {
    throw new Error(`recordBrokerageDeposit: source and dest accounts must differ`);
  }
  const sourceAcct = await fetchAccount(input.userId, input.sourceAccountId);
  if (sourceAcct.isInvestment) {
    throw new Error(
      `recordBrokerageDeposit: source account #${input.sourceAccountId} is an investment account. ` +
        `Use In-kind Transfer or FX Conversion for movements within / between brokerages.`,
    );
  }
  const destAcct = await fetchAccount(input.userId, input.destAccountId);
  if (!destAcct.isInvestment) {
    throw new Error(
      `recordBrokerageDeposit: destination account #${input.destAccountId} is not an investment account.`,
    );
  }

  // Resolve cash sleeve — explicit holding id or auto-by-currency.
  let cashSleeve: HoldingRow;
  if (input.destCashSleeveHoldingId != null) {
    cashSleeve = await fetchHolding(input.userId, input.destCashSleeveHoldingId);
    if (!cashSleeve.isCash) {
      throw new Error(
        `recordBrokerageDeposit: holding #${input.destCashSleeveHoldingId} is not a cash sleeve.`,
      );
    }
  } else {
    cashSleeve = await requireCashSleeve(input.userId, input.destAccountId, sourceAcct.currency);
  }

  if (cashSleeve.currency !== sourceAcct.currency) {
    throw new CurrencyMismatchError(
      sourceAcct.currency,
      cashSleeve.currency,
      `Source account is ${sourceAcct.currency} but the brokerage cash sleeve is ${cashSleeve.currency}. ` +
        `FX-convert via a separate FX Conversion first, then deposit into the matching sleeve.`,
    );
  }

  const linkId = randomUUID();
  const txSource: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");
  const tags = enc(input.dek, input.tags ?? "");

  // Source leg — non-investment account, qty=0, amount=-N. No portfolio
  // holding (this is a plain cash row in chequing/savings/etc).
  const sourceInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.sourceAccountId,
      portfolioHoldingId: null,
      quantity: 0,
      amount: -input.amount,
      currency: sourceAcct.currency,
      payee,
      note,
      tags,
      kind: "brokerage_deposit_out",
      linkId,
      source: txSource,
    })
    .returning({ id: schema.transactions.id });
  const sourceTxId = sourceInsert[0]!.id;

  // Dest leg — brokerage cash sleeve. qty>0 + amount>0.
  const destInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.destAccountId,
      portfolioHoldingId: cashSleeve.id,
      quantity: input.amount,
      amount: input.amount,
      currency: cashSleeve.currency,
      payee,
      note,
      tags,
      kind: "brokerage_deposit_in",
      linkId,
      source: txSource,
    })
    .returning({ id: schema.transactions.id });
  const destTxId = destInsert[0]!.id;

  // Phase 5c (2026-05-26): open a cash lot on the brokerage cash sleeve
  // for the deposit. Future FX conversions on this sleeve will close it
  // and surface FX gain in base currency.
  await openCashLotHook(
    {
      id: destTxId,
      userId: input.userId,
      date: input.date,
      amount: input.amount,
      currency: cashSleeve.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: input.amount,
      accountId: input.destAccountId,
      categoryId: null,
      portfolioHoldingId: cashSleeve.id,
      tradeLinkId: null,
      kind: "brokerage_deposit_in",
      source: txSource,
    },
    { sleeveCurrency: cashSleeve.currency },
  );

  return { sourceTxId, destTxId, linkId };
}

export interface RecordBrokerageWithdrawalInput {
  userId: string;
  dek: Buffer | null;
  /** Investment account whose cash sleeve funds the withdrawal. */
  sourceAccountId: number;
  /** Cash sleeve `portfolio_holdings.id` on the source account; resolved
   *  from sourceAccountId + dest currency when omitted. */
  sourceCashSleeveHoldingId?: number;
  /** Non-investment account that receives the withdrawal. */
  destAccountId: number;
  amount: number;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  source?: TransactionSource;
}

export interface RecordBrokerageWithdrawalResult {
  sourceTxId: number;
  destTxId: number;
  linkId: string;
}

export async function recordBrokerageWithdrawal(
  input: RecordBrokerageWithdrawalInput,
): Promise<RecordBrokerageWithdrawalResult> {
  if (input.amount <= 0) throw new Error(`recordBrokerageWithdrawal: amount must be > 0`);
  if (input.sourceAccountId === input.destAccountId) {
    throw new Error(`recordBrokerageWithdrawal: source and dest accounts must differ`);
  }
  const sourceAcct = await fetchAccount(input.userId, input.sourceAccountId);
  if (!sourceAcct.isInvestment) {
    throw new Error(
      `recordBrokerageWithdrawal: source account #${input.sourceAccountId} is not an investment account.`,
    );
  }
  const destAcct = await fetchAccount(input.userId, input.destAccountId);
  if (destAcct.isInvestment) {
    throw new Error(
      `recordBrokerageWithdrawal: destination account #${input.destAccountId} is an investment account. ` +
        `Use In-kind Transfer or FX Conversion for movements within / between brokerages.`,
    );
  }

  let cashSleeve: HoldingRow;
  if (input.sourceCashSleeveHoldingId != null) {
    cashSleeve = await fetchHolding(input.userId, input.sourceCashSleeveHoldingId);
    if (!cashSleeve.isCash) {
      throw new Error(
        `recordBrokerageWithdrawal: holding #${input.sourceCashSleeveHoldingId} is not a cash sleeve.`,
      );
    }
  } else {
    cashSleeve = await requireCashSleeve(input.userId, input.sourceAccountId, destAcct.currency);
  }

  if (cashSleeve.currency !== destAcct.currency) {
    throw new CurrencyMismatchError(
      destAcct.currency,
      cashSleeve.currency,
      `Brokerage cash sleeve is ${cashSleeve.currency} but the destination account is ${destAcct.currency}. ` +
        `FX-convert via a separate FX Conversion first, then withdraw from the matching sleeve.`,
    );
  }

  const linkId = randomUUID();
  const txSource: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");
  const tags = enc(input.dek, input.tags ?? "");

  // Source leg — brokerage cash sleeve. qty<0 + amount<0.
  const sourceInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.sourceAccountId,
      portfolioHoldingId: cashSleeve.id,
      quantity: -input.amount,
      amount: -input.amount,
      currency: cashSleeve.currency,
      payee,
      note,
      tags,
      kind: "brokerage_withdrawal_out",
      linkId,
      source: txSource,
    })
    .returning({ id: schema.transactions.id });
  const sourceTxId = sourceInsert[0]!.id;

  // Phase 5c (2026-05-26): FIFO-close cash lots on the brokerage sleeve.
  // Realized gain in the sleeve currency is 0; FX gain in base surfaces
  // via augmentWithBaseCurrency() downstream.
  await closeCashLotsHook(
    {
      id: sourceTxId,
      userId: input.userId,
      date: input.date,
      amount: -input.amount,
      currency: cashSleeve.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: -input.amount,
      accountId: input.sourceAccountId,
      categoryId: null,
      portfolioHoldingId: cashSleeve.id,
      tradeLinkId: null,
      kind: "brokerage_withdrawal_out",
      source: txSource,
    },
    { sleeveCurrency: cashSleeve.currency, closeKind: "buy_sell" },
  );

  // Dest leg — non-investment account. qty=0 + amount>0.
  const destInsert = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.destAccountId,
      portfolioHoldingId: null,
      quantity: 0,
      amount: input.amount,
      currency: destAcct.currency,
      payee,
      note,
      tags,
      kind: "brokerage_withdrawal_in",
      linkId,
      source: txSource,
    })
    .returning({ id: schema.transactions.id });
  const destTxId = destInsert[0]!.id;

  return { sourceTxId, destTxId, linkId };
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
