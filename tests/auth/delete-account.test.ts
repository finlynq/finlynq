/**
 * Asserts that `deleteUserAccount` permanently drops the identity:
 *  - deletes the `users` row (the behavior that distinguishes it from
 *    `wipeUserDataAndRewrap`, which keeps the row + rewraps the DEK),
 *  - deletes the FK-less `mcp_idempotency_keys` rows explicitly so they
 *    don't orphan,
 *  - deletes `users` LAST so its ON DELETE CASCADE children fall away after
 *    the per-user data is already gone,
 *  - never emits a rewrap UPDATE (`.set(...)`), since there's no DEK to keep.
 *
 * No live DB — we stub the Drizzle `db` proxy and record every `.delete(table)`
 * and `.set(...)` call.
 */

import { describe, it, expect, vi } from "vitest";

const deletedTables: string[] = [];
const capturedSets: Array<Record<string, unknown>> = [];

vi.mock("@/db", () => {
  const makeChain = (terminalValue: unknown = []): unknown => {
    const c: Record<string, unknown> = {};
    c.set = (vals: Record<string, unknown>) => {
      capturedSets.push(vals);
      return c;
    };
    c.where = () => c;
    c.from = () => c;
    c.values = () => c;
    c.limit = () => c;
    c.then = (resolve: (v: unknown) => void) => resolve(terminalValue);
    return c;
  };

  const tx = {
    select: () => makeChain([]),
    // Record the table name then return a normal awaitable chain.
    delete: (table: { __name?: string }) => {
      deletedTables.push(table?.__name ?? "?");
      return makeChain([]);
    },
    update: () => makeChain([]),
    insert: () => makeChain([]),
  };

  return {
    db: {
      transaction: async (fn: (t: typeof tx) => Promise<unknown>) => fn(tx),
      // Outer pre-tx select for mcpUploads file unlink.
      select: () => makeChain([]),
    },
    schema: { users: { __name: "users" } },
  };
});

vi.mock("@/db/schema-pg", async () => {
  const t = (name: string) => ({ __name: name });
  return {
    users: t("users"),
    transactions: t("transactions"),
    transactionSplits: t("transactionSplits"),
    notifications: t("notifications"),
    subscriptions: t("subscriptions"),
    recurringTransactions: t("recurringTransactions"),
    contributionRoom: t("contributionRoom"),
    fxOverrides: t("fxOverrides"),
    targetAllocations: t("targetAllocations"),
    snapshots: t("snapshots"),
    goalAccounts: t("goalAccounts"),
    goals: t("goals"),
    loans: t("loans"),
    budgets: t("budgets"),
    budgetTemplates: t("budgetTemplates"),
    transactionRules: t("transactionRules"),
    importTemplates: t("importTemplates"),
    bankTransactions: t("bankTransactions"),
    portfolioHoldings: t("portfolioHoldings"),
    categories: t("categories"),
    accounts: t("accounts"),
    mcpUploads: t("mcpUploads"),
    mcpIdempotencyKeys: t("mcpIdempotencyKeys"),
    stagedTransactions: t("stagedTransactions"),
    stagedImports: t("stagedImports"),
    passwordResetTokens: t("passwordResetTokens"),
    oauthAccessTokens: t("oauthAccessTokens"),
    oauthAuthorizationCodes: t("oauthAuthorizationCodes"),
    incomingEmails: t("incomingEmails"),
    settings: t("settings"),
  };
});

vi.mock("drizzle-orm", () => ({
  eq: () => undefined,
  and: () => undefined,
  inArray: () => undefined,
  sql: (() => undefined) as unknown as { raw: () => undefined },
  count: () => undefined,
}));

vi.mock("fs/promises", () => ({
  unlink: vi.fn(async () => undefined),
}));

import { deleteUserAccount } from "@/lib/auth/queries";

describe("deleteUserAccount — permanent identity delete", () => {
  it("deletes the users row last, drops mcp_idempotency_keys, and never rewraps", async () => {
    deletedTables.length = 0;
    capturedSets.length = 0;

    await deleteUserAccount("user-del-1");

    // The distinguishing behavior vs wipeUserDataAndRewrap.
    expect(deletedTables).toContain("users");
    expect(deletedTables).toContain("mcpIdempotencyKeys");
    // Shared data tables still cleared.
    expect(deletedTables).toContain("accounts");
    expect(deletedTables).toContain("transactions");
    expect(deletedTables).toContain("settings");

    // users must be the FINAL delete so its cascade children drop after the
    // per-user data is already gone.
    expect(deletedTables[deletedTables.length - 1]).toBe("users");

    // No DEK rewrap — the identity is gone, nothing to re-encrypt.
    expect(capturedSets).toHaveLength(0);
  });
});
