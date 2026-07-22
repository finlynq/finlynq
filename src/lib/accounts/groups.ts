/**
 * Account-group customization — PURE, DB-FREE helpers (FINLYNQ-179).
 *
 * `accounts.group` is a free-text column — the backend has always been
 * flexible; the historical constraint was purely a hard-coded UI dropdown.
 *
 * This module is **client-safe**: it contains ONLY pure functions + constants
 * and imports NOTHING from the DB layer. Client components (`group-field.tsx`,
 * `manage-groups-dialog.tsx`, the `"use client"` accounts page) import from
 * HERE. The server-only DB/settings/rename functions live in the sibling
 * [groups-server.ts](./groups-server.ts) (which imports `@/db` → `pg`) and are
 * imported ONLY by API routes — keeping `pg`/`dns` out of the browser bundle.
 *
 * Single source of truth for:
 *   1. The seeded default group names per account type (A=Asset, L=Liability).
 *      The create/edit combobox suggests these UNION the user's own existing
 *      groups (live-derived, no migration).
 *   2. The per-user group display ORDER schema + parse (the `account_group_order`
 *      settings value), de-dupe, suggestion-union, and section-ordering.
 *
 * The pure cores never throw — a malformed stored order degrades to "no custom
 * order" (alphabetical/default fallback) rather than breaking the accounts page.
 */

export const ACCOUNT_GROUP_ORDER_KEY = "account_group_order";

/** The group bucket every account falls back to when it has no group. */
export const OTHER_GROUP = "Other";

export type AccountGroupType = "A" | "L";

/**
 * Seeded default group names per account type. The create/edit combobox starts
 * from these; the user can pick any of them OR type a brand-new custom name.
 * Single source of truth — the accounts page imports this rather than carrying
 * its own copy.
 */
export const ACCOUNT_GROUP_DEFAULTS: Record<AccountGroupType, string[]> = {
  A: ["Cash", "Checking", "Savings", "Investment", "Property", OTHER_GROUP],
  L: ["Credit Card", "Loan", "Mortgage", OTHER_GROUP],
};

/**
 * Canonical set of account GROUP names treated as spendable "cash" for
 * cash-flow scoping. The cash-flow forecast default scope, the financial-health
 * liquid-assets filter, and the AI chat balance summary all read THIS set
 * (GH #307: the forecast previously hardcoded only "Banks"/"Cash Accounts",
 * silently excluding the app's own Checking/Savings/Cash defaults). Extend HERE
 * — never re-list these strings inline.
 *
 * NOTE: an investment account (`is_investment=true`) is never "cash" regardless
 * of its group — callers MUST AND this with `is_investment === false`.
 */
export const CASH_GROUP_NAMES = [
  "Banks",
  "Cash Accounts",
  "Cash",
  "Checking",
  "Chequing",
  "Savings",
] as const;

const CASH_GROUP_SET = new Set<string>(CASH_GROUP_NAMES.map((g) => g.toLowerCase()));

/**
 * True when a free-text account group is one of the canonical spendable-cash
 * groups. Case-insensitive + trims; null/blank → false.
 */
export function isCashGroup(group: string | null | undefined): boolean {
  const name = normalizeGroupName(group);
  return name != null && CASH_GROUP_SET.has(name.toLowerCase());
}

/** A per-type ordered list of group names. */
export type AccountGroupOrder = Record<AccountGroupType, string[]>;

export const EMPTY_GROUP_ORDER: AccountGroupOrder = { A: [], L: [] };

/** Trim + reject blank/non-string. Exported so the server module reuses the
 *  exact same normalization in the bulk-rename guard. */
export function normalizeGroupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** De-dupe a list of group names preserving first-seen order (case-sensitive,
 *  but case-insensitively de-duped so "Cash" and "cash" don't both appear). */
export function dedupeGroups(names: ReadonlyArray<string>): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of names) {
    const name = normalizeGroupName(raw);
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(name);
  }
  return out;
}

/**
 * Parse the stored `account_group_order` value into a per-type order map.
 * Never throws — a malformed/legacy value degrades to the empty order so the
 * accounts page just falls back to alphabetical/default ordering.
 */
export function parseGroupOrder(value: string | null | undefined): AccountGroupOrder {
  if (!value) return { A: [], L: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(value);
  } catch {
    return { A: [], L: [] };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { A: [], L: [] };
  }
  const obj = parsed as Record<string, unknown>;
  const forType = (t: AccountGroupType): string[] => {
    const arr = obj[t];
    if (!Array.isArray(arr)) return [];
    return dedupeGroups(arr.map((v) => (typeof v === "string" ? v : "")));
  };
  return { A: forType("A"), L: forType("L") };
}

/**
 * Suggestion list for the create/edit combobox for a given account type:
 * the seeded defaults UNION the user's existing group names for that type,
 * de-duped (defaults lead). Pure.
 */
export function groupSuggestions(
  type: string,
  existingGroups: ReadonlyArray<string>,
): string[] {
  const defaults = ACCOUNT_GROUP_DEFAULTS[type as AccountGroupType] ?? [OTHER_GROUP];
  return dedupeGroups([...defaults, ...existingGroups]);
}

/**
 * Order a set of group names by the user's saved order. Names present in the
 * saved order lead (in saved sequence); the rest follow by the fallback
 * comparator (default: locale-aware alpha). "Other" is always sunk to the end
 * regardless of where it sits. Pure.
 */
export function orderGroups(
  groups: ReadonlyArray<string>,
  savedOrder: ReadonlyArray<string>,
  fallbackCompare: (a: string, b: string) => number = (a, b) => a.localeCompare(b),
): string[] {
  const present = dedupeGroups(groups);
  const orderIndex = new Map<string, number>();
  dedupeGroups(savedOrder).forEach((g, i) => orderIndex.set(g.toLowerCase(), i));

  const rank = (g: string): number => {
    if (g.toLowerCase() === OTHER_GROUP.toLowerCase()) return Number.MAX_SAFE_INTEGER;
    const idx = orderIndex.get(g.toLowerCase());
    return idx === undefined ? Number.MAX_SAFE_INTEGER - 1 : idx;
  };

  return present.slice().sort((a, b) => {
    const ra = rank(a);
    const rb = rank(b);
    if (ra !== rb) return ra - rb;
    return fallbackCompare(a, b);
  });
}
