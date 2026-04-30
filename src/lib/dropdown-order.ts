/**
 * Dropdown order helpers — pure logic for the per-user customizable order of
 * Combobox dropdown lists (categories, accounts, holdings, currencies).
 *
 * Persisted via `/api/settings/dropdown-order` (one `settings.value` JSON row
 * per user, key `dropdown_order`). Identifiers are opaque (numeric IDs for
 * accounts/holdings, ISO codes for currencies, HMAC `name_lookup` hashes for
 * categories) so display names never enter the settings table — see issue #21
 * "Privacy note" for rationale.
 *
 * The sort algorithm is stable: items whose key appears in `savedOrder` are
 * pinned to the top in `savedOrder` order; remaining items follow in
 * `fallbackCompare` order. Missing keys in `savedOrder` are skipped silently.
 */

export type DropdownKind = "category" | "account" | "holding" | "currency";

export type DropdownOrderEntry = string | number;

export type DropdownOrder = {
  version: 1;
  lists: Partial<Record<DropdownKind, ReadonlyArray<DropdownOrderEntry>>>;
};

export const EMPTY_DROPDOWN_ORDER: DropdownOrder = { version: 1, lists: {} };

/**
 * Bucket items into "pinned" (key in savedOrder) and "unpinned"; pinned bucket
 * sorted by savedOrder index, unpinned bucket sorted by fallbackCompare;
 * concatenate.
 *
 * @param items the list to sort
 * @param keyOf extracts the saved-order key for each item
 * @param savedOrder ordered list of keys (typically from
 *   `dropdown_order.lists[kind]`); may be undefined if the user hasn't saved
 *   one yet — falls back entirely to `fallbackCompare`
 * @param fallbackCompare comparator for unpinned items (and as tie-break for
 *   duplicates in savedOrder)
 */
export function sortByUserOrder<T>(
  items: ReadonlyArray<T>,
  keyOf: (item: T) => DropdownOrderEntry,
  savedOrder: ReadonlyArray<DropdownOrderEntry> | undefined,
  fallbackCompare: (a: T, b: T) => number
): T[] {
  if (!savedOrder || savedOrder.length === 0) {
    return [...items].sort(fallbackCompare);
  }

  const orderIndex = new Map<DropdownOrderEntry, number>();
  for (let i = 0; i < savedOrder.length; i += 1) {
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

/**
 * Validate a parsed JSON value as a `DropdownOrder`. Returns null when the
 * shape is wrong; safe to use after `JSON.parse(row.value)` in API routes.
 */
export function parseDropdownOrder(raw: unknown): DropdownOrder | null {
  if (!raw || typeof raw !== "object") return null;
  const obj = raw as Record<string, unknown>;
  if (obj.version !== 1) return null;
  if (!obj.lists || typeof obj.lists !== "object") return null;

  const validKinds: ReadonlySet<DropdownKind> = new Set([
    "category",
    "account",
    "holding",
    "currency",
  ]);

  const cleanLists: Partial<Record<DropdownKind, ReadonlyArray<DropdownOrderEntry>>> = {};
  for (const [kind, ids] of Object.entries(obj.lists as Record<string, unknown>)) {
    if (!validKinds.has(kind as DropdownKind)) continue;
    if (!Array.isArray(ids)) continue;
    const cleaned = ids.filter(
      (entry): entry is DropdownOrderEntry =>
        typeof entry === "string" || typeof entry === "number"
    );
    cleanLists[kind as DropdownKind] = Array.from(new Set(cleaned));
  }

  return { version: 1, lists: cleanLists };
}
