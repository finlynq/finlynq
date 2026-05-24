/**
 * Portfolio aggregator regression-test fixtures (FINLYNQ-49).
 *
 * Real PostgreSQL test harness for the multi-currency aggregator suite that
 * covers CLAUDE.md "Portfolio aggregator" cohort: issues #25, #84, #96, #128,
 * #129, #236. Mocked-DB tests don't catch the load-bearing SQL invariants
 * (SELF-LEFT-JOIN on `trade_link_id`, JOIN through `holding_accounts`,
 * `effectiveBuyAmount` CASE) — so this harness boots a `PostgresAdapter`
 * pointed at a dedicated `finlynq_test` database and seeds rows directly.
 *
 * --- DEK setup choice (option a in the orchestrator brief) ---
 *
 * Per-suite fixed dummy DEK = `Buffer.alloc(32, 0xAA)`. Same value as
 * `tests/helpers/api-test-utils.ts`'s `TEST_DEK`. We do NOT exercise the full
 * `deriveKEK` + `wrapDEK` flow in fixtures because none of these tests touch
 * password verification or the on-disk wrapped DEK — they only need a working
 * 32-byte key to encrypt `name_ct` / `symbol_ct` and compute `name_lookup` /
 * `symbol_lookup` HMACs. Option (a) keeps the fixtures fast (no ~80ms scrypt
 * per test) and deterministic.
 *
 * --- Hard scope ---
 *
 * - DATABASE_URL must point at `finlynq_test`. The bootstrap throws if not.
 * - Per-test setup TRUNCATEs only the tables this suite uses; never touches
 *   sibling databases on the same Postgres cluster.
 * - Bypasses high-level helpers (REST / MCP) for writes so we control every
 *   load-bearing column directly (audit-trio, holding_accounts dual-write,
 *   trade_link_id).
 */

import { Buffer } from "node:buffer";
import { randomUUID } from "node:crypto";

import { sql } from "drizzle-orm";
import { PostgresAdapter, setAdapter, setDialect, db, schema } from "@/db";
import { buildNameFields } from "@/lib/crypto/encrypted-columns";

/** Suite-wide test DEK. Same shape as `tests/helpers/api-test-utils.ts`. */
export const TEST_DEK: Buffer = Buffer.alloc(32, 0xaa);

let __initialized = false;
let __adapter: PostgresAdapter | null = null;

