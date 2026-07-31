/**
 * Pure grouping + naming for the dashboard "Spending by Category" card.
 *
 * The card reads a plaintext `categoryName` per slice. Category names are
 * encrypted (`categories.name_ct`), so the route must decrypt them before the
 * payload leaves the server — the bug this fixes shipped `categoryNameCt`
 * (ciphertext) and no `categoryName`, so the client's `?? "Uncategorized"`
 * fallback fired for every slice even though the data was fully categorised.
 *
 * Decryption is injected (`decrypt`) so this stays pure and testable, and so a
 * cold DEK degrades to a stable "Category #<id>" label rather than a false
 * "Uncategorized" — mirroring `safeName`, the same fallback the sibling
 * income/expense breakdown already uses.
 */

import { safeName } from "@/lib/safe-name";

export interface RawSpendingSlice {
  categoryId: number | null;
  categoryNameCt: string | null;
  categoryGroup: string | null;
  categoryType: string | null;
  /** Per-slice amount, already converted to the display currency by the caller. */
  total: number;
}

export interface SpendingByCategorySlice {
  categoryId: number | null;
  categoryName: string;
  categoryGroup: string | null;
  categoryType: string | null;
  total: number;
}

/**
 * Group raw spending slices by category and attach a display `categoryName`.
 * `decrypt` turns a `categoryNameCt` into plaintext (or null when unavailable).
 */
export function buildSpendingByCategory(
  slices: readonly RawSpendingSlice[],
  decrypt: (nameCt: string | null) => string | null,
): SpendingByCategorySlice[] {
  const byCategory = new Map<string | number, SpendingByCategorySlice>();

  for (const s of slices) {
    // Null-category rows share a group-keyed bucket, mirroring the route.
    const key = s.categoryId ?? `null:${s.categoryGroup}`;
    const existing = byCategory.get(key);
    if (existing) {
      existing.total += s.total;
      continue;
    }
    const categoryName =
      s.categoryId == null
        ? "Uncategorized"
        : safeName(decrypt(s.categoryNameCt), "Category", s.categoryId);
    byCategory.set(key, {
      categoryId: s.categoryId,
      categoryName,
      categoryGroup: s.categoryGroup,
      categoryType: s.categoryType,
      total: s.total,
    });
  }

  return Array.from(byCategory.values());
}
