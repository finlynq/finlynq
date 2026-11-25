/**
 * "(Blank)" in the Transactions category filters (GH #454): rows with no
 * category at all. Both the Category column filter (a multi-select, sent as
 * `categoryIds`) and the top-bar category picker (`categoryId`) accept the
 * token `none` beside numeric ids, so "Groceries + (Blank)" keeps showing new
 * uncategorized imports. Distinct from a real category named "Uncategorized"
 * (the catch-all rule's category, GH #456), which is an ordinary id.
 *
 * Pure, client-safe; the route parses with `parseCategoryFilter`.
 */

/** The filter value that stands for "no category". */
export const NO_CATEGORY_FILTER_VALUE = "none";
export const NO_CATEGORY_FILTER_LABEL = "(Blank)";

/** Parse a `categoryIds` / `categoryId` query value: numeric ids plus `none`. */
export function parseCategoryFilter(raw: string | null | undefined): { ids: number[]; includeNone: boolean } | undefined {
  if (!raw) return undefined;
  let includeNone = false;
  const ids: number[] = [];
  for (const part of raw.split(",")) {
    const token = part.trim();
    if (token === NO_CATEGORY_FILTER_VALUE) {
      includeNone = true;
      continue;
    }
    const n = parseInt(token, 10);
    if (Number.isFinite(n) && n > 0 && String(n) === token) ids.push(n);
  }
  if (ids.length === 0 && !includeNone) return undefined;
  return { ids, includeNone };
}
