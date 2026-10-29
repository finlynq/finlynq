/**
 * Display currency → saved "Currencies you use" list.
 *
 * In-app feedback 2026-10-23: a user could report in Swiss francs but not open
 * a CHF account. Every record form offers `active_currencies`; a DERIVED list
 * starts from the display currency, but a SAVED one (any edit on Settings →
 * "Currencies you use") never picked up a new display currency. Fix:
 * `setDisplayCurrency` adds the currency to a saved list that lacks it.
 *
 *   tc-1 — pure `addToSavedActiveCurrencies`: no saved list / unreadable value
 *          → null (nothing to write); already present (any case) → null;
 *          missing → appended, sorted.
 *   tc-2 — a saved list without the new display currency is updated with it.
 *   tc-3 — a saved list that already has it, or no saved list, is not written.
 *   tc-4 — it heals on a no-op write too (same display currency as before).
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

process.env.PF_JWT_SECRET = "test-jwt-secret-for-vitest-32chars!!";
process.env.PF_PEPPER = process.env.PF_PEPPER ?? "test-pepper-32chars-for-vitest-only!!";
process.env.PF_STAGING_KEY = process.env.PF_STAGING_KEY ?? "test-staging-key-32chars-for-vitest!";

// The snapshot invalidation on a real change uses the global db; it is not
// what this file tests, so it just has to answer.
vi.mock("@/db", async () => {
  const schema = await vi.importActual<typeof import("@/db/schema-pg")>("@/db/schema-pg");
  return {
    db: { execute: () => Promise.resolve({ rows: [], rowCount: 0 }) },
    schema,
  };
});
vi.mock("@/lib/fx/reporting-amount", () => ({
  recomputeReportingAmounts: () => Promise.resolve(),
}));

import {
  addToSavedActiveCurrencies,
  setDisplayCurrency,
} from "@/lib/settings/display-currency";

const USER = "user-dc-active-list";

/**
 * Stub for the `db` param. `setDisplayCurrency` selects twice, in order: the
 * prior display currency, then the saved active list.
 */
function stubDb(prior: string | null, savedActive: string | null) {
  const selects = [
    prior == null ? [] : [{ value: prior }],
    savedActive == null ? [] : [{ value: savedActive }],
  ];
  const updates: Array<Record<string, unknown>> = [];
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selects.shift() ?? []) }),
      }),
    }),
    insert: () => ({
      values: () => ({ onConflictDoUpdate: () => Promise.resolve() }),
    }),
    update: () => ({
      set: (v: Record<string, unknown>) => ({
        where: () => {
          updates.push(v);
          return Promise.resolve();
        },
      }),
    }),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any;
  return { db, updates };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("addToSavedActiveCurrencies (pure)", () => {
  it("tc-1: writes only when a readable saved list lacks the currency", () => {
    expect(addToSavedActiveCurrencies(null, "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies("", "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies("not json", "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies('{"a":1}', "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies('["USD", 3]', "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies('["USD","CHF"]', "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies('["usd","chf"]', "CHF")).toBeNull();
    expect(addToSavedActiveCurrencies('["USD","EUR"]', "CHF")).toEqual(["CHF", "EUR", "USD"]);
  });
});

describe("setDisplayCurrency → saved active list", () => {
  it("tc-2: adds the new display currency to a saved list that lacks it", async () => {
    const { db, updates } = stubDb("USD", '["USD","EUR"]');
    const { changed } = await setDisplayCurrency(db, USER, "chf");
    expect(changed).toBe(true);
    expect(updates).toEqual([{ value: JSON.stringify(["CHF", "EUR", "USD"]) }]);
  });

  it("tc-3: leaves a list that has it, and a derived (unsaved) list, alone", async () => {
    const has = stubDb("USD", '["CHF","USD"]');
    await setDisplayCurrency(has.db, USER, "CHF");
    expect(has.updates).toEqual([]);

    const derived = stubDb("USD", null);
    await setDisplayCurrency(derived.db, USER, "CHF");
    expect(derived.updates).toEqual([]);
  });

  it("tc-4: heals an older mismatch on a no-op write", async () => {
    const { db, updates } = stubDb("CHF", '["USD"]');
    const { changed } = await setDisplayCurrency(db, USER, "CHF");
    expect(changed).toBe(false);
    expect(updates).toEqual([{ value: JSON.stringify(["CHF", "USD"]) }]);
  });
});
