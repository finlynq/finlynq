import { NextRequest, NextResponse } from "next/server";
import { createHash } from "crypto";
import { requireAuth } from "@/lib/auth/require-auth";
import { createCategory, createAccount, getAccounts, getCategories } from "@/lib/queries";
import { db, schema } from "@/db";
import { and, eq } from "drizzle-orm";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import {
  buildNameFields,
  decryptName,
  encryptOptional,
} from "@/lib/crypto/encrypted-columns";
import { encryptField } from "@/lib/crypto/envelope";
// Importing the canonical portfolio-op helpers keeps the buy/sell/deposit
// rows audit-clean (invariant #8 — portfolio-op kinds must originate from
// operations.ts) AND gets the cash-leg pairing + inline lot/closure wiring
// for free, so /portfolio, /portfolio/realized-gains and the performance
// charts all light up without a separate buildLotsForUser pass.
import {
  recordBuy,
  recordSell,
  recordBrokerageDeposit,
} from "@/lib/portfolio/operations";

// ─── Seed definitions ──────────────────────────────────────────────────────

// Category type: "I" = income, "E" = expense. The "Dividends" income
// category is load-bearing — the dividend-income report resolves it by the
// HMAC name lookup (resolveDividendsCategoryId), so the name must be exactly
// "Dividends" for the /portfolio/dividends screen to surface anything.
const SAMPLE_CATEGORIES: Array<{ type: "I" | "E"; group: string; name: string }> = [
  { type: "I", group: "Income", name: "Salary" },
  { type: "I", group: "Income", name: "Interest" },
  { type: "I", group: "Income", name: "Dividends" },
  { type: "E", group: "Housing", name: "Rent" },
  { type: "E", group: "Housing", name: "Utilities" },
  { type: "E", group: "Housing", name: "Internet" },
  { type: "E", group: "Food", name: "Groceries" },
  { type: "E", group: "Food", name: "Dining" },
  { type: "E", group: "Transport", name: "Transit" },
  { type: "E", group: "Transport", name: "Fuel" },
  { type: "E", group: "Lifestyle", name: "Entertainment" },
  { type: "E", group: "Lifestyle", name: "Subscriptions" },
  { type: "E", group: "Lifestyle", name: "Shopping" },
  { type: "E", group: "Health", name: "Fitness" },
  { type: "E", group: "Savings", name: "Transfers" },
];

// type: "A" = asset, "L" = liability. isInvestment=true routes the account
// to the portfolio surface and hides it from the generic Add Transaction
// picker — Brokerage + TFSA only get portfolio-shaped rows below.
const SAMPLE_ACCOUNTS: Array<{
  name: string;
  type: "A" | "L";
  group: string;
  currency: string;
  isInvestment: boolean;
}> = [
  { name: "Chequing", type: "A", group: "Chequing", currency: "CAD", isInvestment: false },
  { name: "Savings", type: "A", group: "Savings", currency: "CAD", isInvestment: false },
  { name: "Visa Rewards", type: "L", group: "Credit Card", currency: "CAD", isInvestment: false },
  { name: "Brokerage", type: "A", group: "Investments", currency: "CAD", isInvestment: true },
  { name: "TFSA", type: "A", group: "Investments", currency: "CAD", isInvestment: true },
];

// ─── Helpers ────────────────────────────────────────────────────────────────

/** Mirror of src/lib/import-hash.ts generateImportHash() — kept local so the
 *  regular-transaction seeding is idempotent across re-runs (same date +
 *  account + amount + payee → same hash → skipped). The hash is always over
 *  the plaintext payee (load-bearing invariant). */
function generateImportHash(
  date: string,
  accountId: number,
  amount: number,
  payee: string,
): string {
  const normalized = [
    date.trim(),
    String(accountId),
    amount.toFixed(2),
    (payee || "").trim().toLowerCase(),
  ].join("|");
  return createHash("sha256").update(normalized).digest("hex").slice(0, 32);
}

