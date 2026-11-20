/**
 * GH #422 — /import opens on an overview of accounts with work waiting, and
 * ?account=all lists every Auto-pilot / Approve-each account in one place.
 * Manual-review accounts are never merged into that list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";
import {
  accountsNeedingAttention,
  combinedQueueAccounts,
} from "../src/components/inbox/import-overview";
import type { ReconcileSummaryApiRow } from "../src/components/inbox/reconcile-summary-panel";

const row = (over: Partial<ReconcileSummaryApiRow>): ReconcileSummaryApiRow => ({
  accountId: 1,
  accountName: "A",
  currency: "USD",
  currentBalance: 0,
  lastImportAt: null,
  lastReconciledAt: null,
  pendingCount: 0,
  pendingFiles: 0,
  mode: "manual",
  ...over,
});

describe("import overview rules", () => {
  const rows = [
    row({ accountId: 1, accountName: "Chequing", mode: "auto", pendingCount: 2 }),
    row({ accountId: 2, accountName: "Visa", mode: "approve", pendingCount: 7 }),
    row({ accountId: 3, accountName: "Savings", mode: "manual", pendingCount: 1, pendingFiles: 1 }),
    row({ accountId: 4, accountName: "Old card", mode: "manual", pendingFiles: 3 }),
    row({ accountId: 5, accountName: "Quiet", mode: "auto" }),
  ];

  it("lists only accounts with rows or statement files waiting, busiest first", () => {
    expect(accountsNeedingAttention(rows).map((r) => r.accountId)).toEqual([2, 4, 1, 3]);
  });

  it("the combined list holds Auto-pilot and Approve-each accounts with bank rows, never manual ones", () => {
    expect(combinedQueueAccounts(rows).map((r) => r.accountId)).toEqual([2, 1]);
  });

  it("an auto account whose only work is a staged file is not in the combined list", () => {
    expect(combinedQueueAccounts([row({ mode: "auto", pendingFiles: 2 })])).toEqual([]);
  });
});

describe("import page wiring", () => {
  const page = readFileSync(join(__dirname, "../src/app/(app)/import/page.tsx"), "utf8");

  it("opens the overview unless the link names an account, a tab or a handed-off file", () => {
    expect(page).toMatch(/if \(!named && !urlTab && !handoffPendingRef\.current\)/);
    expect(page).toMatch(/urlAccount === "all"/);
  });

  it("renders the overview and the combined queue", () => {
    expect(page).toMatch(/<ImportOverview/);
    expect(page).toMatch(/<AllAccountsQueue/);
  });

  it("the summary route reports each account's mode and waiting statement files", () => {
    const route = readFileSync(join(__dirname, "../src/app/api/reconcile/summary/route.ts"), "utf8");
    expect(route).toMatch(/pendingFiles:/);
    expect(route).toMatch(/mode:/);
    const lib = readFileSync(join(__dirname, "../src/lib/reconcile/summary.ts"), "utf8");
    expect(lib).toMatch(/stagedImports\.status, "pending"/);
  });
});
