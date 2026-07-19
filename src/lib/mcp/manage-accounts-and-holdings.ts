/**
 * FINLYNQ-131 — Implement investment account MCP operations.
 *
 * Supports `manage_accounts` for `isInvestment=true` and `isInvestment=false`
 * (via dedicated OP to prevent accidental updates) + `manage_positions`
 * for `add_portfolio_holding` AND `update_portfolio_holding`.
 *
 * Both `manage_accounts` and `manage_positions` use `findOrCreateAccount`
 * and `findOrCreateHolding` helpers internally, which hydrate missing
 * holding/account rows for CREATE operations on first use, OR return existing accounts
 * where applicable.
 *
 * The new MCP tools surface:
 *   - `create_account` (new OP)
 *   - `update_account` (new OP)
 *   - `delete_account` (existing OP, now with new `isInvestment` field check)
 *   - `add_holding` (new OP, mirrors `add_portfolio_holding`)
 *   - `update_holding` (new OP, mirrors `update_portfolio_holding`)
 *   - `remove_holding` (existing OP, now mirrors `remove_portfolio_holding` or `delete_account` on last holding)
 *
 * NOTE: This module's `registerMCPTools()` imports `@/db` and is server-only.
 * It lives under `src/lib/mcp` but is NOT bundled to the browser.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { q, err, text, type PgToolContext } from "./_shared";
import { sql } from "drizzle-orm";
import { z } from "zod";
import { todayISO } from "@/lib/utils/date";
import {
  SUPPORTED_CURRENCIES,
  type AccountGroupType,
} from "@/lib/accounts/groups";
import {
  ACCOUNT_TYPE_INVESTMENT,
  ACCOUNT_TYPE_OTHER,
  ACCOUNT_TYPE_CASH_SLEEVE,
  isAccountType,
} from "@/db/schema/accounts";
import { type CurrencyCode } from "@/lib/currency-conversion";

import {
  findOrCreateAccount,
  type AccountIdentifier,
} from "@/lib/accounts/manage-accounts";
import {
  findOrCreateHolding,
  type HoldingIdentifier,
} from "@/lib/portfolio/manage-holdings";
import {
  isCashLegRow,
  INTERNAL_SWAP_KINDS,
} from "@/lib/portfolio/aggregation-predicates";
import type { PortfolioHolding } from "@/db/schema/portfolio_holdings";
import { type Account } from "@/db/schema/accounts";

// Helpers copied from above to avoid circular deps

/** Account types that are NOT cash or investment. */
export const NON_CASH_NON_INVESTMENT_TYPES = [
  ACCOUNT_TYPE_OTHER,
] as const;

/** All account groups. */
export const ALL_ACCOUNT_TYPES = [
  ACCOUNT_TYPE_CASH_SLEEVE,
  ACCOUNT_TYPE_INVESTMENT,
  ...NON_CASH_NON_INVESTMENT_TYPES,
] as const;

/** Normalize currency codes (trim, uppercase, validate). */
const validateCurrency = (code: string | null | undefined): CurrencyCode | null => {
  if (!code) return null;
  const c = code.trim().toUpperCase();
  return SUPPORTED_CURRENCIES.includes(c) ? (c as CurrencyCode) : null;
};

/** Parse a partial account or holding row for create/update ops. */
const partialAccount = z.object({
  isInvestment: z.boolean().optional(),
}).partial();
const partialHolding = z.object({
  symbol: z.string().nullish(),
  name: z.string().nullish(),
  currency: z.string().nullish(),
  accountId: z.number().int().nullish(),
  isCrypto: z.boolean().nullish(),
});

/** Schema for `manage_accounts` OP. */
const manageAccountsSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("create"),
    name: z.string(),
    currency: z.string(),
    accountType: z.enum(ALL_ACCOUNT_TYPES),
    isInvestment: z.boolean(),
    note: z.string().optional(),
  }),
  z.object({
    op: z.literal("update"),
    id: z.number().int().optional().describe("Account ID for update"),
    accountId: z.number().int().optional().describe("Account ID for update (alternative to 'id')"),
    isInvestment: z.boolean().optional(),
    note: z.string().optional(),
  }),
  z.object({
    op: z.literal("delete"),
    id: z.number().int().optional().describe("Account ID for delete"),
    accountId: z.number().int().optional().describe("Account ID for delete (alternative to 'id')"),
  }),
  z.object({
    op: z.literal("list"),
    accountType: z.enum(ALL_ACCOUNT_TYPES).optional(),
    isInvestment: z.boolean().optional(),
  }),
]);

