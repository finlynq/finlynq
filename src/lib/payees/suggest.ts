/**
 * Pure rules for the Payee field's suggestions. Client-safe.
 */

export interface PayeeOption {
  id: number;
  name: string;
  count: number;
  /** The category most recently used with this payee, if any. */
  categoryId: number | null;
}

export const PAYEE_MAX_LENGTH = 200;

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * Payees matching the typed text: names starting with it first, then names
 * containing it, each group most used first. Nothing is offered for an empty
 * box, or when the text already is exactly one payee (nothing left to pick).
 */
export function suggestPayees(all: readonly PayeeOption[], text: string, limit = 8): PayeeOption[] {
  const t = fold(text);
  if (!t) return [];
  const starts: PayeeOption[] = [];
  const contains: PayeeOption[] = [];
  for (const o of all) {
    const f = fold(o.name);
    if (!f) continue;
    if (f.startsWith(t)) starts.push(o);
    else if (f.includes(t)) contains.push(o);
  }
  const byUse = (a: PayeeOption, b: PayeeOption) => b.count - a.count || a.name.localeCompare(b.name);
  const out = [...starts.sort(byUse), ...contains.sort(byUse)].slice(0, limit);
  if (out.length === 1 && out[0].name === text) return [];
  return out;
}

/** A payee worth keeping in the list: not blank and not absurdly long. */
export function cleanPayeeName(raw: unknown): string | null {
  if (typeof raw !== "string") return null;
  const v = raw.trim().replace(/\s+/g, " ");
  if (!v || v.length > PAYEE_MAX_LENGTH) return null;
  return v;
}
