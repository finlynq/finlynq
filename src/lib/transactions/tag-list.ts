/**
 * SERVER ONLY. Every tag a user has put on a transaction, with how many
 * transactions carry it (GH #427: the Reports page's tag picker).
 *
 * Tags are encrypted at rest, so this decrypts each tagged row's tag list
 * and counts in memory, splitting on commas the same way the `tag` filter
 * matches (search-match.ts: comma-split, trimmed, exact).
 */
import { and, eq, isNotNull, ne } from "drizzle-orm";
import { db, schema } from "@/db";
import { tryDecryptField } from "@/lib/crypto/envelope";

export interface TagCount {
  tag: string;
  count: number;
}

/** Split one transaction's tag string the way the `tag` filter does. */
export function splitTags(tags: string | null | undefined): string[] {
  if (!tags) return [];
  return [...new Set(tags.split(",").map((t) => t.trim()).filter(Boolean))];
}

/** Tags sorted by name (case-insensitive). Empty without a key. */
export async function listUserTags(userId: string, dek: Buffer | null): Promise<TagCount[]> {
  if (!dek) return [];
  const t = schema.transactions;
  const rows = await db
    .select({ tags: t.tags })
    .from(t)
    .where(and(eq(t.userId, userId), isNotNull(t.tags), ne(t.tags, "")));
  const counts = new Map<string, number>();
  for (const r of rows) {
    const plain = tryDecryptField(dek, r.tags, "transaction-tags");
    for (const tag of splitTags(plain)) counts.set(tag, (counts.get(tag) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => a.tag.localeCompare(b.tag, undefined, { sensitivity: "base" }));
}