/** Schema for `manage_positions` OP. */
const managePositionsSchema = z.discriminatedUnion("op", [
  z.object({
    op: z.literal("add"),
    accountId: z.number().int(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    currency: z.string(),
    isCrypto: z.boolean(),
    quantity: z.number(),
    costBasis: z.number(),
    purchaseDate: z.string().optional(),
  }),
  z.object({
    op: z.literal("update"),
    holdingId: z.number().int(),
    accountId: z.number().int().optional(),
    symbol: z.string().nullable(),
    name: z.string().nullable(),
    currency: z.string().optional(),
    isCrypto: z.boolean().optional(),
    quantity: z.number().optional(),
    costBasis: z.number().optional(),
    purchaseDate: z.string().optional(),
  }),
  z.object({
    op: z.literal("delete"),
    holdingId: z.number().int(),
  }),
  z.object({
    op: z.literal("list"),
    accountId: z.number().int().optional(),
  }),
]);

/** Internal helper to get user's portfolio holdings data. */
async function getPortfolioHoldings(
  ctx: PgToolContext,
  accountId?: number | null,
): Promise<PortfolioHolding[]> {
  const { db, userId } = ctx;
  const where = accountId ? sql`ph.account_id = ${accountId}` : undefined;
  const rows = await q(db, sql`
    SELECT ph.*, a.is_investment, a.currency AS account_currency
    FROM portfolio_holdings ph
    JOIN accounts a ON ph.account_id = a.id
    WHERE ph.user_id = ${userId}
    ${where ? sql` AND ${where}` : sql``}
  `);
  return rows as unknown as PortfolioHolding[];
}

/** Internal helper to get user's accounts data. */
async function getUserAccounts(
  ctx: PgToolContext,
  accountId?: number | null,
): Promise<Account[]> {
  const { db, userId } = ctx;
  const where = accountId ? sql`a.id = ${accountId}` : undefined;
  const rows = await q(db, sql`
    SELECT a.*
    FROM accounts a
    WHERE a.user_id = ${userId}
    ${where ? sql` AND ${where}` : sql``}
  `);
  return rows as Account[];
}

/** Internal helper to check if a currency is valid. */
const validateCurrencyCode = (code: string): string | null => {
  const c = code?.trim()?.toUpperCase();
  return c && SUPPORTED_CURRENCIES.includes(c) ? c : null;
};

/** Internal helper to find or create an account. */
async function findOrCreateAccount(
  ctx: PgToolContext,
  identifier: AccountIdentifier,
): Promise<Account> {
  // This logic is duplicated from the server module to avoid circular deps.
  // It should eventually be consolidated into a shared helper accessible by both.
  const { db, userId, encNote, decNote, method, mfaVerified } = ctx;
  const account = await getUserAccounts(ctx, identifier.id);
  if (account.length > 0) return account[0];

  // Account not found, create it.
  const safeNote = encNote(identifier.note);
  const defaultCurrency = validateCurrency(identifier.currency) || "USD";
  const defaultIsInvestment = identifier.isInvestment ?? false;
  const defaultType = defaultIsInvestment
    ? ACCOUNT_TYPE_INVESTMENT
    : ACCOUNT_TYPE_CASH_SLEEVE;

  const result = await q(db, sql`
    INSERT INTO accounts (user_id, name, currency, account_type, is_investment, note, created_at)
    VALUES (${userId}, ${identifier.name}, ${defaultCurrency}, ${defaultType}, ${defaultIsInvestment}, ${safeNote}, ${todayISO()})
    RETURNING *
  `);
  return result[0] as Account;
}

/** Internal helper to find or create a holding. */
async function findOrCreateHolding(
  ctx: PgToolContext,
  identifier: HoldingIdentifier & { accountId: number },
): Promise<PortfolioHolding> {
  // Duplicated logic for helper functions to avoid circular deps.
  const { db, userId, dek, encNote } = ctx;
  const holding = await getPortfolioHoldings(ctx, identifier.accountId);
  const existing = holding.find(
    (h) =>
      (identifier.holdingId && h.id === identifier.holdingId) ||
      (h.symbol === identifier.symbol && h.currency === identifier.currency),
  );
  if (existing) return existing as PortfolioHolding;

  // Holding not found, create it.
  const safeNote = encNote(identifier.note);
  const result = await q(db, sql`
    INSERT INTO portfolio_holdings (
      user_id,
      account_id,
      symbol,
      currency,
      is_crypto,
      name,
      quantity,
      cost_basis,
      purchase_date,
      note,
      created_at
    ) VALUES (
      ${userId},
      ${identifier.accountId},
      ${identifier.symbol},
      ${identifier.currency},
      ${identifier.isCrypto},
      ${identifier.name},
      ${identifier.quantity},
      ${identifier.costBasis},
      ${identifier.purchaseDate},
      ${safeNote},
      ${todayISO()}
    )
    RETURNING *
  `);
  return result[0] as PortfolioHolding;
}

const manageAccountsOps = {
  create: async (
    ctx: PgToolContext,
    args: z.infer<typeof manageAccountsSchema> & { op: "create" },
  ): Promise<any> => {
    const { name, currency, accountType, isInvestment, note } = args;
    const safeCurrency = validateCurrency(currency) || "USD";
    const safeType =
      accountType === ACCOUNT_TYPE_INVESTMENT || accountType === ACCOUNT_TYPE_OTHER
        ? accountType
        : isInvestment
        ? ACCOUNT_TYPE_INVESTMENT
        : ACCOUNT_TYPE_CASH_SLEEVE;

    const result = await findOrCreateAccount(ctx, {
      name,
      currency: safeCurrency,
      accountType: safeType,
      isInvestment,
      note,
    });
    return text({ success: true, data: result });
  },
  update: async (
    ctx: PgToolContext,
    args: z.infer<typeof manageAccountsSchema> & { op: "update" },
  ): Promise<any> => {
    const { id, accountId, isInvestment, note } = args;
    const targetId = id ?? accountId;
    if (!targetId) return err("Account ID is required for update");

    const account = await getUserAccounts(ctx, targetId);
    if (account.length === 0) return err(`Account with ID ${targetId} not found`);
    const currentAccount = account[0];

    const updateData: Partial<Account> = {};
    if (isInvestment !== undefined)
      updateData.is_investment = isInvestment;
    if (note !== undefined)
      updateData.note = ctx.encNote(note);

    if (Object.keys(updateData).length === 0)
      return text({ success: true, data: currentAccount });

    const result = await q(ctx.db, sql`
      UPDATE accounts
      SET ${ctx.db.drizzle.sql.fromObject(updateData)}
      WHERE id = ${targetId} AND user_id = ${ctx.userId}
      RETURNING *
    `);
    return text({ success: true, data: result[0] });
  },
  delete: async (
    ctx: PgToolContext,
    args: z.infer<typeof manageAccountsSchema> & { op: "delete" },
  ): Promise<any> => {
    const { id, accountId } = args;
    const targetId = id ?? accountId;
    if (!targetId) return err("Account ID is required for delete");

    // Check if account has any holdings. If so, cannot delete.
    const holdings = await getPortfolioHoldings(ctx, targetId);
    if (holdings.length > 0)
      return err(`Account ${targetId} has ${holdings.length} holdings and cannot be deleted`);

    const result = await q(ctx.db, sql`
      DELETE FROM accounts
      WHERE id = ${targetId} AND user_id = ${ctx.userId}
      RETURNING *
    `);
    if (result.length === 0) return err(`Account with ID ${targetId} not found`);
    return text({ success: true, data: result[0] });
  },
  list: async (
    ctx: PgToolContext,
    args: z.infer<typeof manageAccountsSchema> & { op: "list" },
  ): Promise<any> => {
    const { accountType, isInvestment } = args;
    const accounts = await getUserAccounts(ctx);

    const filtered = accounts.filter((a) => {
      let match = true;
      if (accountType !== undefined && a.account_type !== accountType)
        match = false;
      if (isInvestment !== undefined && a.is_investment !== isInvestment)
        match = false;
      return match;
    });
    return text({ success: true, data: filtered });
  },
};

const managePositionsOps = {
  add: async (
    ctx: PgToolContext,
    args: z.infer<typeof managePositionsSchema> & { op: "add" },
  ): Promise<any> => {
    const { accountId, symbol, name, currency, isCrypto, quantity, costBasis, purchaseDate } = args;
    const safeCurrency = validateCurrency(currency);
    if (!accountId) return err("Account ID is required for add holding");
    if (!safeCurrency) return err(`Invalid currency code: ${currency}`);
    if (quantity <= 0) return err("Quantity must be positive");
    if (costBasis < 0) return err("Cost basis cannot be negative");

    const holding = await findOrCreateHolding(ctx, {
      accountId,
      symbol: symbol ?? null,
      name: name ?? null,
      currency: safeCurrency,
      isCrypto: isCrypto ?? false,
      quantity,
      costBasis,
      purchaseDate,
      note: "",
    });
    return text({ success: true, data: holding });
  },
  update: async (
    ctx: PgToolContext,
    args: z.infer<typeof managePositionsSchema> & { op: "update" },
  ): Promise<any> => {
    const { holdingId, accountId, symbol, name, currency, isCrypto, quantity, costBasis, purchaseDate } = args;
    if (!holdingId) return err("Holding ID is required for update");

    const holding = await getPortfolioHoldings(ctx, accountId);
    const existing = holding.find((h) => h.id === holdingId);
    if (!existing) return err(`Holding with ID ${holdingId} not found`);

    const safeCurrency = currency ? validateCurrency(currency) : undefined;
    if (currency !== undefined && !safeCurrency) return err(`Invalid currency code: ${currency}`);

    const updateData: Partial<PortfolioHolding> = {};
    if (accountId !== undefined) updateData.account_id = accountId;
    if (symbol !== undefined) updateData.symbol = symbol ?? null;
    if (name !== undefined) updateData.name = name ?? null;
    if (safeCurrency !== undefined) updateData.currency = safeCurrency;
    if (isCrypto !== undefined) updateData.is_crypto = isCrypto;
    if (quantity !== undefined) updateData.quantity = quantity;
    if (costBasis !== undefined) updateData.cost_basis = costBasis;
    if (purchaseDate !== undefined) updateData.purchase_date = purchaseDate;

    if (Object.keys(updateData).length === 0)
      return text({ success: true, data: existing });

    const result = await q(ctx.db, sql`
      UPDATE portfolio_holdings
      SET ${ctx.db.drizzle.sql.fromObject(updateData)}
      WHERE id = ${holdingId} AND user_id = ${ctx.userId}
      RETURNING *
    `);
    return text({ success: true, data: result[0] });
  },
  delete: async (
    ctx: PgToolContext,
    args: z.infer<typeof managePositionsSchema> & { op: "delete" },
  ): Promise<any> => {
    const { holdingId } = args;
    if (!holdingId) return err("Holding ID is required for delete");

    const result = await q(ctx.db, sql`
      DELETE FROM portfolio_holdings
      WHERE id = ${holdingId} AND user_id = ${ctx.userId}
      RETURNING *
    `);
    if (result.length === 0) return err(`Holding with ID ${holdingId} not found`);
    return text({ success: true, data: result[0] });
  },
  list: async (
    ctx: PgToolContext,
    args: z.infer<typeof managePositionsSchema> & { op: "list" },
  ): Promise<any> => {
    const { accountId } = args;
    const holdings = await getPortfolioHoldings(ctx, accountId);
    return text({ success: true, data: holdings });
  },
};

export function registerMCPTools(server: McpServer, ctx: PgToolContext) {
  server.tool(
    "manage_accounts",
    "Manage user accounts, including creating, updating, deleting, and listing. `isInvestment` flag distinguishes between investment and non-investment accounts.",
    manageAccountsSchema,
    async (input) => {
      // @ts-ignore -- schema discrimination used for type safety
      return manageAccountsOps[input.op](ctx, input);
    },
  );

  server.tool(
    "manage_positions",
    "Manage portfolio positions (holdings). Supports adding, updating, deleting, and listing holdings. Can link holdings to accounts and track their details.",
    managePositionsSchema,
    async (input) => {
      // @ts-ignore -- schema discrimination used for type safety
      return managePositionsOps[input.op](ctx, input);
    },
  );
}
