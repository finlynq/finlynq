/**
 * GH #421 — SimpleFIN pending charges.
 *
 * The sync must ASK SimpleFIN for pending rows (`pending: true`), or the
 * Pending charges snapshot stays empty. Asking is safe because the transform
 * routes pending rows to `acct.pending` (the snapshot) and never into the rows
 * that get staged/booked: a hold is never a transaction until the bank posts it.
 */
import { readFileSync } from "fs";
import { join } from "path";
import { describe, expect, it } from "vitest";
import { simplefinToRawTransactions } from "../packages/import-connectors/src/simplefin/transform";

const root = join(__dirname, "..");
const read = (p: string) => readFileSync(join(root, p), "utf8");

describe("SimpleFIN pending charges (GH #421)", () => {
  it("the sync requests pending rows", () => {
    const src = read("src/lib/external-import/simplefin-orchestrator.ts");
    expect(src).toMatch(/fetchAccounts\(\{\s*startDate,\s*pending:\s*true\s*\}\)/);
  });

  it("the sync never asks the transform to include pending rows in the staged rows", () => {
    const src = read("src/lib/external-import/simplefin-orchestrator.ts");
    expect(src).not.toMatch(/includePending/);
  });

  it("a pending row lands in the snapshot, not in the rows that get booked", () => {
    const result = simplefinToRawTransactions({
      errors: [],
      accounts: [
        {
          id: "ACT-1",
          name: "Checking",
          currency: "USD",
          balance: "100.00",
          "balance-date": 1763600000,
          transactions: [
            { id: "TX-posted", posted: 1763500000, amount: "-12.50", description: "COFFEE" },
            {
              id: "TX-hold",
              posted: 0,
              transacted_at: 1763590000,
              amount: "-80.00",
              description: "GAS STATION",
              pending: true,
            },
          ],
        },
      ],
    } as never);
    const acct = result.accounts[0];
    expect(acct.rows.map((r) => r.fitId)).toEqual(["TX-posted"]);
    expect(acct.pending.map((p) => p.fitId)).toEqual(["TX-hold"]);
    expect(acct.pending[0].date).toBe("2025-11-19");
  });

  it("the pending route narrows to one account but stays owner-scoped", () => {
    const route = read("src/app/api/settings/bank-feeds/simplefin/pending/route.ts");
    expect(route).toMatch(/searchParams\.get\("accountId"\)/);
    const reader = read("src/lib/external-import/simplefin-pending.ts");
    // Both branches of the WHERE keep the user_id predicate.
    const where = reader.slice(reader.indexOf("opts.accountId != null"));
    expect(where.slice(0, 400).match(/simplefinPendingTransactions\.userId, userId/g)?.length).toBe(2);
  });

  it("the account page shows the account's pending charges", () => {
    const page = read("src/app/(app)/accounts/[id]/page.tsx");
    expect(page).toMatch(/<AccountPendingChargesCard accountId=\{account\.id\} \/>/);
  });
});
