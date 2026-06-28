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
} from "@/lib/portfolio/lots/write-hooks";
import { closeCashLotsHook, openCashLotHook } from "@/lib/portfolio/lots/cash-hooks";
import { InvalidLinkPairError } from "@/lib/portfolio/lots/engine";
import { resolveDividendsCategoryId } from "@/lib/dividends-category";
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

// ─── recordReinvestedIncomeInShares ──────────────────────────────────────
//
// Income (dividend / interest / etc.) received AS SHARES rather than cash —
// a single-leg "DRIP". Instead of crediting a cash sleeve, this writes ONE
// transaction directly on a STOCK holding (qty = shares received, amount =
// dollar value of the income) and opens a cost-basis lot at value/qty via
// the SAME path a Buy uses. No cash sleeve is touched (the income never
// lands as cash), so there is no cash leg and no FX at record time — the
// value is denominated in the holding's own currency.
//
// End state is identical to today's two-entry workaround (record income to
// cash, then Buy shares with that cash): +shares, net worth +value. The
// read layer already understands this shape — the dividends/income report
// classifies the row by category (qty>0 → flagged "reinvested"), and the
// lot's origin is tagged `reinvest_div` when the category is the user's
// Dividends category, else `buy` (cosmetic only; cost basis is value/qty
// either way — see openLotForBuy in lots/engine.ts).
//
// Income only: callers pass a positive value. The kind is `portfolio_income`
// (category-neutral — the user may pick any category); it is NOT a paired
// portfolio-op kind, so audit invariant #8 does not apply.

export interface RecordReinvestedIncomeInSharesInput {
  userId: string;
  dek: Buffer | null;
  accountId: number;
  /** Destination stock holding the shares land on (must be non-cash). */
  holdingId: number;
  qty: number;        // > 0 — shares received
  amount: number;     // > 0 — dollar value of the income (in holding currency)
  categoryId?: number | null;
  date: string;
  payee?: string;
  note?: string;
  tags?: string;
  source?: TransactionSource;
}

export interface RecordReinvestedIncomeInSharesResult {
  txId: number;
  holdingId: number;
  lotId: number | null;
  kind: "portfolio_income";
}

