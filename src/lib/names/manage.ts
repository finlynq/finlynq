/**
 * Cleanup of payees and tags (Settings → Payees & tags, 2026-11-24).
 *
 * SERVER ONLY (reaches the db). Behind /api/payees/manage and
 * /api/transactions/tags/manage.
 *
 * What changes: the payee or tags text on rows of `transactions` (every
 * source: typed, MCP, created from bank rows) and the tags on their split
 * rows, plus the payee suggestion list. What NEVER changes: `bank_transactions`
 * and pending statement files (`staged_*`): what the bank sent stays as sent.
 * Transactions are tied to bank rows by id (transaction_bank_links,
 * transactions.bank_transaction_id) and duplicate detection reads a
 * fingerprint stored at creation, so renaming a payee breaks neither.
 *
 * Every change runs in ONE database transaction and stamps `updated_at`.
 */
import { and, eq, inArray, isNotNull, ne, sql, type SQL } from "drizzle-orm";
import { db, schema, withDbTransaction } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { nameLookup } from "@/lib/crypto/encrypted-columns";
import { encryptRuleFields } from "@/lib/rules/crypto";
import { todayISO } from "@/lib/utils/date";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";
import { cleanPayeeName } from "@/lib/payees/suggest";
import { splitTags } from "@/lib/transactions/tag-list";
import { findLikelyDuplicates } from "./likely-duplicates";

export const MAX_MERGE_SOURCES = 50;
const UPDATE_CHUNK = 500;
/** At most this many "rename on import" rules from one merge. */
const MAX_RULES_PER_MERGE = 20;

export class NameCleanupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NameCleanupError";
  }
}

const rowsOf = <T,>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? (r as T[]);

/** Write new ciphertext onto many rows of one table in chunks. */
async function writeColumn(
  table: "transactions" | "transaction_splits",
  column: "payee" | "tags",
  updates: Array<{ id: number; value: string | null }>,
  userScope: SQL,
): Promise<void> {
  for (let i = 0; i < updates.length; i += UPDATE_CHUNK) {
    const chunk = updates.slice(i, i + UPDATE_CHUNK);
    const values = sql.join(
      chunk.map((u) => sql`(${u.id}::int, ${u.value}::text)`),
      sql`, `,
    );
    if (table === "transactions") {
      await db.execute(sql`
        UPDATE transactions AS t
           SET ${sql.raw(column)} = v.val, updated_at = NOW()
          FROM (VALUES ${values}) AS v(id, val)
         WHERE t.id = v.id AND ${userScope}
      `);
    } else {
      await db.execute(sql`
        UPDATE transaction_splits AS s
           SET ${sql.raw(column)} = v.val
          FROM (VALUES ${values}) AS v(id, val)
         WHERE s.id = v.id AND ${userScope}
      `);
    }
  }
}

// ─── Payees ────────────────────────────────────────────────────────────────

export interface PayeeUsage {
  /** nameLookup of the payee: case and spacing do not matter. */
  key: string;
  /** The spelling used most often. */
  name: string;
  /** Other spellings of the same key ("STARBUCKS" beside "Starbucks"). */
  variants: string[];
  /** Transactions carrying it. */
  count: number;
  lastDate: string | null;
  /** Row id in the suggestion list, or null when it is not suggested. */
  suggestionId: number | null;
}

