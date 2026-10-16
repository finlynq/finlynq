/**
 * A waiting email a rule matched can be recorded with that rule from the Email
 * tab, over a possible-duplicate hold ("Record anyway"), and the tab can say
 * why it was held. Pins three helpers in process-pending-inbox.ts:
 *
 *   ruleRecordOptions     — one rule → record-options builder, shared by the
 *                           sweep's auto-record and the tab's "record with rule".
 *   matchedRuleHold       — the rule and the transaction it is held against.
 *                           The check ignores the payee, so a Spotify charge is
 *                           held against an Amazon one of the same amount.
 *   recordWithMatchedRule — refuses an email with no active matched rule.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

const TEST_DEK = Buffer.alloc(32, 0xaa);

// Hoisted Drizzle mock — a queue of result arrays dequeued by any terminal
// (await / .limit() chain / .all() / .get() / .returning()).
const dbHolder = vi.hoisted(() => ({ results: [] as unknown[][] }));
vi.mock("@/db", () => {
  function makeChain(): Record<string, unknown> {
    const chain: Record<string, unknown> = {};
    const passthrough = [
      "select", "from", "where", "leftJoin", "orderBy", "groupBy",
      "values", "set", "insert", "update", "delete", "limit",
    ];
    for (const m of passthrough) chain[m] = vi.fn(() => chain);
    const resolve = () => (dbHolder.results.length ? dbHolder.results.shift()! : []);
    chain.returning = vi.fn(() => resolve());
    chain.all = vi.fn(() => resolve());
    chain.get = vi.fn(() => resolve()[0]);
    chain.then = (r: (v: unknown) => unknown) => r(resolve());
    return chain;
  }
  return {
    db: makeChain(),
    schema: {
      emailInbox: { id: {}, userId: {}, action: {}, sourceKind: {}, stagedImportId: {}, receivedAt: {}, matchedRuleId: {} },
      stagedTransactions: { id: {}, stagedImportId: {}, date: {}, amount: {}, payee: {}, encryptionTier: {} },
      transactions: { id: {}, userId: {}, accountId: {}, date: {}, amount: {}, payee: {} },
    },
  };
});

const rules = vi.hoisted(() => ({ active: [] as unknown[] }));
vi.mock("@/lib/email-rules/load", () => ({
  loadActiveEmailRules: vi.fn(async () => rules.active),
  firstMatchingRule: vi.fn(() => null),
}));

vi.mock("@/lib/transfer", () => ({ createTransferPair: vi.fn() }));
vi.mock("@/lib/bank-ledger", () => ({ upsertBankTransaction: vi.fn() }));
vi.mock("@/lib/import-hash", () => ({
  generateImportHash: () => "hash-1",
  checkDuplicates: vi.fn(async () => new Set<string>()),
}));
vi.mock("@/lib/crypto/staging-envelope", () => ({ decryptStaged: (v: string | null) => v }));
vi.mock("@/lib/crypto/envelope", () => ({
  encryptField: (_dek: Buffer, v: string) => v,
  tryDecryptField: (_dek: Buffer, v: string) => v,
}));
vi.mock("@/lib/transactions/sign-category-invariant", () => ({ validateSignVsCategoryById: vi.fn(async () => null) }));
vi.mock("@/lib/mcp/user-tx-cache", () => ({ invalidateUser: vi.fn() }));

import {
  ruleRecordOptions,
  matchedRuleHold,
  recordWithMatchedRule,
} from "@/lib/email-import/process-pending-inbox";

const SPOTIFY_RULE = {
  id: 22,
  name: "Spotify",
  conditions: [],
  accountId: 635,
  categoryId: 504,
  transferDestAccountId: null,
  mode: "auto" as const,
  flipSign: false,
  dateSource: "parsed" as const,
  payeeOverride: "Spotify",
  currency: null,
  priority: 0,
};

beforeEach(() => {
  vi.clearAllMocks();
  dbHolder.results = [];
  rules.active = [SPOTIFY_RULE];
});

describe("ruleRecordOptions", () => {
  it("records with the rule's account, category, currency and mapping", () => {
    expect(ruleRecordOptions(SPOTIFY_RULE, "auto_recorded")).toEqual({
      accountId: 635,
      categoryId: 504,
      transferDestAccountId: null,
      currencyOverride: null,
      matchedRuleId: 22,
      finalAction: "auto_recorded",
      force: false,
      transform: { flipSign: false, dateSource: "parsed", payeeOverride: "Spotify" },
    });
  });

  it("forces only when asked (Record anyway)", () => {
    expect(ruleRecordOptions(SPOTIFY_RULE, "manually_recorded", true)).toMatchObject({
      finalAction: "manually_recorded",
      force: true,
    });
  });
});

describe("matchedRuleHold", () => {
  const inbox = { matchedRuleId: 22, action: "needs_review", sourceKind: "body", stagedImportId: "s-1", receivedAt: new Date("2026-10-13T12:00:00Z") };
  const staged = { date: "2026-10-13", amount: -15.81, payee: "Spotify P47F54492B", encryptionTier: "user" };

  it("names the transaction the email is held against, whatever its payee", async () => {
    dbHolder.results = [
      [inbox],
      [staged],
      // findExistingLedgerDuplicate: an Amazon charge of the same amount 4 days earlier.
      [{ id: 250879, date: "2026-10-09", amount: -15.81 }],
      [{ id: 250879, date: "2026-10-09", amount: -15.81, payee: "Amazon Marketplace" }],
    ];
    expect(await matchedRuleHold("u1", TEST_DEK, "e1")).toEqual({
      ruleId: 22,
      ruleName: "Spotify",
      mode: "auto",
      accountId: 635,
      canRecord: true,
      duplicate: { transactionId: 250879, date: "2026-10-09", amount: -15.81, payee: "Amazon Marketplace" },
    });
  });

  it("reports no duplicate when nothing on the account is within 4 days", async () => {
    dbHolder.results = [[inbox], [staged], [{ id: 1, date: "2026-10-01", amount: -15.81 }]];
    expect((await matchedRuleHold("u1", TEST_DEK, "e1"))?.duplicate).toBeNull();
  });

  it("says a rule without a category can't record on its own", async () => {
    rules.active = [{ ...SPOTIFY_RULE, categoryId: null }];
    dbHolder.results = [[inbox], [staged], []];
    expect(await matchedRuleHold("u1", TEST_DEK, "e1")).toMatchObject({ canRecord: false, duplicate: null });
  });

  it("is null when no active rule is stamped on the email", async () => {
    dbHolder.results = [[{ ...inbox, matchedRuleId: null }]];
    expect(await matchedRuleHold("u1", TEST_DEK, "e1")).toBeNull();

    rules.active = []; // the stamped rule was since deactivated or deleted
    dbHolder.results = [[inbox]];
    expect(await matchedRuleHold("u1", TEST_DEK, "e1")).toBeNull();
  });
});

describe("recordWithMatchedRule", () => {
  it("refuses an email with no matched rule, writing nothing", async () => {
    dbHolder.results = [[{ matchedRuleId: null, action: "needs_review", sourceKind: "body", stagedImportId: "s-1", receivedAt: new Date() }]];
    expect(await recordWithMatchedRule("u1", TEST_DEK, "e1", true)).toEqual({
      status: "invalid",
      reason: "no_matched_rule",
    });
  });
});
