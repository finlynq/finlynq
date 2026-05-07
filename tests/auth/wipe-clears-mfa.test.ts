/**
 * Asserts that `wipeUserDataAndRewrap` clears the user's MFA fields in the
 * same transaction as the DEK rewrap (B7 / M-6).
 *
 * The old MFA secret was encrypted under the OLD DEK; without this clear it
 * would fail to decrypt on next login and lock the user out.
 *
 * We capture the SET payload from the trailing UPDATE inside the
 * transaction by stubbing the Drizzle `db` proxy.
 */

import { describe, it, expect, vi } from "vitest";

const capturedUpdates: Array<Record<string, unknown>> = [];

// Stub @/db with a tiny in-memory shim that:
//  - records every .set(...) call against the users table
//  - swallows every other delete/select/update by resolving to []/undefined
vi.mock("@/db", () => {
  // Build a chain whose terminal awaits resolve to a (configurable)
  // value. Drizzle normally returns array-like awaitables for .where()
  // and direct .delete() awaits — we mimic that.
  const makeChain = (terminalValue: unknown = []): unknown => {
    const c: Record<string, unknown> = {};
    c.set = (vals: Record<string, unknown>) => {
      capturedUpdates.push(vals);
      return c;
    };
    c.where = () => c;
    c.from = () => c;
    c.values = () => c;
    c.limit = () => c;
    // Awaiting the chain resolves to the terminal value.
    c.then = (
      resolve: (v: unknown) => void,
      _reject?: (e: unknown) => void
    ) => resolve(terminalValue);
    return c;
  };

  const tx = {
    select: () => makeChain([]),
    delete: () => makeChain([]),
    update: () => makeChain([]),
    insert: () => makeChain([]),
  };
  return {
    db: {
      transaction: async (fn: (tx: typeof tx) => Promise<unknown>) =>
        fn(tx),
      // Outer pre-tx select for mcpUploads
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
    portfolioHoldings: t("portfolioHoldings"),
    categories: t("categories"),
    accounts: t("accounts"),
    mcpUploads: t("mcpUploads"),
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

// fs/promises unlink is awaited by the wipe — stub it.
vi.mock("fs/promises", () => ({
  unlink: vi.fn(async () => undefined),
}));

import { wipeUserDataAndRewrap } from "@/lib/auth/queries";

describe("wipeUserDataAndRewrap — clears MFA fields (M-6)", () => {
  it("includes mfaEnabled=0 and mfaSecret=null in the rewrap UPDATE", async () => {
    capturedUpdates.length = 0;
    await wipeUserDataAndRewrap("user-wipe-1", "$2b$12$newhash", {
      kekSalt: "salt-b64",
      dekWrapped: "wrapped-b64",
      dekWrappedIv: "iv-b64",
      dekWrappedTag: "tag-b64",
    });

    // The single UPDATE we care about is the rewrap on `users` — find any
    // SET payload that mentions kekSalt (uniquely identifies the rewrap).
    const rewrapUpdate = capturedUpdates.find(
      (u) => u.kekSalt === "salt-b64"
    );
    expect(rewrapUpdate).toBeDefined();
    expect(rewrapUpdate!.mfaEnabled).toBe(0);
    expect(rewrapUpdate!.mfaSecret).toBeNull();
    expect(rewrapUpdate!.passwordHash).toBe("$2b$12$newhash");
  });
});
