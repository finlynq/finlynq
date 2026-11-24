/**
 * Pure rules for the tag fields' suggestions (GH #449). Client-safe.
 *
 * A tag field holds one comma-separated string. Suggestions are offered for
 * the piece being typed, which is the text after the last comma.
 */

export interface TagOption {
  tag: string;
  count: number;
}

const fold = (s: string) => s.trim().toLocaleLowerCase();

/** The piece being typed: the text after the last comma, trimmed. */
export function currentTagToken(value: string): string {
  const i = value.lastIndexOf(",");
  return (i === -1 ? value : value.slice(i + 1)).trim();
}

/** The finished tags in the field (everything, trimmed, no blanks). */
export function tagsInValue(value: string): string[] {
  return value.split(",").map((t) => t.trim()).filter(Boolean);
}

/**
 * Existing tags matching the piece being typed. Tags starting with the text
 * come first, then tags containing it; each group most used first. Tags
 * already in the field (ignoring case) are left out. An empty piece
 * suggests the most used tags.
 */
export function suggestTags(all: readonly TagOption[], value: string, limit = 8): TagOption[] {
  const token = fold(currentTagToken(value));
  const i = value.lastIndexOf(",");
  const done = new Set(tagsInValue(i === -1 ? "" : value.slice(0, i)).map(fold));
  const starts: TagOption[] = [];
  const contains: TagOption[] = [];
  for (const o of all) {
    const f = fold(o.tag);
    if (!f || done.has(f)) continue;
    if (!token || f.startsWith(token)) starts.push(o);
    else if (f.includes(token)) contains.push(o);
  }
  const byUse = (a: TagOption, b: TagOption) => b.count - a.count || a.tag.localeCompare(b.tag);
  return [...starts.sort(byUse), ...contains.sort(byUse)].slice(0, limit);
}

/** Replace the piece being typed with the picked tag, ready for the next one. */
export function applyTagSuggestion(value: string, tag: string): string {
  const i = value.lastIndexOf(",");
  const head = tagsInValue(i === -1 ? "" : value.slice(0, i));
  return [...head, tag].join(", ") + ", ";
}

/** "vacations" and "vacation" are the same word for this check. */
function stem(s: string): string {
  const f = fold(s);
  if (f.length > 3 && f.endsWith("es")) return f.slice(0, -2);
  if (f.length > 2 && f.endsWith("s")) return f.slice(0, -1);
  return f;
}

/** One edit apart (insert, delete or replace one character). */
function oneEditApart(a: string, b: string): boolean {
  if (Math.abs(a.length - b.length) > 1) return false;
  let i = 0;
  while (i < a.length && i < b.length && a[i] === b[i]) i++;
  if (a.length === b.length) return a.slice(i + 1) === b.slice(i + 1);
  const [long, short] = a.length > b.length ? [a, b] : [b, a];
  return long.slice(i + 1) === short.slice(i);
}

/**
 * The existing tag a NEW tag is probably a slip for: same letters in another
 * case, singular against plural, or one typo apart (tags of 5+ letters
 * only, so "tax" and "taxi" stay apart). Null when the tag already exists
 * exactly or nothing is close. The most used close tag wins.
 */
export function nearDuplicateTag(all: readonly TagOption[], tag: string): string | null {
  const t = tag.trim();
  if (!t || all.some((o) => o.tag === t)) return null;
  const f = fold(t);
  let best: TagOption | null = null;
  for (const o of all) {
    const of = fold(o.tag);
    const close =
      of === f ||
      stem(of) === stem(f) ||
      (f.length >= 5 && of.length >= 5 && oneEditApart(of, f));
    if (close && (!best || o.count > best.count)) best = o;
  }
  return best ? best.tag : null;
}

/** Each new tag in the field that is close to an existing one. */
export function nearDuplicatesInValue(
  all: readonly TagOption[],
  value: string,
): { typed: string; existing: string }[] {
  const out: { typed: string; existing: string }[] = [];
  for (const typed of new Set(tagsInValue(value))) {
    const existing = nearDuplicateTag(all, typed);
    if (existing) out.push({ typed, existing });
  }
  return out;
}