/** Deterministic jitter so re-runs produce identical rows (→ stable import
 *  hashes → idempotent dedup). NOT Math.random, on purpose. */
function pseudoRandom(seed: number): number {
  const x = Math.sin(seed * 9301 + 49297) * 233280;
  return x - Math.floor(x);
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

type RegularTx = {
  date: string;
  accountKey: string;
  categoryKey: string;
  amount: number;
  payee: string;
  note: string;
};

/** Six months of believable cash-flow on Chequing / Savings / Visa Rewards.
 *  Investment accounts are funded + traded separately (operations.ts). */
function generateRegularTransactions(today: Date): RegularTx[] {
  const txs: RegularTx[] = [];
  const start = new Date(today.getFullYear(), today.getMonth() - 5, 1);
  const push = (
    date: Date,
    accountKey: string,
    categoryKey: string,
    amount: number,
    payee: string,
    note = "",
  ) => {
    if (date > today) return;
    txs.push({ date: isoDate(date), accountKey, categoryKey, amount: round2(amount), payee, note });
  };
  const day = (monthOffset: number, dayOfMonth: number) =>
    new Date(start.getFullYear(), start.getMonth() + monthOffset, dayOfMonth);

  for (let m = 0; m < 6; m++) {
    // Income — salary 1st + 15th, monthly interest on Savings.
    push(day(m, 1), "Chequing", "Salary", 3200, "Acme Corp", "Payroll");
    push(day(m, 15), "Chequing", "Salary", 3200, "Acme Corp", "Payroll");
    push(day(m, 28), "Savings", "Interest", 18 + pseudoRandom(m) * 6, "Bank interest");

    // Housing.
    push(day(m, 1), "Chequing", "Rent", -1850, "Maple Leaf Properties", "Monthly rent");
    push(day(m, 5), "Visa Rewards", "Utilities", -(130 + Math.round(pseudoRandom(m * 3) * 40)), "Hydro One");
    push(day(m, 5), "Visa Rewards", "Internet", -89.99, "Rogers");

    // Subscriptions — five recurring services staggered over a week.
    const subs = [
      { payee: "Netflix", amount: -16.49, category: "Subscriptions" },
      { payee: "Spotify", amount: -10.99, category: "Subscriptions" },
      { payee: "Claude Pro", amount: -20.0, category: "Subscriptions" },
      { payee: "iCloud+", amount: -3.99, category: "Subscriptions" },
      { payee: "GoodLife Fitness", amount: -49.0, category: "Fitness" },
    ];
    subs.forEach((s, i) => {
      push(day(m, 10 + i), "Visa Rewards", s.category, s.amount, s.payee);
    });

    // Entertainment — two outings a month.
    push(day(m, 8), "Visa Rewards", "Entertainment", -(22 + pseudoRandom(m * 5) * 35), "Cineplex");
    push(day(m, 21), "Visa Rewards", "Entertainment", -(22 + pseudoRandom(m * 5 + 1) * 35), "Steam");

    // Shopping — one mid-month purchase.
    push(day(m, 18), "Visa Rewards", "Shopping", -(40 + pseudoRandom(m * 9) * 120), "Amazon");

    // Monthly savings transfer (two legs).
    push(day(m, 16), "Chequing", "Transfers", -500, "Transfer to Savings");
    push(day(m, 16), "Savings", "Transfers", 500, "Transfer from Chequing");

    // Weekly-ish variable spend: groceries (x2/wk), dining (x2/wk), transit
    // (weekly), fuel (bi-weekly).
    const grocers = ["Loblaws", "Metro", "No Frills", "Costco", "Farm Boy"];
    const eateries = ["Tim Hortons", "Starbucks", "Chipotle", "Kinton Ramen", "Sushi Q"];
    for (let w = 0; w < 4; w++) {
      const base = 2 + w * 7;
      push(day(m, base), "Visa Rewards", "Groceries", -(55 + pseudoRandom(m * 40 + w) * 65), grocers[(m + w) % grocers.length]);
      push(day(m, base + 3), "Visa Rewards", "Groceries", -(45 + pseudoRandom(m * 41 + w) * 55), grocers[(m + w + 2) % grocers.length]);
      push(day(m, base + 1), "Visa Rewards", "Dining", -(14 + pseudoRandom(m * 42 + w) * 34), eateries[(m + w) % eateries.length]);
      push(day(m, base + 4), "Visa Rewards", "Dining", -(14 + pseudoRandom(m * 43 + w) * 34), eateries[(m + w + 1) % eateries.length]);
      push(day(m, base), "Visa Rewards", "Transit", -15.5, "TTC");
    }
    push(day(m, 7), "Visa Rewards", "Fuel", -(55 + pseudoRandom(m * 50) * 25), "Shell");
    push(day(m, 21), "Visa Rewards", "Fuel", -(55 + pseudoRandom(m * 51) * 25), "Petro-Canada");

    // Credit-card payment (two legs).
    push(day(m, 25), "Chequing", "Transfers", -1100, "Visa payment");
    push(day(m, 25), "Visa Rewards", "Transfers", 1100, "Visa payment");
  }

  return txs;
}

// ─── Route ───────────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;
  const dek = auth.context.dek;
  if (!dek) {
    return NextResponse.json(
      { success: false, error: "Encryption is locked — sign in again before loading sample data." },
      { status: 423 },
    );
  }

  const warnings: string[] = [];

  try {
    // 1. Categories — reuse by decrypted name, create what's missing.
    const existingCategories = await getCategories(userId);
    const catMap = new Map<string, number>();
    for (const cat of existingCategories) {
      const name = decryptName(cat.nameCt, dek, null);
      if (name) catMap.set(name, cat.id);
    }
    for (const cat of SAMPLE_CATEGORIES) {
      if (!catMap.has(cat.name)) {
        const enc = buildNameFields(dek, { name: cat.name });
        const created = await createCategory(userId, { type: cat.type, group: cat.group, ...enc });
        catMap.set(cat.name, created.id);
      }
    }

    // 2. Accounts — reuse by decrypted name, create what's missing.
    const existingAccounts = await getAccounts(userId, { includeArchived: true });
    const acctMap = new Map<string, number>();
    for (const a of existingAccounts) {
      const name = decryptName(a.nameCt, dek, null);
      if (name) acctMap.set(name, a.id);
    }
    for (const a of SAMPLE_ACCOUNTS) {
      if (!acctMap.has(a.name)) {
        const enc = buildNameFields(dek, { name: a.name });
        const created = await createAccount(userId, {
          type: a.type,
          group: a.group,
          currency: a.currency,
          isInvestment: a.isInvestment,
          ...enc,
        });
        acctMap.set(a.name, created.id);
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);

    // 3. Regular transactions — idempotent via import_hash dedup.
    const existingHashRows = await db
      .select({ importHash: schema.transactions.importHash })
      .from(schema.transactions)
      .where(eq(schema.transactions.userId, userId));
    const seenHashes = new Set(
      existingHashRows.map((r) => r.importHash).filter((h): h is string => !!h),
    );

    const regular = generateRegularTransactions(today);
    const toInsert: Array<typeof schema.transactions.$inferInsert> = [];
    for (const tx of regular) {
      const accountId = acctMap.get(tx.accountKey);
      const categoryId = catMap.get(tx.categoryKey);
      if (!accountId || !categoryId) continue;
      const importHash = generateImportHash(tx.date, accountId, tx.amount, tx.payee);
      if (seenHashes.has(importHash)) continue;
      seenHashes.add(importHash);
      toInsert.push({
        userId,
        date: tx.date,
        accountId,
        categoryId,
        currency: "CAD",
        amount: tx.amount,
        payee: encryptField(dek, tx.payee),
        note: encryptField(dek, tx.note),
        tags: encryptField(dek, ""),
        isBusiness: 0,
        source: "sample_data",
        importHash,
      });
    }
    if (toInsert.length > 0) {
      await db.insert(schema.transactions).values(toInsert);
    }
    let transactionsCreated = toInsert.length;

    // 4. Portfolio — only when the user has no holdings yet (re-running must
    //    not double up holdings / lots / dividends).
    let holdingsCreated = 0;
    let dividendsCreated = 0;
    try {
      const existingHoldings = await db
        .select({ id: schema.portfolioHoldings.id })
        .from(schema.portfolioHoldings)
        .where(eq(schema.portfolioHoldings.userId, userId))
        .limit(1);

      const brokerageId = acctMap.get("Brokerage");
      const tfsaId = acctMap.get("TFSA");
      const chequingId = acctMap.get("Chequing");

      if (existingHoldings.length === 0 && brokerageId && tfsaId && chequingId) {
        const created = await seedPortfolio({
          userId,
          dek,
          today,
          brokerageId,
          tfsaId,
          chequingId,
          dividendsCategoryId: catMap.get("Dividends") ?? null,
        });
        holdingsCreated = created.holdings;
        dividendsCreated = created.dividends;
        transactionsCreated += created.transactions;
      }
    } catch (err: unknown) {
      warnings.push(`portfolio: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 5. Goals — only when the user has none.
    let goalsCreated = 0;
    try {
      const existing = await db
        .select({ id: schema.goals.id })
        .from(schema.goals)
        .where(eq(schema.goals.userId, userId))
        .limit(1);
      if (existing.length === 0) {
        goalsCreated = await seedGoals(userId, dek, acctMap);
      }
    } catch (err: unknown) {
      warnings.push(`goals: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 6. Loans — only when the user has none.
    let loansCreated = 0;
    try {
      const existing = await db
        .select({ id: schema.loans.id })
        .from(schema.loans)
        .where(eq(schema.loans.userId, userId))
        .limit(1);
      if (existing.length === 0) {
        loansCreated = await seedLoans(userId, dek, acctMap, today);
      }
    } catch (err: unknown) {
      warnings.push(`loans: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 7. Subscriptions — only when the user has none.
    let subscriptionsCreated = 0;
    try {
      const existing = await db
        .select({ id: schema.subscriptions.id })
        .from(schema.subscriptions)
        .where(eq(schema.subscriptions.userId, userId))
        .limit(1);
      if (existing.length === 0) {
        subscriptionsCreated = await seedSubscriptions(userId, dek, acctMap, catMap, today);
      }
    } catch (err: unknown) {
      warnings.push(`subscriptions: ${err instanceof Error ? err.message : String(err)}`);
    }

    // 8. Budgets — current month, skip categories already budgeted.
    let budgetsCreated = 0;
    try {
      budgetsCreated = await seedBudgets(userId, catMap, today);
    } catch (err: unknown) {
      warnings.push(`budgets: ${err instanceof Error ? err.message : String(err)}`);
    }

    invalidateUserTxCache(userId);

    return NextResponse.json({
      success: true,
      // Kept for the mobile client, which reads `transactionsCreated` at the
      // top level of the envelope.
      transactionsCreated,
      summary: {
        transactions: transactionsCreated,
        holdings: holdingsCreated,
        dividends: dividendsCreated,
        goals: goalsCreated,
        loans: loansCreated,
        subscriptions: subscriptionsCreated,
        budgets: budgetsCreated,
      },
      warnings: warnings.length ? warnings : undefined,
    });
  } catch (error: unknown) {
    const msg = error instanceof Error ? error.message : "Failed to load sample data";
    return NextResponse.json({ success: false, error: msg }, { status: 500 });
  }
}

// ─── Portfolio seeding ────────────────────────────────────────────────────────

type StockSeed = {
  key: string;
  name: string;
  symbol: string;
  isCrypto: 0 | 1;
  account: "Brokerage" | "TFSA";
  qty: number;
  totalCost: number;
  buyDaysAgo: number;
  note: string;
};

const STOCKS: StockSeed[] = [
  { key: "VTI", name: "Vanguard Total Stock Market", symbol: "VTI", isCrypto: 0, account: "Brokerage", qty: 20, totalCost: 5500, buyDaysAgo: 170, note: "US broad market" },
  { key: "VOO", name: "Vanguard S&P 500", symbol: "VOO", isCrypto: 0, account: "Brokerage", qty: 10, totalCost: 4800, buyDaysAgo: 150, note: "US large cap" },
  { key: "VXUS", name: "Vanguard International ex-US", symbol: "VXUS", isCrypto: 0, account: "Brokerage", qty: 15, totalCost: 1100, buyDaysAgo: 130, note: "International equity" },
  { key: "AAPL", name: "Apple Inc.", symbol: "AAPL", isCrypto: 0, account: "Brokerage", qty: 8, totalCost: 1800, buyDaysAgo: 110, note: "Single stock" },
  { key: "BTC", name: "Bitcoin", symbol: "BTC", isCrypto: 1, account: "Brokerage", qty: 0.05, totalCost: 2400, buyDaysAgo: 90, note: "Crypto" },
  { key: "VFV.TO", name: "Vanguard S&P 500 (CAD)", symbol: "VFV.TO", isCrypto: 0, account: "TFSA", qty: 25, totalCost: 3000, buyDaysAgo: 160, note: "S&P 500 in CAD" },
  { key: "XEQT.TO", name: "iShares All-Equity ETF", symbol: "XEQT.TO", isCrypto: 0, account: "TFSA", qty: 60, totalCost: 2000, buyDaysAgo: 120, note: "All-equity one-ticket" },
  { key: "VAB.TO", name: "Vanguard Canadian Bond", symbol: "VAB.TO", isCrypto: 0, account: "TFSA", qty: 40, totalCost: 1000, buyDaysAgo: 100, note: "Canadian bonds" },
];

// Cash dividends, attributed directly to the paying holding (qty=0, the
// Dividends category, positive amount). Grouped by holding/quarter/year on
// the /portfolio/dividends screen.
const DIVIDENDS: Array<{ holdingKey: string; daysAgo: number; amount: number }> = [
  { holdingKey: "VTI", daysAgo: 135, amount: 14.2 },
  { holdingKey: "VTI", daysAgo: 45, amount: 15.1 },
  { holdingKey: "VOO", daysAgo: 120, amount: 12.6 },
  { holdingKey: "VOO", daysAgo: 30, amount: 13.0 },
  { holdingKey: "VXUS", daysAgo: 125, amount: 9.4 },
  { holdingKey: "VXUS", daysAgo: 35, amount: 9.9 },
  { holdingKey: "AAPL", daysAgo: 80, amount: 4.6 },
  { holdingKey: "VFV.TO", daysAgo: 140, amount: 8.1 },
  { holdingKey: "VFV.TO", daysAgo: 50, amount: 8.4 },
  { holdingKey: "XEQT.TO", daysAgo: 60, amount: 6.2 },
  { holdingKey: "VAB.TO", daysAgo: 95, amount: 5.5 },
  { holdingKey: "VAB.TO", daysAgo: 20, amount: 5.7 },
];

async function seedPortfolio(opts: {
  userId: string;
  dek: Buffer;
  today: Date;
  brokerageId: number;
  tfsaId: number;
  chequingId: number;
  dividendsCategoryId: number | null;
}): Promise<{ holdings: number; dividends: number; transactions: number }> {
  const { userId, dek, today, brokerageId, tfsaId, chequingId, dividendsCategoryId } = opts;
  const accountIdFor = (a: "Brokerage" | "TFSA") => (a === "Brokerage" ? brokerageId : tfsaId);
  const daysAgo = (n: number) => {
    const d = new Date(today);
    d.setDate(d.getDate() - n);
    return isoDate(d);
  };

  let transactions = 0;

  // Cash sleeves (one CAD sleeve per investment account) + funding deposits
  // from Chequing so the buys debit real cash.
  const sleeveByAccount = new Map<number, number>();
  for (const accountId of [brokerageId, tfsaId]) {
    const sleeveId = await createCashSleeve(userId, dek, accountId, "CAD");
    sleeveByAccount.set(accountId, sleeveId);
  }
  // Fund each sleeve before the earliest buy on that account.
  await recordBrokerageDeposit({
    userId,
    dek,
    sourceAccountId: chequingId,
    destAccountId: brokerageId,
    destCashSleeveHoldingId: sleeveByAccount.get(brokerageId)!,
    amount: 20000,
    date: daysAgo(175),
    payee: "Transfer to Brokerage",
    source: "sample_data",
  });
  transactions += 2;
  await recordBrokerageDeposit({
    userId,
    dek,
    sourceAccountId: chequingId,
    destAccountId: tfsaId,
    destCashSleeveHoldingId: sleeveByAccount.get(tfsaId)!,
    amount: 8000,
    date: daysAgo(170),
    payee: "Transfer to TFSA",
    source: "sample_data",
  });
  transactions += 2;

  // Holdings + buys.
  const holdingIdByKey = new Map<string, number>();
  for (const s of STOCKS) {
    const accountId = accountIdFor(s.account);
    const holdingId = await createHolding(userId, dek, accountId, {
      name: s.name,
      symbol: s.symbol,
      isCrypto: s.isCrypto,
      note: s.note,
    });
    holdingIdByKey.set(s.key, holdingId);
    await recordBuy({
      userId,
      dek,
      accountId,
      holdingId,
      qty: s.qty,
      totalCost: s.totalCost,
      date: daysAgo(s.buyDaysAgo),
      payee: `Buy ${s.symbol}`,
      source: "sample_data",
      cashSleeveHoldingId: sleeveByAccount.get(accountId),
    });
    transactions += 2; // stock leg + cash leg
  }

  // A couple of sells to exercise realized-gain / lot-closure paths.
  const sellVoo = holdingIdByKey.get("VOO");
  if (sellVoo) {
    await recordSell({
      userId,
      dek,
      accountId: brokerageId,
      holdingId: sellVoo,
      qty: 3,
      totalProceeds: 1650,
      date: daysAgo(40),
      payee: "Sell VOO (rebalance)",
      source: "sample_data",
      cashSleeveHoldingId: sleeveByAccount.get(brokerageId),
    });
    transactions += 2;
  }
  const sellXeqt = holdingIdByKey.get("XEQT.TO");
  if (sellXeqt) {
    await recordSell({
      userId,
      dek,
      accountId: tfsaId,
      holdingId: sellXeqt,
      qty: 10,
      totalProceeds: 380,
      date: daysAgo(25),
      payee: "Sell XEQT.TO (trim)",
      source: "sample_data",
      cashSleeveHoldingId: sleeveByAccount.get(tfsaId),
    });
    transactions += 2;
  }

  // Cash dividends — one row per payout, categorised as Dividends and bound
  // to the paying holding so the dividend report groups them per security.
  let dividends = 0;
  if (dividendsCategoryId != null) {
    const divRows: Array<typeof schema.transactions.$inferInsert> = [];
    for (const d of DIVIDENDS) {
      const holdingId = holdingIdByKey.get(d.holdingKey);
      if (!holdingId) continue;
      const stock = STOCKS.find((s) => s.key === d.holdingKey)!;
      const accountId = accountIdFor(stock.account);
      divRows.push({
        userId,
        date: daysAgo(d.daysAgo),
        accountId,
        categoryId: dividendsCategoryId,
        currency: "CAD",
        amount: d.amount,
        quantity: 0,
        portfolioHoldingId: holdingId,
        payee: encryptField(dek, `${stock.symbol} dividend`),
        note: encryptField(dek, ""),
        tags: encryptField(dek, ""),
        isBusiness: 0,
        source: "sample_data",
      });
    }
    if (divRows.length > 0) {
      await db.insert(schema.transactions).values(divRows);
      dividends = divRows.length;
      transactions += divRows.length;
    }
  }

  return { holdings: STOCKS.length, dividends, transactions };
}

/** Insert a non-cash holding + its mandatory holding_accounts pairing row. */
async function createHolding(
  userId: string,
  dek: Buffer,
  accountId: number,
  h: { name: string; symbol: string; isCrypto: 0 | 1; note: string },
): Promise<number> {
  const enc = buildNameFields(dek, { name: h.name, symbol: h.symbol });
  const inserted = await db
    .insert(schema.portfolioHoldings)
    .values({
      userId,
      accountId,
      currency: "CAD",
      isCrypto: h.isCrypto,
      isCash: false,
      note: h.note,
      ...enc,
    })
    .returning({ id: schema.portfolioHoldings.id });
  const holdingId = inserted[0]!.id;
  // Load-bearing: every portfolio_holdings INSERT dual-writes holding_accounts
  // (every aggregator JOINs through it).
  await db
    .insert(schema.holdingAccounts)
    .values({ holdingId, accountId, userId, qty: 0, costBasis: 0, isPrimary: true })
    .onConflictDoNothing();
  return holdingId;
}

/** Insert a cash sleeve (is_cash=true, symbol NULL) + holding_accounts row. */
async function createCashSleeve(
  userId: string,
  dek: Buffer,
  accountId: number,
  currency: string,
): Promise<number> {
  const enc = buildNameFields(dek, { name: `Cash ${currency}` });
  const inserted = await db
    .insert(schema.portfolioHoldings)
    .values({
      userId,
      accountId,
      currency,
      isCrypto: 0,
      isCash: true,
      note: "",
      ...enc,
    })
    .returning({ id: schema.portfolioHoldings.id });
  const sleeveId = inserted[0]!.id;
  await db
    .insert(schema.holdingAccounts)
    .values({ holdingId: sleeveId, accountId, userId, qty: 0, costBasis: 0, isPrimary: true })
    .onConflictDoNothing();
  return sleeveId;
}

// ─── Goals / loans / subscriptions / budgets ──────────────────────────────────

async function seedGoals(
  userId: string,
  dek: Buffer,
  acctMap: Map<string, number>,
): Promise<number> {
  const savingsId = acctMap.get("Savings") ?? null;
  const goals: Array<{
    name: string;
    type: string;
    targetAmount: number;
    deadline: string | null;
    accountId: number | null;
    priority: number;
    note: string;
  }> = [
    { name: "Emergency fund", type: "savings", targetAmount: 12000, deadline: null, accountId: savingsId, priority: 1, note: "Three months of expenses" },
    { name: "Trip to Japan", type: "savings", targetAmount: 6000, deadline: "2027-03-01", accountId: savingsId, priority: 2, note: "Spring 2027" },
    { name: "House down payment", type: "savings", targetAmount: 60000, deadline: "2029-01-01", accountId: savingsId, priority: 3, note: "20% down" },
  ];
  for (const g of goals) {
    const enc = buildNameFields(dek, { name: g.name });
    const inserted = await db
      .insert(schema.goals)
      .values({
        userId,
        type: g.type,
        targetAmount: g.targetAmount,
        currency: "CAD",
        deadline: g.deadline,
        accountId: g.accountId,
        priority: g.priority,
        status: "active",
        note: encryptOptional(dek, g.note) ?? "",
        ...enc,
      })
      .returning({ id: schema.goals.id });
    const goalId = inserted[0]?.id;
    // Dual-write the goal_accounts join (issue #130) so multi-account reads
    // resolve the linked account.
    if (goalId && g.accountId) {
      await db.insert(schema.goalAccounts).values({ userId, goalId, accountId: g.accountId });
    }
  }
  return goals.length;
}

async function seedLoans(
  userId: string,
  dek: Buffer,
  acctMap: Map<string, number>,
  today: Date,
): Promise<number> {
  const startOf = (monthsAgo: number) => {
    const d = new Date(today.getFullYear(), today.getMonth() - monthsAgo, 1);
    return isoDate(d);
  };
  const loans: Array<{
    name: string;
    type: string;
    principal: number;
    annualRate: number;
    termMonths: number;
    startDate: string;
    note: string;
  }> = [
    { name: "Car Loan", type: "auto", principal: 28000, annualRate: 6.4, termMonths: 60, startDate: startOf(14), note: "2024 sedan" },
    { name: "Student Loan", type: "student", principal: 22000, annualRate: 4.5, termMonths: 120, startDate: startOf(40), note: "Federal + provincial" },
  ];
  for (const l of loans) {
    const enc = buildNameFields(dek, { name: l.name });
    await db.insert(schema.loans).values({
      userId,
      type: l.type,
      accountId: acctMap.get("Chequing") ?? null,
      currency: "CAD",
      principal: l.principal,
      annualRate: l.annualRate,
      termMonths: l.termMonths,
      startDate: l.startDate,
      paymentFrequency: "monthly",
      extraPayment: 0,
      note: encryptOptional(dek, l.note) ?? "",
      ...enc,
    });
  }
  return loans.length;
}

async function seedSubscriptions(
  userId: string,
  dek: Buffer,
  acctMap: Map<string, number>,
  catMap: Map<string, number>,
  today: Date,
): Promise<number> {
  // Next billing date — same day next month.
  const next = new Date(today.getFullYear(), today.getMonth() + 1, 12);
  const nextDate = isoDate(next);
  const accountId = acctMap.get("Visa Rewards") ?? null;
  const categoryId = catMap.get("Subscriptions") ?? null;
  const subs: Array<{ name: string; amount: number }> = [
    { name: "Netflix", amount: 16.49 },
    { name: "Spotify", amount: 10.99 },
    { name: "Claude Pro", amount: 20.0 },
    { name: "iCloud+", amount: 3.99 },
    { name: "GoodLife Fitness", amount: 49.0 },
  ];
  for (const s of subs) {
    const enc = buildNameFields(dek, { name: s.name });
    await db.insert(schema.subscriptions).values({
      userId,
      amount: s.amount,
      currency: "CAD",
      frequency: "monthly",
      categoryId,
      accountId,
      nextDate,
      status: "active",
      notes: encryptOptional(dek, null),
      ...enc,
    });
  }
  return subs.length;
}

async function seedBudgets(
  userId: string,
  catMap: Map<string, number>,
  today: Date,
): Promise<number> {
  const month = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}`;
  const budgets: Array<{ category: string; amount: number }> = [
    { category: "Groceries", amount: 600 },
    { category: "Dining", amount: 250 },
    { category: "Entertainment", amount: 120 },
    { category: "Subscriptions", amount: 80 },
    { category: "Fuel", amount: 180 },
    { category: "Shopping", amount: 200 },
  ];
  // Skip categories already budgeted this month.
  const existing = await db
    .select({ categoryId: schema.budgets.categoryId })
    .from(schema.budgets)
    .where(and(eq(schema.budgets.userId, userId), eq(schema.budgets.month, month)));
  const budgeted = new Set(existing.map((b) => b.categoryId));

  let created = 0;
  for (const b of budgets) {
    const categoryId = catMap.get(b.category);
    if (!categoryId || budgeted.has(categoryId)) continue;
    await db.insert(schema.budgets).values({
      userId,
      categoryId,
      month,
      amount: b.amount,
      currency: "CAD",
    });
    created++;
  }
  return created;
}
