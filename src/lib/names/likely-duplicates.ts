/**
 * Group payee or tag names that probably mean the same thing, for the
 * cleanup page (Settings → Payees & tags). Pure and client-safe.
 *
 * Two names are linked when, after reducing each to its "core" (lowercase,
 * punctuation gone, store numbers and card-processor prefixes like "SQ *"
 * dropped):
 *   - the cores are equal ("Corner Cafe" / "SQ *CORNER CAFE #1234");
 *   - one core starts the other on a word boundary ("Braces Haven" /
 *     "BRACES HAVEN NEPEAN"), the shorter at least 4 letters; a ONE-word
 *     name only when the other adds exactly one word ("Costco" / "COSTCO
 *     WHOLESALE", but not "Transfer" / "Transfer to TFSA");
 *   - they differ only by a plural ("Vacation" / "Vacations");
 *   - they are one typo apart, both at least 6 letters and neither holding a
 *     number ("Costco" / "Cotsco" is 2 edits and stays apart).
 * Linked names are joined into groups (a chain A-B, B-C makes one group).
 *
 * Only suggestions: nothing is merged until the person picks names and
 * confirms. Short numbers stay part of the core, so "Buy MNT +36 shares" and
 * "Buy MNT +40 shares" are NOT grouped.
 */

export interface NameItem {
  key: string;
  name: string;
  count: number;
}

/** Card-processor and terminal prefixes that say nothing about the payee. */
const NOISE_TOKENS = new Set(["sq", "tst", "pos", "sp", "pp"]);

/** "SQ *CORNER CAFE #1234" → "corner cafe". */
export function nameCore(name: string): string {
  const tokens = name
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter(Boolean);
  const kept = tokens.filter((t, i) => {
    // A store or terminal number: 4+ characters, mostly digits. Shorter
    // numbers stay ("+36 shares", "verify-450"): they usually mean something.
    const digits = (t.match(/\p{N}/gu) ?? []).length;
    if (t.length >= 4 && digits / t.length >= 0.5) return false;
    // A processor prefix, only at the very start.
    if (i === 0 && NOISE_TOKENS.has(t) && tokens.length > 1) return false;
    return true;
  });
  return kept.join(" ");
}

function stem(core: string): string {
  if (core.length > 4 && core.endsWith("es")) return core.slice(0, -2);
  if (core.length > 3 && core.endsWith("s")) return core.slice(0, -1);
  return core;
}

function oneEditApart(a: string, b: string): boolean {
  if (a === b || Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/** Whether two names are probably the same payee or tag. */
export function likelySame(aName: string, bName: string): boolean {
  const a = nameCore(aName);
  const b = nameCore(bName);
  if (!a || !b) return false;
  if (a === b) return true;
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  if (short.replace(/ /g, "").length >= 4 && long.startsWith(short + " ")) {
    // A one-word name only matches one more word ("Costco" / "COSTCO
    // WHOLESALE"), so a generic word like "Transfer" does not pull in every
    // "Transfer to …". Two or more words may be followed by anything
    // ("Braces Haven" / "BRACES HAVEN NEPEAN ON").
    const extra = long.slice(short.length + 1).split(" ").length;
    if (short.includes(" ") || extra === 1) return true;
  }
  if (stem(a) === stem(b)) return true;
  const hasNumber = /\p{N}/u.test(aName) || /\p{N}/u.test(bName);
  if (!hasNumber && a.length >= 6 && b.length >= 6 && oneEditApart(a, b)) return true;
  return false;
}

/**
 * Groups of two or more likely-duplicate names, biggest total use first.
 * Inside a group, the most used name comes first (the suggested one to keep).
 */
export function findLikelyDuplicates<T extends NameItem>(items: readonly T[]): T[][] {
  const n = items.length;
  const parent = Array.from({ length: n }, (_, i) => i);
  const find = (i: number): number => {
    while (parent[i] !== i) {
      parent[i] = parent[parent[i]];
      i = parent[i];
    }
    return i;
  };
  const cores = items.map((it) => nameCore(it.name));
  // Bucket by the first word of the core: every rule above needs the same
  // first word, except a typo inside the first word, checked by a second
  // bucket on the first three letters.
  const buckets = new Map<string, number[]>();
  const add = (k: string, i: number) => {
    const list = buckets.get(k);
    if (list) list.push(i);
    else buckets.set(k, [i]);
  };
  cores.forEach((c, i) => {
    if (!c) return;
    add(`w:${stem(c.split(" ")[0])}`, i);
    add(`p:${c.slice(0, 3)}`, i);
  });
  for (const idx of buckets.values()) {
    if (idx.length < 2 || idx.length > 400) continue;
    for (let x = 0; x < idx.length; x++) {
      for (let y = x + 1; y < idx.length; y++) {
        const i = idx[x];
        const j = idx[y];
        if (find(i) === find(j)) continue;
        if (likelySame(items[i].name, items[j].name)) parent[find(i)] = find(j);
      }
    }
  }
  const groups = new Map<number, T[]>();
  items.forEach((it, i) => {
    const r = find(i);
    const g = groups.get(r);
    if (g) g.push(it);
    else groups.set(r, [it]);
  });
  const out = [...groups.values()].filter((g) => g.length > 1);
  for (const g of out) g.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
  const total = (g: T[]) => g.reduce((s, it) => s + it.count, 0);
  return out.sort((a, b) => total(b) - total(a));
}
