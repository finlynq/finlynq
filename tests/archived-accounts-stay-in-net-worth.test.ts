/**
 * Static gate: archived accounts stay in the net-worth money math.
 *
 * WHY THIS EXISTS
 * ---------------
 * `accounts.archived` is a LIST/PICKER visibility flag. It does not say the
 * money never existed. Four cash queries used to filter on it, and because
 * `portfolio_snapshots` history is REBUILT rather than appended, that filter
 * did more than hide today's balance — it rewrote the past and then deleted it:
 *
 *   1. `getCashTxFingerprint` dropped the archived account's transactions, so
 *      the row count changed → the snapshot set read as stale → a rebuild ran.
 *   2. `getCashDailyDeltasByAccount` (the builder's input, and therefore the
 *      `keepAccountIds` the reaper spares) no longer named that account.
 *   3. `deleteOrphanCashSnapshots` duly deleted every stored snapshot it had.
 *   4. `getCashSnapshotsInRange` filtered it out of the read path too, so even
 *      surviving rows never reached the chart.
 *
 * Measured on dev 2026-09-12 against the demo user: archiving a $2,157.52
 * savings account moved the SIX-MONTHS-AGO net-worth point from -11,177.42 to
 * -12,217.15 and removed the account from all 181 points in the series. The
 * investment snapshot reader never had the filter, which is why an archived
 * brokerage behaved differently from an archived chequing account.
 *
 * These four must move together. A filter in the fingerprint but not the
 * builder (or vice versa) is the exact combination that destroys stored
 * history, so this gate asserts on all four at once rather than one at a time.
 *
 * PURE SOURCE READS. They can't prove runtime behaviour — the dev repro does
 * that — they catch the regression that actually bit us: someone re-adding
 * `archived` to "make archived accounts disappear" from one of these.
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "fs";
import { join } from "path";

const ROOT = join(__dirname, "..");

function read(rel: string): string {
  return readFileSync(join(ROOT, rel), "utf8");
}

/** Body of `export async function <name>(` up to the next top-level `export`. */
function fnBody(src: string, name: string): string {
  const start = src.indexOf(`export async function ${name}(`);
  expect(start, `${name} not found — was it renamed?`).toBeGreaterThan(-1);
  const after = src.slice(start + 1);
  const end = after.indexOf("\nexport ");
  return end === -1 ? after : after.slice(0, end);
}

describe("archived accounts stay in the net-worth money math", () => {
  const queries = read("src/lib/queries.ts");

  // All four read the same account set. Named individually so a failure says
  // which one drifted.
  const LOCKSTEP = [
    "getCashDailyDeltas",
    "getCashDailyDeltasByAccount",
    "getCashSnapshotsInRange",
    "getCashTxFingerprint",
  ] as const;

  for (const name of LOCKSTEP) {
    it(`${name} does not filter on accounts.archived`, () => {
      const body = fnBody(queries, name);
      expect(
        body.includes("accounts.archived"),
        `${name} filters archived accounts. That hides an archived account's ` +
          `balance from the net-worth chart, and because these four must agree, ` +
          `it also lets the snapshot reaper DELETE its stored history. See the ` +
          `header of this test.`,
      ).toBe(false);
    });
  }

  it("getAccounts still hides archived by default (it IS the picker source)", () => {
    // The counterpart invariant: the change above must not leak archived
    // accounts into every dropdown. `getAccounts` keeps its opt-in flag.
    const body = fnBody(queries, "getAccounts");
    expect(body).toContain("includeArchived");
    expect(body).toContain("eq(accounts.archived, false)");
  });

  it("the cash-snapshot cron does not skip users whose cash accounts are archived", () => {
    const cron = read("src/lib/cron/portfolio-snapshots.ts");
    const start = cron.indexOf("const cashUsers");
    expect(start).toBeGreaterThan(-1);
    const block = cron.slice(start, start + 400);
    expect(block).not.toContain("archived");
  });
});

describe("archived accounts reach the surfaces that show money", () => {
  it("the dashboard balances query always includes archived accounts", () => {
    const route = read("src/app/api/dashboard/route.ts");
    expect(route).toContain("getAccountBalances(userId, { includeArchived: true })");
  });

  it("the net-worth-history live override includes archived accounts", () => {
    // It feeds BOTH today's point and the breakdown's accountId → name map;
    // without archived rows an archived account rendered as "Account #609".
    const route = read("src/app/api/net-worth-history/route.ts");
    expect(route).toContain("getAccountBalances(userId, { includeArchived: true })");
  });

  it("the account detail page asks for archived accounts", () => {
    // Otherwise an archived account's page renders its loading skeleton
    // forever — and since Unarchive lives only in that page's Edit dialog,
    // archiving was a one-way door in the web UI.
    const page = read("src/app/(app)/accounts/[id]/page.tsx");
    const fetches = page.match(/fetch\("\/api\/accounts[^"]*"\)/g) ?? [];
    expect(fetches.length).toBeGreaterThan(0);
    for (const f of fetches) expect(f).toContain("includeArchived=1");
  });

  it("the transactions lookups ask for archived accounts", () => {
    // The transaction LIST never filtered archived, but this lookup did — so
    // the account filter could not name an archived account, and the
    // accountType filter silently dropped its rows.
    const hook = read("src/app/(app)/transactions/_hooks/use-tx-prefs.ts");
    expect(hook).toContain('swrKey("/api/accounts?includeArchived=1")');
  });

  it("create-mode account pickers still exclude archived accounts", () => {
    // The counterpart: including them in the lookups must not offer an
    // archived account as a destination for a NEW transaction. Edit mode
    // keeps them (`!!editId ||`) so an existing row still shows its account.
    const dialog = read("src/components/transactions/transaction-dialog.tsx");
    const pickers = dialog.match(/\.filter\(\(a\) => !!editId \|\|[^)]*\)\)/g) ?? [];
    expect(pickers.length).toBeGreaterThan(0);
    for (const p of pickers) expect(p).toContain("a.archived !== true");
  });
});
