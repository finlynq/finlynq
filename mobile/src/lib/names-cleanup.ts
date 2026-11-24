/**
 * Payees & tags cleanup on the phone (More → Payees & tags): types and
 * wording for the web's Settings → Payees & tags, over the same routes
 * (GET/POST /api/payees/manage, GET/POST /api/transactions/tags/manage).
 *
 * Merge, rename and move-to-note change the text on TRANSACTIONS only; what
 * the bank sent (bank statement rows) is never changed. Keep the wording in
 * step with pf-app/src/app/(app)/settings/payees-tags/page.tsx.
 */

export type NameKind = "payees" | "tags";

export interface NameUsage {
  /** Payees: the server's lookup key. Tags: the tag itself. */
  key: string;
  name: string;
  count: number;
  lastDate: string | null;
  /** Payees only: other spellings of the same payee. */
  variants?: string[];
  /** Payees only: the suggestion-list row, or null when not suggested. */
  suggestionId?: number | null;
}

export interface NameList {
  items: NameUsage[];
  /** Likely-duplicate groups, as keys, most used name first. */
  groups: string[][];
  locked: boolean;
}

export const NAMES_INTRO =
  "Merge names that mean the same thing, rename them, or move text that is not a payee into the note. Changes apply to your transactions. What your bank sent is never changed.";
export const NAMES_LOCKED = "Your payees and tags are encrypted and your session is locked. Sign in again to manage them.";
export const NAMES_LOAD_ERROR = "Couldn't load the list. Pull down to try again.";
export const DUPLICATES_HINT =
  "Names that look like the same one: other case or spacing, one starting the other, singular and plural, or one typo. Nothing changes until you merge.";
export const NO_DUPLICATES = "No likely duplicates found.";

export function plural(n: number, one: string, many: string): string {
  return `${n.toLocaleString()} ${n === 1 ? one : many}`;
}

export function noun(kind: NameKind, many = false): string {
  if (kind === "payees") return many ? "payees" : "payee";
  return many ? "tags" : "tag";
}

/** Transactions a change of these names touches. */
export function affectedCount(items: readonly NameUsage[]): number {
  return items.reduce((n, i) => n + i.count, 0);
}

/** Group keys → their entries, dropping keys the list no longer has. */
export function resolveGroups(list: NameList): NameUsage[][] {
  const byKey = new Map(list.items.map((i) => [i.key, i]));
  return list.groups
    .map((g) => g.map((k) => byKey.get(k)).filter((x): x is NameUsage => !!x))
    .filter((g) => g.length > 1);
}

/** Names whose text contains the search (case-insensitive). */
export function filterNames(items: readonly NameUsage[], query: string): NameUsage[] {
  const q = query.trim().toLowerCase();
  return q ? items.filter((i) => i.name.toLowerCase().includes(q)) : [...items];
}

/** The success line after a merge or rename. */
export function mergedMessage(updated: number, target: string, rulesAdded = 0): string {
  const rules = rulesAdded ? ` Added ${plural(rulesAdded, "rule", "rules")} for future imports.` : "";
  return `Updated ${plural(updated, "transaction", "transactions")} to "${target}".${rules}`;
}

/** A tag name the server accepts. */
export function tagNameError(name: string): string | null {
  const t = name.trim();
  if (!t) return "Give the tag a name.";
  if (t.includes(",")) return "A tag cannot contain a comma.";
  if (t.length > 100) return "A tag can be at most 100 characters.";
  return null;
}