/** Bootstrap the PostgresAdapter once for the suite. Idempotent. */
export async function bootstrapTestDb(): Promise<void> {
  if (__initialized) return;

  const databaseUrl = process.env.DATABASE_URL || process.env.PF_DATABASE_URL;
  if (!databaseUrl) {
    throw new Error(
      "[portfolio-fixtures] DATABASE_URL is required. Expected " +
        "postgresql://devmanager:dev@localhost:55432/finlynq_test (or another " +
        "test-only database).",
    );
  }
  // Safety: only allow connections that name `_test` in the DB segment. Keeps
  // a mis-set env var from blowing away the operator's local dev DB.
  // The shared cluster also hosts `devmanager_dev` — verifying the suffix here
  // is the load-bearing guard against the wrong target.
  if (!/\/[^/]*_test([?#]|$)/.test(databaseUrl)) {
    throw new Error(
      `[portfolio-fixtures] DATABASE_URL must target a *_test database; got: ${databaseUrl}`,
    );
  }

  __adapter = new PostgresAdapter();
  await __adapter.initialize({
    dialect: "postgres",
    postgres: { connectionString: databaseUrl, userId: "" },
  });
  setAdapter(__adapter);
  setDialect("postgres");
  __initialized = true;
}

/** Per-test wipe. TRUNCATE every table this suite touches. */
export async function resetTestDb(): Promise<void> {
  await bootstrapTestDb();
  // CASCADE picks up FK dependencies (transaction_splits, holding_accounts,
  // goal_accounts, etc.) without us having to enumerate them.
  await db.execute(sql`TRUNCATE TABLE
    transactions,
    holding_accounts,
    portfolio_holdings,
    categories,
    goal_accounts,
    goals,
    loans,
    subscriptions,
    accounts,
    users,
    price_cache,
    fx_rates,
    fx_overrides
    RESTART IDENTITY CASCADE`);
}

/** Close the adapter at the end of the run. Vitest hangs if connections leak. */
export async function shutdownTestDb(): Promise<void> {
  if (__adapter) {
    await __adapter.close();
    __adapter = null;
    __initialized = false;
  }
}

// ─── Row builders ───────────────────────────────────────────────────────────

export async function createTestUser(): Promise<string> {
  const id = randomUUID();
  const nowIso = new Date().toISOString();
  await db.insert(schema.users).values({
    id,
    username: `test-${id.slice(0, 8)}`,
    email: `${id.slice(0, 8)}@test.local`,
    passwordHash: "test-bcrypt-stub", // not exercised in these tests
    role: "user",
    createdAt: nowIso,
    updatedAt: nowIso,
  });
  return id;
}

export async function createAccount(args: {
  userId: string;
  name: string;
  currency: string;
  type?: string;
  group?: string;
  isInvestment?: boolean;
}): Promise<number> {
  const nameFields = buildNameFields(TEST_DEK, { name: args.name });
  const [row] = await db
    .insert(schema.accounts)
    .values({
      userId: args.userId,
      type: args.type ?? "investment",
      group: args.group ?? "",
      currency: args.currency,
      isInvestment: args.isInvestment ?? true,
      ...(nameFields as { nameCt?: string | null; nameLookup?: string | null }),
    })
    .returning({ id: schema.accounts.id });
  return row.id;
}

export async function createCategory(args: {
  userId: string;
  name: string;
  type: "I" | "E" | "R" | "T";
}): Promise<number> {
  const nameFields = buildNameFields(TEST_DEK, { name: args.name });
  const [row] = await db
    .insert(schema.categories)
    .values({
      userId: args.userId,
      type: args.type,
      ...(nameFields as { nameCt?: string | null; nameLookup?: string | null }),
    })
    .returning({ id: schema.categories.id });
  return row.id;
}

/**
 * Insert a `portfolio_holdings` row AND dual-write the load-bearing
 * `holding_accounts(holding_id, account_id, user_id, is_primary=true)` row
 * (CLAUDE.md cohort #95 + #205). Skipping the dual-write makes the holding
 * invisible to every aggregator that JOINs through `holding_accounts` — which
 * is precisely what issue #25 codified.
 */
export async function createHolding(args: {
  userId: string;
  accountId: number;
  name: string;
  symbol: string | null;
  currency: string;
  isCrypto?: boolean;
}): Promise<number> {
  const nameFields = buildNameFields(TEST_DEK, {
    name: args.name,
    symbol: args.symbol ?? "",
  });
  const [holding] = await db
    .insert(schema.portfolioHoldings)
    .values({
      userId: args.userId,
      accountId: args.accountId,
      currency: args.currency,
      isCrypto: args.isCrypto ? 1 : 0,
      ...(nameFields as Record<string, string | null>),
    })
    .returning({ id: schema.portfolioHoldings.id });

  await db
    .insert(schema.holdingAccounts)
    .values({
      holdingId: holding.id,
      accountId: args.accountId,
      userId: args.userId,
      qty: 0,
      costBasis: 0,
      isPrimary: true,
    })
    .onConflictDoNothing();

  return holding.id;
}

/**
 * INSERT a `transactions` row. Bypasses the REST/MCP write helpers so the
 * test can set load-bearing columns directly (audit-trio, `trade_link_id`).
 *
 * Defaults: `source = 'manual'`, dates stamped to today, audit-trio populated.
 */
export async function recordTransaction(args: {
  userId: string;
  accountId: number;
  date?: string;
  categoryId?: number | null;
  currency: string;
  amount: number;
  quantity?: number | null;
  portfolioHoldingId?: number | null;
  enteredCurrency?: string | null;
  enteredAmount?: number | null;
  tradeLinkId?: string | null;
  kind?: string | null;
  source?: string;
  payee?: string;
}): Promise<number> {
  const date = args.date ?? new Date().toISOString().split("T")[0];
  const [row] = await db
    .insert(schema.transactions)
    .values({
      userId: args.userId,
      date,
      accountId: args.accountId,
      categoryId: args.categoryId ?? null,
      currency: args.currency,
      amount: args.amount,
      quantity: args.quantity ?? null,
      portfolioHoldingId: args.portfolioHoldingId ?? null,
      enteredCurrency: args.enteredCurrency ?? null,
      enteredAmount: args.enteredAmount ?? null,
      tradeLinkId: args.tradeLinkId ?? null,
      kind: args.kind ?? null,
      source: args.source ?? "manual",
      payee: args.payee ?? "",
    })
    .returning({ id: schema.transactions.id });
  return row.id;
}

/**
 * Seed an FX rate row at a given date. `getRateToUsdDetailed` checks
 * `fx_rates` exact (currency, date) match first — populating today's row
 * short-circuits every Yahoo Finance call from the aggregators' code path.
 */
export async function seedFxRate(args: {
  currency: string;
  date?: string;
  rateToUsd: number;
  source?: "yahoo" | "coingecko" | "stooq" | "manual" | "fallback";
}): Promise<void> {
  const date = args.date ?? new Date().toISOString().split("T")[0];
  await db
    .insert(schema.fxRates)
    .values({
      currency: args.currency.toUpperCase(),
      date,
      rateToUsd: args.rateToUsd,
      source: args.source ?? "manual",
    })
    .onConflictDoNothing();
}

/**
 * Seed today's market price for a symbol. `fetchMultipleQuotes` is
 * cache-first against `price_cache` for today's date, so a seeded row
 * short-circuits the Yahoo API.
 */
export async function seedPriceCache(args: {
  symbol: string;
  date?: string;
  price: number;
  currency: string;
}): Promise<void> {
  const date = args.date ?? new Date().toISOString().split("T")[0];
  await db
    .insert(schema.priceCache)
    .values({
      symbol: args.symbol,
      date,
      price: args.price,
      currency: args.currency,
    })
    .onConflictDoNothing();
}
