/**
 * Account scoping for the Reports page (2026-08-23).
 *
 * One parser shared by every report endpoint, because the Reports page fans a
 * single user choice out across four of them (trends, income-statement,
 * balance-sheet, year-over-year). If two endpoints disagreed about what
 * `accountIds=` means, the summary tiles would be scoped one way and the
 * Income Statement below them another — a discrepancy nobody would spot,
 * because both numbers look plausible on their own.
 *
 * EMPTY MEANS "ALL", NOT "NONE". An absent, blank, or fully-malformed param
 * returns `null` = apply no filter. This follows the rule established for the
 * admin table's column filters: an empty filter must never reach the wire,
 * because server-side it means "match nothing" and would render an empty report
 * while the UI still shows a filter as active. The picker enforces the same
 * reading — unticking everything shows "All accounts", not a blank report.
 *
 * NOT A SECURITY BOUNDARY, and deliberately so. Every caller already ANDs
 * `transactions.user_id = <user>` into the same WHERE, so an id belonging to
 * another user simply matches zero rows. This parser's job is to reject
 * garbage, not to authorize; keeping it a pure function (no db, no user) is
 * what makes it testable.
 */

/** Query-string key every report endpoint reads. */
export const ACCOUNT_IDS_PARAM = "accountIds";

/**
 * Parse `accountIds=1,2,3` into a de-duped, sorted list of positive ints.
 * Returns `null` when no filter should be applied.
 *
 * Non-numeric, zero, negative and non-integer entries are dropped rather than
 * rejecting the whole request: a partly-garbled param should still scope to the
 * ids that ARE valid, and if none survive it degrades to "all accounts" — the
 * same end state as not filtering, never an empty report.
 */
export function parseAccountIdsParam(value: string | null | undefined): number[] | null {
  if (!value) return null;
  const ids = value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isInteger(n) && n > 0);
  if (ids.length === 0) return null;
  return [...new Set(ids)].sort((a, b) => a - b);
}

/**
 * Build the query-string value for a selection. Returns `null` when the
 * selection should not be sent at all (empty = all accounts), so callers can
 * omit the param entirely rather than sending `accountIds=`.
 */
export function serializeAccountIds(ids: readonly number[] | null | undefined): string | null {
  if (!ids || ids.length === 0) return null;
  const clean = [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
  return clean.length ? clean.join(",") : null;
}

/**
 * Trigger label for the picker. Named here rather than in the component so the
 * "empty means all" reading is stated once, next to the parser that implements
 * it, instead of being re-derived in the UI.
 */
export function accountFilterLabel(selected: readonly number[], total: number): string {
  if (selected.length === 0 || (total > 0 && selected.length === total)) return "All accounts";
  return selected.length === 1 ? "1 account" : `${selected.length} accounts`;
}
