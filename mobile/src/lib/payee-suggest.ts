/**
 * Pure rules for the Payee field's suggestions. A MIRROR of the web's
 * pf-app/src/lib/payees/suggest.ts: change one, change the other
 * (src/__tests__/nameInputs.test.tsx runs the web's cases).
 */

export interface PayeeOption {
  id: number;
  name: string;
  count: number;
  /** The category most recently used with this payee, if any. */
  categoryId: number | null;
}

const fold = (s: string) => s.trim().replace(/\s+/g, " ").toLocaleLowerCase();

/**
 * Payees matching the typed text: names starting with it first, then names
 * containing it, each group most used first. Nothing is offered for an empty
 * box, or when the text already is exactly one payee (nothing left to pick).
 */
export function suggestPayees(all: readonly PayeeOption[], text: string, limit = 6): PayeeOption[] {
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
