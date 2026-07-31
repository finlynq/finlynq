/**
 * FINLYNQ — the dashboard "Spending by Category" card showed *every* slice as
 * "Uncategorized".
 *
 * Root cause: the /api/dashboard route shipped each spending slice with the
 * ENCRYPTED `categoryNameCt` and never decrypted it, while the client read a
 * plaintext `categoryName` field that was never populated — so `?? "Uncategorized"`
 * fired for every row (and the collapsed duplicates tripped React's key warning).
 * Meanwhile the data was fine: 99% of expenses were categorised in the DB.
 *
 * `buildSpendingByCategory` is the pure grouping+naming step behind that card.
 * It groups raw slices by category and emits a plaintext `categoryName`,
 * decrypting via an injected `decrypt` fn so it degrades gracefully when the
 * DEK is cold (null decrypt → "Category #<id>", never a false "Uncategorized").
 */

import { describe, it, expect } from "vitest";
import {
  buildSpendingByCategory,
  type RawSpendingSlice,
} from "@/lib/dashboard/spending-by-category";

function slice(overrides: Partial<RawSpendingSlice> = {}): RawSpendingSlice {
  return {
    categoryId: 1,
    categoryNameCt: "v1:ct-groceries",
    categoryGroup: null,
    categoryType: "E",
    total: -10,
    ...overrides,
  };
}

describe("buildSpendingByCategory", () => {
  it("emits a plaintext categoryName decrypted from categoryNameCt", () => {
    const decrypt = (ct: string | null) =>
      ct === "v1:ct-groceries" ? "Groceries" : null;
    const out = buildSpendingByCategory(
      [slice({ categoryId: 1, categoryNameCt: "v1:ct-groceries", total: -42 })],
      decrypt,
    );
    expect(out).toEqual([
      expect.objectContaining({ categoryId: 1, categoryName: "Groceries" }),
    ]);
  });

  it("keeps distinct categories distinct (no collapsing to one name)", () => {
    const names: Record<string, string> = {
      "v1:a": "Groceries",
      "v1:b": "Rent",
    };
    const decrypt = (ct: string | null) => (ct ? names[ct] ?? null : null);
    const out = buildSpendingByCategory(
      [
        slice({ categoryId: 1, categoryNameCt: "v1:a", total: -30 }),
        slice({ categoryId: 2, categoryNameCt: "v1:b", total: -70 }),
      ],
      decrypt,
    );
    expect(out.map((s) => s.categoryName).sort()).toEqual(["Groceries", "Rent"]);
  });

  it("labels a genuinely null category as 'Uncategorized'", () => {
    const out = buildSpendingByCategory(
      [slice({ categoryId: null, categoryNameCt: null, total: -5 })],
      () => null,
    );
    expect(out[0].categoryName).toBe("Uncategorized");
  });

  it("falls back to 'Category #<id>' when the DEK is cold (decrypt returns null) — never a false 'Uncategorized'", () => {
    const out = buildSpendingByCategory(
      [slice({ categoryId: 7, categoryNameCt: "v1:locked", total: -12 })],
      () => null, // cold DEK
    );
    expect(out[0].categoryName).toBe("Category #7");
    expect(out[0].categoryName).not.toBe("Uncategorized");
  });

  it("sums totals per category across currency/reporting slices", () => {
    const decrypt = () => "Groceries";
    const out = buildSpendingByCategory(
      [
        slice({ categoryId: 1, categoryNameCt: "v1:a", total: -30 }),
        slice({ categoryId: 1, categoryNameCt: "v1:a", total: -12 }),
      ],
      decrypt,
    );
    expect(out).toHaveLength(1);
    expect(out[0].total).toBe(-42);
  });
});