/** Every payee on the user's transactions, plus suggested ones not used. */
export async function listPayeeUsage(userId: string, dek: Buffer): Promise<PayeeUsage[]> {
  const res = await db.execute(sql`
    SELECT payee, date FROM transactions
     WHERE user_id = ${userId} AND payee IS NOT NULL AND payee <> ''
  `);
  const byKey = new Map<string, { spellings: Map<string, number>; count: number; lastDate: string | null }>();
  for (const r of rowsOf<{ payee: string; date: string }>(res)) {
    const name = cleanPayeeName(tryDecryptField(dek, r.payee, "transactions.payee") ?? "");
    if (!name) continue;
    const key = nameLookup(dek, name);
    let e = byKey.get(key);
    if (!e) {
      e = { spellings: new Map(), count: 0, lastDate: null };
      byKey.set(key, e);
    }
    e.count += 1;
    e.spellings.set(name, (e.spellings.get(name) ?? 0) + 1);
    if (!e.lastDate || r.date > e.lastDate) e.lastDate = r.date;
  }
  const suggested = await db
    .select({ id: schema.payees.id, lookup: schema.payees.nameLookup, nameCt: schema.payees.nameCt })
    .from(schema.payees)
    .where(eq(schema.payees.userId, userId));
  const suggestionByKey = new Map(suggested.map((s) => [s.lookup, s] as const));

  const out: PayeeUsage[] = [];
  for (const [key, e] of byKey) {
    const spellings = [...e.spellings.entries()].sort((a, b) => b[1] - a[1]);
    out.push({
      key,
      name: spellings[0][0],
      variants: spellings.slice(1).map(([s]) => s),
      count: e.count,
      lastDate: e.lastDate,
      suggestionId: suggestionByKey.get(key)?.id ?? null,
    });
  }
  for (const s of suggested) {
    if (byKey.has(s.lookup)) continue;
    const name = tryDecryptField(dek, s.nameCt, "payees.name_ct");
    if (!name) continue;
    out.push({ key: s.lookup, name, variants: [], count: 0, lastDate: null, suggestionId: s.id });
  }
  return out.sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function payeeDuplicateGroups(list: PayeeUsage[]): string[][] {
  return findLikelyDuplicates(list).map((g) => g.map((p) => p.key));
}

/**
 * Give every transaction whose payee is one of `sourceKeys` the payee
 * `target` (a merge; a rename is a merge of one). The suggestion list ends
 * with one entry for `target` carrying the sources' uses, when any source
 * was suggested. With `addImportRules`, a rule per old spelling renames it
 * on future imports.
 */
export async function mergePayees(
  userId: string,
  dek: Buffer,
  sourceKeys: string[],
  rawTarget: string,
  addImportRules: boolean,
): Promise<{ updated: number; rulesAdded: number }> {
  const target = cleanPayeeName(rawTarget);
  if (!target) throw new NameCleanupError("Give the payee a name.");
  const sources = new Set(sourceKeys.filter((k) => typeof k === "string" && k));
  if (sources.size === 0) throw new NameCleanupError("Pick at least one payee.");
  if (sources.size > MAX_MERGE_SOURCES) {
    throw new NameCleanupError(`At most ${MAX_MERGE_SOURCES} payees can be merged at once.`);
  }
  const targetKey = nameLookup(dek, target);

  const result = await withDbTransaction(async () => {
    const res = await db.execute(sql`
      SELECT id, payee FROM transactions
       WHERE user_id = ${userId} AND payee IS NOT NULL AND payee <> ''
    `);
    const updates: Array<{ id: number; value: string | null }> = [];
    const oldSpellings = new Set<string>();
    for (const r of rowsOf<{ id: number; payee: string }>(res)) {
      const name = cleanPayeeName(tryDecryptField(dek, r.payee, "transactions.payee") ?? "");
      if (!name) continue;
      if (!sources.has(nameLookup(dek, name))) continue;
      if (name !== target) {
        updates.push({ id: Number(r.id), value: encryptField(dek, target) });
        oldSpellings.add(name);
      }
    }
    await writeColumn("transactions", "payee", updates, sql`t.user_id = ${userId}`);

    // Suggestion list: fold the sources (and an existing target) into one.
    const keys = [...new Set([...sources, targetKey])];
    const existing = await db
      .select()
      .from(schema.payees)
      .where(and(eq(schema.payees.userId, userId), inArray(schema.payees.nameLookup, keys)));
    if (existing.length > 0) {
      const newest = [...existing].sort((a, b) => b.lastUsedAt.getTime() - a.lastUsedAt.getTime());
      const uses = existing.reduce((s, p) => s + p.useCount, 0);
      const categoryId = newest.find((p) => p.lastCategoryId != null)?.lastCategoryId ?? null;
      await db
        .delete(schema.payees)
        .where(and(eq(schema.payees.userId, userId), inArray(schema.payees.nameLookup, keys)));
      await db.insert(schema.payees).values({
        userId,
        nameCt: encryptField(dek, target) as string,
        nameLookup: targetKey,
        useCount: Math.max(1, uses),
        lastCategoryId: categoryId,
        lastUsedAt: newest[0].lastUsedAt,
      });
    }

    let rulesAdded = 0;
    if (addImportRules) {
      const spellings = [...oldSpellings]
        .filter((s) => s.toLowerCase() !== target.toLowerCase())
        .slice(0, MAX_RULES_PER_MERGE);
      for (const from of spellings) {
        const enc = encryptRuleFields(dek, {
          name: `Rename "${from}" to "${target}"`,
          conditions: { all: [{ field: "payee" as const, op: "exact" as const, value: from }] },
          actions: [{ kind: "rename_payee" as const, to: target }],
        });
        await db.insert(schema.transactionRules).values({
          userId,
          name: enc.name,
          conditions: enc.conditions as unknown as object,
          actions: enc.actions as unknown as object,
          isActive: true,
          priority: 0,
          createdAt: todayISO(),
        });
        rulesAdded += 1;
      }
    }
    return { updated: updates.length, rulesAdded };
  });
  invalidateUser(userId);
  return result;
}

// ─── Tags ──────────────────────────────────────────────────────────────────

export interface TagUsage {
  key: string;
  name: string;
  count: number;
  lastDate: string | null;
}

/** Every tag on the user's transactions with its use count and last use. */
export async function listTagUsage(userId: string, dek: Buffer): Promise<TagUsage[]> {
  const t = schema.transactions;
  const rows = await db
    .select({ tags: t.tags, date: t.date })
    .from(t)
    .where(and(eq(t.userId, userId), isNotNull(t.tags), ne(t.tags, "")));
  const by = new Map<string, { count: number; lastDate: string | null }>();
  for (const r of rows) {
    for (const tag of splitTags(tryDecryptField(dek, r.tags, "transaction-tags"))) {
      const e = by.get(tag) ?? { count: 0, lastDate: null };
      e.count += 1;
      if (!e.lastDate || r.date > e.lastDate) e.lastDate = r.date;
      by.set(tag, e);
    }
  }
  return [...by.entries()]
    .map(([name, e]) => ({ key: name, name, count: e.count, lastDate: e.lastDate }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name));
}

export function tagDuplicateGroups(list: TagUsage[]): string[][] {
  return findLikelyDuplicates(list).map((g) => g.map((t) => t.key));
}

/**
 * Replace the tags `sources` with `target` on every transaction and split
 * row (a merge or a rename), or remove them when `target` is null. A row
 * that ends up with the same tag twice keeps it once.
 */
export async function replaceTags(
  userId: string,
  dek: Buffer,
  sourceNames: string[],
  rawTarget: string | null,
): Promise<{ updated: number }> {
  const sources = new Set(sourceNames.map((s) => (typeof s === "string" ? s.trim() : "")).filter(Boolean));
  if (sources.size === 0) throw new NameCleanupError("Pick at least one tag.");
  if (sources.size > MAX_MERGE_SOURCES) {
    throw new NameCleanupError(`At most ${MAX_MERGE_SOURCES} tags can be changed at once.`);
  }
  let target: string | null = null;
  if (rawTarget !== null) {
    target = rawTarget.trim();
    if (!target) throw new NameCleanupError("Give the tag a name.");
    if (target.includes(",")) throw new NameCleanupError("A tag cannot contain a comma.");
    if (target.length > 100) throw new NameCleanupError("A tag can be at most 100 characters.");
  }
  const rewrite = (plain: string | null): string | null => {
    const tags = splitTags(plain);
    if (!tags.some((t) => sources.has(t))) return null; // untouched
    const next: string[] = [];
    for (const t of tags) {
      const v = sources.has(t) ? target : t;
      if (v && !next.includes(v)) next.push(v);
    }
    return next.join(", ");
  };

  const result = await withDbTransaction(async () => {
    const txRes = await db.execute(sql`
      SELECT id, tags FROM transactions
       WHERE user_id = ${userId} AND tags IS NOT NULL AND tags <> ''
    `);
    const txUpdates: Array<{ id: number; value: string | null }> = [];
    for (const r of rowsOf<{ id: number; tags: string }>(txRes)) {
      const next = rewrite(tryDecryptField(dek, r.tags, "transaction-tags"));
      if (next === null) continue;
      txUpdates.push({ id: Number(r.id), value: next ? encryptField(dek, next) : "" });
    }
    await writeColumn("transactions", "tags", txUpdates, sql`t.user_id = ${userId}`);

    const splitRes = await db.execute(sql`
      SELECT s.id, s.tags FROM transaction_splits s
        JOIN transactions t ON t.id = s.transaction_id
       WHERE t.user_id = ${userId} AND s.tags IS NOT NULL AND s.tags <> ''
    `);
    const splitUpdates: Array<{ id: number; value: string | null }> = [];
    for (const r of rowsOf<{ id: number; tags: string }>(splitRes)) {
      const next = rewrite(tryDecryptField(dek, r.tags, "transaction_splits.tags"));
      if (next === null) continue;
      splitUpdates.push({ id: Number(r.id), value: next ? encryptField(dek, next) : "" });
    }
    await writeColumn(
      "transaction_splits",
      "tags",
      splitUpdates,
      sql`s.transaction_id IN (SELECT id FROM transactions WHERE user_id = ${userId})`,
    );
    return { updated: txUpdates.length };
  });
  invalidateUser(userId);
  return result;
}