export async function recordReinvestedIncomeInShares(
  input: RecordReinvestedIncomeInSharesInput,
): Promise<RecordReinvestedIncomeInSharesResult> {
  if (input.qty <= 0) {
    throw new Error(
      `recordReinvestedIncomeInShares: qty must be > 0 (got ${input.qty})`,
    );
  }
  if (input.amount <= 0) {
    throw new Error(
      `recordReinvestedIncomeInShares: value must be > 0 (got ${input.amount})`,
    );
  }

  const holding = await fetchHolding(input.userId, input.holdingId);
  if (holding.isCash) {
    throw new Error(
      `recordReinvestedIncomeInShares: holding ${input.holdingId} is a cash sleeve; ` +
        `income-as-shares must target a non-cash holding.`,
    );
  }

  const source: TransactionSource = input.source ?? "manual";
  const payee = enc(input.dek, input.payee ?? "");
  const note = enc(input.dek, input.note ?? "");
  const tags = enc(input.dek, input.tags ?? "");

  // Single stock-leg row: qty = shares acquired, amount = the income's
  // dollar value. No cash leg, no related_holding_id (the row IS on the
  // paying position).
  const inserted = await db
    .insert(schema.transactions)
    .values({
      userId: input.userId,
      date: input.date,
      accountId: input.accountId,
      portfolioHoldingId: input.holdingId,
      relatedHoldingId: null,
      categoryId: input.categoryId ?? null,
      quantity: input.qty,
      amount: input.amount,
      currency: holding.currency,
      payee,
      note,
      tags,
      kind: "portfolio_income",
      source,
    })
    .returning({ id: schema.transactions.id });
  const txId = inserted[0]!.id;

  // Open the cost-basis lot at value/qty — same hook a Buy uses. Tag the
  // origin `reinvest_div` when the chosen category is the user's Dividends
  // category (no DEK ⇒ resolveDividendsCategoryId returns null ⇒ origin
  // falls back to `buy`; cost basis is unaffected either way).
  const dividendsCategoryId = await resolveDividendsCategoryId(
    db,
    input.userId,
    input.dek,
  );
  const categoryIsDividend =
    dividendsCategoryId != null && input.categoryId === dividendsCategoryId;

  const lotId = await openLotForBuyHook(
    {
      id: txId,
      userId: input.userId,
      date: input.date,
      amount: input.amount,
      currency: holding.currency,
      enteredAmount: null,
      enteredCurrency: null,
      quantity: input.qty,
      accountId: input.accountId,
      categoryId: input.categoryId ?? null,
      portfolioHoldingId: input.holdingId,
      tradeLinkId: null,
      kind: "portfolio_income",
      source,
    },
    { holdingCurrency: holding.currency, categoryIsDividend },
  );

  return { txId, holdingId: input.holdingId, lotId, kind: "portfolio_income" };
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

// ─── Backfill paired-override converters ─────────────────────────────────
//
// Convert an EXISTING orphan transaction row into a proper two-leg portfolio
// operation. Used ONLY by the backfill kind-override apply path
// (apply.ts applyOrphanOverride paired branch) — they let the user reclassify
// a refused `orphan_stock_leg` into a Buy/Sell/Transfer/FX/Brokerage op.
//
// Unlike the record* helpers above (which INSERT both legs fresh), these
// UPDATE the orphan row IN-PLACE — preserving id / created_at / import_hash /
// bank_transaction_id lineage, a load-bearing backfill invariant — then either
// synthesize the counterpart leg (mode='synth_new', tagged
// source='backfill_synth') or re-tag a user-picked existing row
// (mode='link_existing').
//
// They take a caller-supplied transaction handle so the apply path can wrap
// the audit snapshot + leg conversion + proposal status flip in ONE atomic
// transaction. Lot replay is the CALLER's job AFTER commit (mirrors
// applyOrphanOverride's pair-less branch); the returned `linkPair` /
// touched-id info tells the caller which rows to replay.
//
// Invariant #8: the paired kind literals (buy / sell / *_cash_leg / ...) live
// here in operations.ts, never in apply.ts.

/** Drizzle transaction handle, inferred from db.transaction's callback. */
type DbTx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export type BackfillCounterpartMode = "synth_new" | "link_existing";

export class BackfillConvertError extends Error {
  constructor(
    public code: string,
    message: string,
  ) {
    super(message);
    this.name = "BackfillConvertError";
  }
}

/** The orphan row fields a converter needs. The apply path snapshots the full
 *  row anyway, so it passes the relevant columns straight through. */
export interface OrphanRowForConvert {
  id: number;
  date: string;
  accountId: number | null;
  portfolioHoldingId: number | null;
  currency: string;
  amount: number;
  quantity: number | null;
  categoryId: number | null;
  payee: string | null;
  note: string | null;
  tags: string | null;
}

export interface ConvertPairResult {
  /** Rows UPDATEd in place (orphan + optionally a linked counterpart). */
  updatedTxIds: number[];
  /** Synthesized rows INSERTed (source='backfill_synth'). */
  insertedTxIds: number[];
  /** The shared pairing token. */
  pairToken: { tradeLinkId?: string; linkId?: string };
  /** For link_id pairs (transfer / fx): the (source, dest) ids the caller
   *  feeds to applyLotEffectsForLinkPair. null for buy/sell + brokerage. */
  linkPair: { sourceTxId: number; destTxId: number } | null;
}

export interface ConvertBuySellPairInput {
  tx: DbTx;
  userId: string;
  orphan: OrphanRowForConvert;
  /** Which leg the orphan (stock leg) becomes. */
  direction: "buy" | "sell";
  mode: BackfillCounterpartMode;
  /** link_existing only: the user-picked cash row id. */
  counterpartTxId?: number | null;
}

/**
 * Pure sign-normalization for the Buy/Sell converter (exported for tests).
 * Phase-2 convention:
 *   Buy  → stock qty>0, amount>0;  cash qty<0, amount<0
 *   Sell → stock qty<0, amount<0;  cash qty>0, amount>0
 * The stock + cash `amount` always sum to 0 (internal swap).
 */
export function normalizeBuySellLegs(
  direction: "buy" | "sell",
  amount: number,
  quantity: number,
): { stockAmount: number; stockQty: number; cashAmount: number; cashQty: number } {
  const magAmount = Math.abs(amount);
  const magQty = Math.abs(quantity);
  const isBuy = direction === "buy";
  const stockAmount = isBuy ? magAmount : -magAmount;
  const stockQty = isBuy ? magQty : -magQty;
  const cashAmount = -stockAmount;
  return { stockAmount, stockQty, cashAmount, cashQty: cashAmount };
}

/**
 * Convert an orphan stock-leg row into a canonical Buy or Sell pair.
 *
 * The orphan becomes the stock leg (kind='buy'|'sell', normalized signs);
 * the cash leg is either synthesized on the matching cash sleeve
 * (source='backfill_synth') or an existing user-picked row re-tagged in place.
 * Both share a fresh trade_link_id. Cost basis flows from the stock leg's own
 * (normalized) amount, so lot replay needs no cash-leg lookup.
 */
export async function convertExistingToBuySellPair(
  input: ConvertBuySellPairInput,
): Promise<ConvertPairResult> {
  const { tx, userId, orphan, direction, mode } = input;
  const isBuy = direction === "buy";

  // The orphan must be a real stock leg: a non-cash holding + non-zero qty.
  if (orphan.accountId == null) {
    throw new BackfillConvertError("orphan_no_account", `Orphan row ${orphan.id} has no account.`);
  }
  if (orphan.portfolioHoldingId == null) {
    throw new BackfillConvertError(
      "orphan_not_stock_leg",
      `Buy/Sell override needs a stock holding on the orphan row; row ${orphan.id} has none.`,
    );
  }
  if (orphan.quantity == null || orphan.quantity === 0) {
    throw new BackfillConvertError(
      "orphan_zero_qty",
      `Buy/Sell override needs a non-zero quantity; row ${orphan.id} has qty=${orphan.quantity}.`,
    );
  }
  const holding = await fetchHolding(userId, orphan.portfolioHoldingId);
  if (holding.isCash) {
    throw new BackfillConvertError(
      "orphan_is_cash_sleeve",
      `Buy/Sell override can't apply to a cash-sleeve row; use FX Conversion instead.`,
    );
  }

  const sleeve = await findCashSleeve(userId, orphan.accountId, holding.currency);
  if (!sleeve) {
    throw new BackfillConvertError(
      "cash_sleeve_missing",
      `No ${holding.currency} cash sleeve on account ${orphan.accountId}. Create one in the account page first.`,
    );
  }

  // Normalize to the Phase-2 convention for the chosen direction.
  const { stockAmount, stockQty, cashAmount } = normalizeBuySellLegs(
    direction,
    orphan.amount,
    orphan.quantity,
  );

  const tradeLinkId = randomUUID();

  // 1. UPDATE the orphan in-place into the stock leg.
  await tx
    .update(schema.transactions)
    .set({
      kind: isBuy ? "buy" : "sell",
      amount: stockAmount,
      quantity: stockQty,
      tradeLinkId,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(schema.transactions.id, orphan.id), eq(schema.transactions.userId, userId)));
  const updatedTxIds = [orphan.id];
  const insertedTxIds: number[] = [];

  if (mode === "synth_new") {
    // 2a. Synthesize the paired cash leg on the sleeve (source='backfill_synth').
    const inserted = await tx
      .insert(schema.transactions)
      .values({
        userId,
        date: orphan.date,
        accountId: orphan.accountId,
        portfolioHoldingId: sleeve.id,
        quantity: cashAmount,
        amount: cashAmount,
        currency: holding.currency,
        payee: orphan.payee,
        note: orphan.note,
        tags: orphan.tags,
        categoryId: orphan.categoryId,
        kind: isBuy ? "buy_cash_leg" : "sell_cash_leg",
        tradeLinkId,
        source: "backfill_synth",
      })
      .returning({ id: schema.transactions.id });
    insertedTxIds.push(inserted[0]!.id);
  } else {
    // 2b. link_existing — re-tag the user-picked cash row into the cash leg.
    //     The apply path validated (exists / owned / same account+currency /
    //     not already linked) and snapshotted it before calling us.
    const counterpartTxId = input.counterpartTxId;
    if (counterpartTxId == null) {
      throw new BackfillConvertError(
        "counterpart_missing",
        `link_existing mode requires a counterpart tx id.`,
      );
    }
    await tx
      .update(schema.transactions)
      .set({
        kind: isBuy ? "buy_cash_leg" : "sell_cash_leg",
        amount: cashAmount,
        quantity: cashAmount,
        portfolioHoldingId: sleeve.id,
        tradeLinkId,
        updatedAt: sql`NOW()`,
      })
      .where(and(eq(schema.transactions.id, counterpartTxId), eq(schema.transactions.userId, userId)));
    updatedTxIds.push(counterpartTxId);
  }

  return {
    updatedTxIds,
    insertedTxIds,
    pairToken: { tradeLinkId },
    linkPair: null,
  };
}

// ─── Cross-account converters (link_existing only) ───────────────────────
//
// Brokerage / FX / In-kind transfer overrides pair the orphan with an EXISTING
// row the user picked (link_existing) — synth_new isn't supported for these
// because the current schema can't record which other account/currency to
// fabricate the counterpart on. Each UPDATEs BOTH the orphan and the picked
// counterpart in place, pairs them via link_id, and self-validates the
// counterpart's shape (throwing BackfillConvertError on a bad pick).

/** The user-picked counterpart row a cross-account converter re-tags. */
export interface CounterpartRowForConvert {
  id: number;
  accountId: number | null;
  currency: string;
  amount: number;
  quantity: number | null;
  portfolioHoldingId: number | null;
  kind: string | null;
  tradeLinkId: string | null;
  linkId: string | null;
}

const PAIRLESS_CANONICAL_KINDS_FOR_CONVERT = new Set([
  "dividend",
  "interest",
  "portfolio_income",
  "portfolio_expense",
  "opening_balance",
  // FINLYNQ-206 — re-tagged former opening_balance rows are canonical/pair-less
  // too; never offer one as an unmatched convert counterpart.
  "balance_adjustment",
]);

function assertCounterpartUnlinked(cp: CounterpartRowForConvert): void {
  // Already part of a pair if it carries a link id, OR its kind is a canonical
  // pair-less kind. (A kind like 'buy' with no link is a BROKEN pair — eligible.)
  const alreadyPaired =
    cp.tradeLinkId != null ||
    cp.linkId != null ||
    (cp.kind != null && cp.kind !== "" && PAIRLESS_CANONICAL_KINDS_FOR_CONVERT.has(cp.kind));
  if (alreadyPaired) {
    throw new BackfillConvertError(
      "counterpart_already_linked",
      `Counterpart row ${cp.id} is already canonical / paired; pick an unmatched row.`,
    );
  }
}

export interface ConvertBrokeragePairInput {
  tx: DbTx;
  userId: string;
  orphan: OrphanRowForConvert;
  counterpart: CounterpartRowForConvert;
  /** The cash-sleeve leg the orphan becomes (deposit dest / withdrawal source). */
  orphanLeg: "brokerage_deposit_in" | "brokerage_withdrawal_out";
}

/**
 * Convert a cash-sleeve orphan into a Brokerage deposit/withdrawal pair. The
 * orphan is the investment-side cash-sleeve leg; the picked counterpart (in a
 * different account, same currency) becomes the external leg. Paired via link_id.
 */
export async function convertExistingToBrokeragePair(
  input: ConvertBrokeragePairInput,
): Promise<ConvertPairResult> {
  const { tx, userId, orphan, counterpart, orphanLeg } = input;
  if (orphan.accountId == null || orphan.portfolioHoldingId == null) {
    throw new BackfillConvertError("orphan_not_cash_sleeve_leg", `Brokerage override needs a cash-sleeve orphan row.`);
  }
  const holding = await fetchHolding(userId, orphan.portfolioHoldingId);
  if (!holding.isCash) {
    throw new BackfillConvertError("orphan_not_cash_sleeve_leg", `Brokerage override's orphan must be on a cash sleeve (the brokerage cash side).`);
  }
  assertCounterpartUnlinked(counterpart);
  if (counterpart.accountId === orphan.accountId) {
    throw new BackfillConvertError("counterpart_same_account", `The external leg must be in a DIFFERENT account than the brokerage cash sleeve.`);
  }
  if (counterpart.currency !== orphan.currency) {
    throw new BackfillConvertError("counterpart_currency_mismatch", `Brokerage legs must share a currency (${orphan.currency} vs ${counterpart.currency}); FX-convert first.`);
  }

  const isDeposit = orphanLeg === "brokerage_deposit_in";
  const mag = Math.abs(orphan.amount);
  const linkId = randomUUID();

  // Orphan = cash-sleeve leg. Deposit grows the sleeve (+), withdrawal shrinks it (−).
  const sleeveAmount = isDeposit ? mag : -mag;
  await tx
    .update(schema.transactions)
    .set({
      kind: orphanLeg,
      amount: sleeveAmount,
      quantity: sleeveAmount,
      linkId,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(schema.transactions.id, orphan.id), eq(schema.transactions.userId, userId)));

  // Counterpart = external leg on the non-investment account: qty=0, no holding.
  const externalKind = isDeposit ? "brokerage_deposit_out" : "brokerage_withdrawal_in";
  const externalAmount = isDeposit ? -mag : mag;
  await tx
    .update(schema.transactions)
    .set({
      kind: externalKind,
      amount: externalAmount,
      quantity: 0,
      portfolioHoldingId: null,
      linkId,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(schema.transactions.id, counterpart.id), eq(schema.transactions.userId, userId)));

  return {
    updatedTxIds: [orphan.id, counterpart.id],
    insertedTxIds: [],
    pairToken: { linkId },
    // Brokerage uses per-row cash-lot replay (one leg has a null holding, so
    // applyLotEffectsForLinkPair would reject the pair).
    linkPair: null,
  };
}

export interface ConvertFxPairInput {
  tx: DbTx;
  userId: string;
  orphan: OrphanRowForConvert;
  counterpart: CounterpartRowForConvert;
  /** Which FX leg the orphan becomes. */
  orphanLeg: "fx_from" | "fx_to";
}

/**
 * Resolve the cash sleeve an FX leg should sit on, and its NATIVE currency.
 *
 * A cash leg already sits on its sleeve, so the row's own `portfolio_holding_id`
 * (when it points at a cash sleeve in this account) is the source of truth for
 * the leg's currency — NOT `transactions.currency`. On a multi-currency
 * investment account, a manually-entered leg is frequently stored with
 * `currency` = the account/base currency (e.g. a USD-sleeve row stored as
 * `currency='CAD'`, with the real USD in `entered_*`/`quantity`). Keying off the
 * sleeve makes FX matching/conversion robust to that shape. Falls back to a
 * currency-keyed lookup for legs that carry no holding.
 */
async function resolveFxLegSleeve(
  userId: string,
  accountId: number,
  leg: { portfolioHoldingId: number | null; currency: string },
): Promise<HoldingRow | null> {
  if (leg.portfolioHoldingId != null) {
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
          eq(schema.portfolioHoldings.id, leg.portfolioHoldingId),
          eq(schema.portfolioHoldings.accountId, accountId),
        ),
      )
      .limit(1);
    const r = row[0];
    if (r && r.isCash) return { id: r.id, currency: r.currency, isCash: true };
  }
  return findCashSleeve(userId, accountId, leg.currency);
}

