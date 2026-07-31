/**
 * Pins `getPageNumbers`, the ellipsis logic behind the shared <Pagination>.
 *
 * WHY THIS EXISTS
 * ---------------
 * This function was lifted out of `transactions-workspace.tsx` so the admin
 * users table could reuse it rather than fork a third copy. Transactions has
 * shipped with this exact output for a long time, so these tests are a
 * regression pin on the EXTRACTION: the sequences below are what the old inline
 * implementation produced. If a future edit changes them, it changes the
 * transactions pager too.
 */

import { describe, it, expect } from "vitest";
import { getPageNumbers } from "@/components/ui/pagination";

describe("getPageNumbers", () => {
  it("renders every page in full at 7 or fewer", () => {
    expect(getPageNumbers(0, 1)).toEqual([0]);
    expect(getPageNumbers(0, 3)).toEqual([0, 1, 2]);
    expect(getPageNumbers(3, 7)).toEqual([0, 1, 2, 3, 4, 5, 6]);
  });

  it("returns an empty list when there are no pages", () => {
    // Lets the caller render the control unconditionally on an empty result
    // set — which the admin table does whenever a filter matches nothing.
    expect(getPageNumbers(0, 0)).toEqual([]);
    expect(getPageNumbers(0, -1)).toEqual([]);
  });

  it("collapses the tail when near the start", () => {
    expect(getPageNumbers(0, 20)).toEqual([0, 1, "ellipsis", 19]);
    expect(getPageNumbers(1, 20)).toEqual([0, 1, 2, "ellipsis", 19]);
  });

  it("collapses both sides in the middle", () => {
    expect(getPageNumbers(10, 20)).toEqual([
      0,
      "ellipsis",
      9,
      10,
      11,
      "ellipsis",
      19,
    ]);
  });

  it("collapses the head when near the end", () => {
    expect(getPageNumbers(19, 20)).toEqual([0, "ellipsis", 18, 19]);
    expect(getPageNumbers(18, 20)).toEqual([0, "ellipsis", 17, 18, 19]);
  });

  it("never emits a duplicate or out-of-range page index", () => {
    for (let totalPages = 1; totalPages <= 30; totalPages++) {
      for (let page = 0; page < totalPages; page++) {
        const nums = getPageNumbers(page, totalPages).filter(
          (p): p is number => p !== "ellipsis",
        );
        expect(new Set(nums).size).toBe(nums.length);
        for (const n of nums) {
          expect(n).toBeGreaterThanOrEqual(0);
          expect(n).toBeLessThan(totalPages);
        }
        // The current page must always be reachable as a button.
        expect(nums).toContain(page);
      }
    }
  });
});
