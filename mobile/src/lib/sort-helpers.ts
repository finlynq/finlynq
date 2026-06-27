/**
 * Mobile port of web's dropdown-order + account-group-order pure helpers.
 *
 * Web sources mirrored (read-only):
 *   pf-app/src/lib/dropdown-order.ts  — sortByUserOrder
 *   pf-app/src/lib/accounts/groups.ts — parseGroupOrder, orderGroups, OTHER_GROUP
 *
 * All helpers are client-safe and DB-free. A malformed/missing saved order
 * degrades gracefully to the fallback comparator (never crashes).
 */

// ─── Dropdown order (account + category pickers) ─────────────────────────────

export type DropdownOrderEntry = string | number;

export type DropdownKind = "category" | "account" | "holding" | "currency";

export type DropdownOrder = {
  version: 1;
  lists: Partial<Record<DropdownKind, ReadonlyArray<DropdownOrderEntry>>>;
};

export const EMPTY_DROPDOWN_ORDER: DropdownOrder = { version: 1, lists: {} };

/**
 * Parse the raw JSON value from GET /api/settings/dropdown-order.
 * Never throws — a malformed payload returns EMPTY_DROPDOWN_ORDER.
 */
export function parseDropdownOrder(raw: unknown): DropdownOrder {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return EMPTY_DROPDOWN_ORDER;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return EMPTY_DROPDOWN_ORDER;
  if (!obj.lists || typeof obj.lists !== "object" || Array.isArray(obj.lists))
    return EMPTY_DROPDOWN_ORDER;

  const validKinds: ReadonlySet<string> = new Set(["category", "account", "holding", "currency"]);
  const cleanLists: Partial<Record<DropdownKind, ReadonlyArray<DropdownOrderEntry>>> = {};
  for (const [kind, ids] of Object.entries(obj.lists as Record<string, unknown>)) {
    if (!validKinds.has(kind)) continue;
    if (!Array.isArray(ids)) continue;
    const cleaned: DropdownOrderEntry[] = [];
    const seen = new Set<DropdownOrderEntry>();
    for (const entry of ids) {
      if (typeof entry !== "string" && typeof entry !== "number") continue;
      if (seen.has(entry)) continue;
      seen.add(entry);
      cleaned.push(entry);
    }
    cleanLists[kind as DropdownKind] = cleaned;
  }
  return { version: 1, lists: cleanLists };
}

/**
 * Sort `items` so those whose key appears in `savedOrder` lead (in saved
 * sequence), then the remainder sorted by `fallbackCompare`. Mirrors web's
 * `sortByUserOrder` exactly — stable bucket split, no double-sort.
 *
 * @param items        the list to sort
 * @param keyOf        extracts the saved-order key for each item
 * @param savedOrder   ordered keys from dropdown_order.lists[kind]; may be
 *                     undefined (user hasn't saved one yet) → pure fallback sort
 * @param fallbackCompare comparator for unpinned items
 */
export function sortByUserOrder<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => DropdownOrderEntry,
  savedOrder: ReadonlyArray<DropdownOrderEntry> | undefined,
  fallbackCompare: (a: T, b: T) => number,
): T[] {
  if (!savedOrder || savedOrder.length === 0) {
    return [...items].sort(fallbackCompare);
  }

  const orderIndex = new Map<DropdownOrderEntry, number>();
  for (let i = 0; i < savedOrder.length; i++) {
    const key = savedOrder[i];
    if (!orderIndex.has(key)) orderIndex.set(key, i);
  }

  const pinned: Array<{ item: T; idx: number }> = [];
  const unpinned: T[] = [];

  for (const item of items) {
    const key = keyOf(item);
    const idx = orderIndex.get(key);
    if (idx !== undefined) {
      pinned.push({ item, idx });
    } else {
      unpinned.push(item);
    }
  }

  pinned.sort((a, b) => a.idx - b.idx);
  unpinned.sort(fallbackCompare);

  return [...pinned.map((p) => p.item), ...unpinned];
}

// ─── Account group order (Accounts list sections) ────────────────────────────

/** The group bucket every account falls back to when it has no group. */
export const OTHER_GROUP = "Other";

export type AccountGroupType = "A" | "L";

export type AccountGroupOrder = Record<AccountGroupType, string[]>;

export const EMPTY_GROUP_ORDER: AccountGroupOrder = { A: [], L: [] };

/** Trim + reject blank/non-string values. */
function normalizeGroupName(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

/** De-dupe a list of group names preserving first-seen order, case-insensitive. */
function dedupeGroups(names: ReadonlyArray<string>): string[] {
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
 * Parse the stored `account_group_order` JSON value (from
 * GET /api/settings/account-group-order) into a per-type order map.
 * Never throws — a malformed value degrades to the empty order (alpha fallback).
 */
export function parseGroupOrder(value: unknown): AccountGroupOrder {
  if (!value) return EMPTY_GROUP_ORDER;
  let parsed: unknown = value;
  if (typeof value === "string") {
    try {
      parsed = JSON.parse(value);
    } catch {
      return EMPTY_GROUP_ORDER;
    }
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return EMPTY_GROUP_ORDER;
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
 * Order a set of group names by the user's saved order. Names in `savedOrder`
 * lead (in saved sequence); the rest follow by the fallback comparator (locale
 * alpha). "Other" is always sunk to the very end regardless of its position.
 * Mirrors web's `orderGroups` exactly.
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