/**
 * Native (sleeve-currency) magnitude of a cash FX leg. For a cash sleeve the
 * unit count IS the currency amount (1 unit = 1 currency unit), so `quantity`
 * holds the native value even when `transactions.amount` is the converted
 * base-currency figure (the USD-sleeve-stored-as-CAD case). Falls back to
 * |amount| when quantity is absent/zero (canonical rows have amount == quantity).
 */
function fxLegNativeMagnitude(leg: { amount: number; quantity: number | null }): number {
  if (leg.quantity != null && leg.quantity !== 0) return Math.abs(leg.quantity);
  return Math.abs(leg.amount);
}

/**
 * Convert a cash orphan into an FX conversion pair. Both legs sit on cash
 * sleeves in the SAME account but DIFFERENT currencies; amounts differ by the
 * FX rate (no sum-to-zero). Paired via link_id; lots via the FX hook.
 *
 * Currency + amount are taken from each leg's SLEEVE + native unit count, not
 * from `transactions.currency`/`amount` — see resolveFxLegSleeve. The orphan's
 * currency/amount are normalized onto the sleeve so the resulting pair is fully
 * canonical even when the source row was denominated in the account currency.
 */
export async function convertExistingToFxPair(
  input: ConvertFxPairInput,
): Promise<ConvertPairResult> {
  const { tx, userId, orphan, counterpart, orphanLeg } = input;
  if (orphan.accountId == null) {
    throw new BackfillConvertError("orphan_no_account", `FX override's orphan has no account.`);
  }
  assertCounterpartUnlinked(counterpart);
  if (counterpart.accountId !== orphan.accountId) {
    throw new BackfillConvertError("counterpart_account_mismatch", `Both FX legs must be in the same account.`);
  }

  // Resolve each leg's cash sleeve from its OWN holding — the sleeve's currency
  // is authoritative, NOT transactions.currency (which is often the account/base
  // currency on a multi-currency investment account).
  const orphanSleeve = await resolveFxLegSleeve(userId, orphan.accountId, orphan);
  if (!orphanSleeve) {
    throw new BackfillConvertError(
      "cash_sleeve_missing",
      `No cash sleeve resolved for FX orphan row ${orphan.id} (holding ${orphan.portfolioHoldingId ?? "none"}, ${orphan.currency}).`,
    );
  }
  const cpSleeve = await resolveFxLegSleeve(userId, orphan.accountId, counterpart);
  if (!cpSleeve) {
    throw new BackfillConvertError(
      "cash_sleeve_missing",
      `No cash sleeve resolved for FX counterpart row ${counterpart.id} (holding ${counterpart.portfolioHoldingId ?? "none"}, ${counterpart.currency}).`,
    );
  }
  // FX requires the two legs in DIFFERENT currencies — compared on the SLEEVE
  // currency, so two legs both stored as the base currency still match when their
  // sleeves differ.
  if (orphanSleeve.currency === cpSleeve.currency) {
    throw new BackfillConvertError(
      "counterpart_currency_mismatch",
      `FX legs must sit on cash sleeves of DIFFERENT currencies (both resolve to ${orphanSleeve.currency}).`,
    );
  }

  const linkId = randomUUID();
  const orphanIsFrom = orphanLeg === "fx_from";
  // Each leg is denominated in its sleeve's native currency, taken from the
  // native unit count (quantity) so a base-currency-stored amount doesn't leak in.
  const orphanMag = fxLegNativeMagnitude(orphan);
  const cpMag = fxLegNativeMagnitude(counterpart);
  const orphanAmount = (orphanIsFrom ? -1 : 1) * orphanMag;
  const cpKind = orphanIsFrom ? "fx_to" : "fx_from";
  const cpAmount = (orphanIsFrom ? 1 : -1) * cpMag;

  await tx
    .update(schema.transactions)
    .set({
      kind: orphanLeg,
      amount: orphanAmount,
      quantity: orphanAmount,
      currency: orphanSleeve.currency,
      portfolioHoldingId: orphanSleeve.id,
      linkId,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(schema.transactions.id, orphan.id), eq(schema.transactions.userId, userId)));

  await tx
    .update(schema.transactions)
    .set({
      kind: cpKind,
      amount: cpAmount,
      quantity: cpAmount,
      currency: cpSleeve.currency,
      portfolioHoldingId: cpSleeve.id,
      linkId,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(schema.transactions.id, counterpart.id), eq(schema.transactions.userId, userId)));

  const fromTxId = orphanIsFrom ? orphan.id : counterpart.id;
  const toTxId = orphanIsFrom ? counterpart.id : orphan.id;
  return {
    updatedTxIds: [orphan.id, counterpart.id],
    insertedTxIds: [],
    pairToken: { linkId },
    linkPair: { sourceTxId: fromTxId, destTxId: toTxId },
  };
}

