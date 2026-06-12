/**
 * FINLYNQ-148 — Account list honours the Settings → Dropdown Ordering
 * "account" sort order.
 *
 * The /accounts list previously rendered in raw API order and ignored the
 * user-configured account order. The fix wires it through the same pure
 * `sortByUserOrder` helper the account pickers use, keyed on the numeric
 * account id with a null-safe display-name fallback (account names are
 * decrypted display values — the comparator must defend against null per the
 * safeName invariant).
 *
 * These cases pin down exactly that call shape: saved order leads, the rest
 * fall back to name order, and a null name never throws.
 */

import { describe, it, expect } from "vitest";
import { sortByUserOrder, type DropdownOrderEntry } from "@/lib/dropdown-order";

type Acct = { accountId: number; accountName: string | null };

// Mirrors the /accounts page call site exactly: key on the numeric account id,
// fall back to a null-safe display-name compare.
const apply = (
  accts: Acct[],
  savedOrder: ReadonlyArray<DropdownOrderEntry> | undefined,
): Acct[] =>
  sortByUserOrder(
    accts,
    (a) => a.accountId,
    savedOrder,
    (a, b) => (a.accountName ?? "").localeCompare(b.accountName ?? ""),
  );

describe("FINLYNQ-148 account list ordering", () => {
  const accounts: Acct[] = [
    { accountId: 1, accountName: "Zebra" },
    { accountId: 2, accountName: "Apple" },
    { accountId: 3, accountName: "Mango" },
  ];

  it("falls back to name order when no saved order exists", () => {
    expect(apply(accounts, undefined).map((a) => a.accountName)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });

  it("falls back to name order for an empty saved order", () => {
    expect(apply(accounts, []).map((a) => a.accountName)).toEqual([
      "Apple",
      "Mango",
      "Zebra",
    ]);
  });

  it("pins accounts in the saved order; the rest follow by name", () => {
    // User pinned Zebra (1) then Mango (3); Apple (2) is unpinned.
    expect(apply(accounts, [1, 3]).map((a) => a.accountName)).toEqual([
      "Zebra",
      "Mango",
      "Apple",
    ]);
  });

  it("does not throw on a null/encrypted display name (null-safe fallback)", () => {
    const withNull: Acct[] = [
      { accountId: 10, accountName: null },
      { accountId: 11, accountName: "Bravo" },
      { accountId: 12, accountName: "Alpha" },
    ];
    expect(() => apply(withNull, undefined)).not.toThrow();
    // Alpha pinned first; null + Bravo fall back ("" sorts before "Bravo").
    expect(apply(withNull, [12]).map((a) => a.accountName)).toEqual([
      "Alpha",
      null,
      "Bravo",
    ]);
  });

  it("ignores saved-order ids that no longer exist", () => {
    // 99 is a deleted account — skipped silently.
    expect(apply(accounts, [99, 3, 1]).map((a) => a.accountName)).toEqual([
      "Mango",
      "Zebra",
      "Apple",
    ]);
  });
});