export interface ConvertInKindTransferPairInput {
  tx: DbTx;
  userId: string;
  orphan: OrphanRowForConvert;
  counterpart: CounterpartRowForConvert;
  /** Which transfer leg the orphan becomes. */
  orphanLeg: "in_kind_transfer_out" | "in_kind_transfer_in";
}

/**
 * Convert a stock orphan into an in-kind transfer pair. Both legs reference the
 * SAME holding in DIFFERENT accounts, amount=0, opposite qty. Paired via link_id;
 * lots via the transfer hook.
 */
export async function convertExistingToInKindTransferPair(
  input: ConvertInKindTransferPairInput,
): Promise<ConvertPairResult> {
  const { tx, userId, orphan, counterpart, orphanLeg } = input;
  // Structural checks first (no DB) so bad input fails fast.
  if (orphan.accountId == null || orphan.portfolioHoldingId == null) {
    throw new BackfillConvertError("orphan_not_stock_leg", `In-kind transfer override needs a stock-holding orphan row.`);
  }
  if (orphan.quantity == null || orphan.quantity === 0) {
    throw new BackfillConvertError("orphan_zero_qty", `In-kind transfer needs a non-zero quantity.`);
  }
  assertCounterpartUnlinked(counterpart);
  if (counterpart.accountId === orphan.accountId) {
    throw new BackfillConvertError("counterpart_same_account", `A transfer moves a holding BETWEEN accounts; pick a row in a different account.`);
  }
  if (counterpart.portfolioHoldingId !== orphan.portfolioHoldingId) {
    throw new BackfillConvertError("counterpart_holding_mismatch", `Both transfer legs must reference the SAME holding.`);
  }
  const holding = await fetchHolding(userId, orphan.portfolioHoldingId);
  if (holding.isCash) {
    throw new BackfillConvertError("orphan_is_cash_sleeve", `In-kind transfer can't move a cash sleeve; use FX or Brokerage.`);
  }

  const mag = Math.abs(orphan.quantity);
  const linkId = randomUUID();
  const orphanIsOut = orphanLeg === "in_kind_transfer_out";
  const orphanQty = orphanIsOut ? -mag : mag;
  const cpKind = orphanIsOut ? "in_kind_transfer_in" : "in_kind_transfer_out";
  const cpQty = orphanIsOut ? mag : -mag;

  await tx
    .update(schema.transactions)
    .set({ kind: orphanLeg, amount: 0, quantity: orphanQty, linkId, updatedAt: sql`NOW()` })
    .where(and(eq(schema.transactions.id, orphan.id), eq(schema.transactions.userId, userId)));

  await tx
    .update(schema.transactions)
    .set({
      kind: cpKind,
      amount: 0,
      quantity: cpQty,
      portfolioHoldingId: orphan.portfolioHoldingId,
      linkId,
      updatedAt: sql`NOW()`,
    })
    .where(and(eq(schema.transactions.id, counterpart.id), eq(schema.transactions.userId, userId)));

  const sourceTxId = orphanIsOut ? orphan.id : counterpart.id;
  const destTxId = orphanIsOut ? counterpart.id : orphan.id;
  return {
    updatedTxIds: [orphan.id, counterpart.id],
    insertedTxIds: [],
    pairToken: { linkId },
    linkPair: { sourceTxId, destTxId },
  };
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
