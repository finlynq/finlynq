/**
 * The payee list behind the Payee field's suggestions (2026-11-24).
 *
 * SERVER ONLY (reaches the db). One store behind REST /api/payees, the web
 * transaction routes and MCP manage_transactions.
 *
 * What goes in: payees a person typed (web, phone) or an assistant recorded
 * (MCP). Imported bank rows are deliberately left out, since raw bank
 * descriptors would fill the list with near-duplicates. The list is an index
 * for suggestions only: transactions keep their own payee text and nothing
 * totals or reports from this table.
 *
 * Every write here is best-effort for its caller: `rememberPayee` never
 * throws, because a failed suggestion-list update must not fail the
 * transaction that triggered it.
 */
import { and, desc, eq, sql } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { nameLookup } from "@/lib/crypto/encrypted-columns";
import { cleanPayeeName, type PayeeOption } from "./suggest";

/** The most payees sent to the browser (most used first). */
export const MAX_PAYEES_LISTED = 3000;
/** Sources whose payees a person or an assistant chose. Imports are left out. */
export const PAYEE_SOURCES = ["manual", "mcp_http", "mcp_stdio"] as const;
const BACKFILL_KEY = "payees_backfilled";

type RowsResult<T> = { rows?: T[] } | T[];
const rowsOf = <T,>(r: unknown): T[] => (r as { rows?: T[] }).rows ?? (r as T[]);

/**
 * Add a payee to the list, or count one more use of it. `categoryId` (when
 * given) becomes the category offered with it. Never throws.
 */
export async function rememberPayee(
  userId: string,
  dek: Buffer | null,
  rawName: unknown,
  categoryId?: number | null,
): Promise<void> {
  try {
    const name = cleanPayeeName(rawName);
    if (!dek || !name) return;
    const lookup = nameLookup(dek, name);
    const cat = categoryId ?? null;
    await db.execute(sql`
      INSERT INTO payees (user_id, name_ct, name_lookup, use_count, last_category_id, last_used_at)
      VALUES (${userId}, ${encryptField(dek, name)}, ${lookup}, 1, ${cat}, NOW())
      ON CONFLICT (user_id, name_lookup) DO UPDATE
        SET use_count = payees.use_count + 1,
            last_used_at = NOW(),
            last_category_id = COALESCE(EXCLUDED.last_category_id, payees.last_category_id)
    `);
  } catch (e) {
    console.warn("[payees] remember failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * `rememberPayee` for an EDIT: only when the payee text actually changes, so
 * re-saving an imported row (the form resends its bank text) adds nothing.
 * Call BEFORE the update is written. Never throws.
 */
export async function rememberPayeeIfChanged(
  userId: string,
  dek: Buffer | null,
  transactionId: number,
  rawName: unknown,
  categoryId?: number | null,
): Promise<void> {
  try {
    const name = cleanPayeeName(rawName);
    if (!dek || !name) return;
    const rows = await db
      .select({ payee: schema.transactions.payee })
      .from(schema.transactions)
      .where(and(eq(schema.transactions.id, transactionId), eq(schema.transactions.userId, userId)))
      .limit(1);
    if (!rows.length) return;
    const stored = cleanPayeeName(tryDecryptField(dek, rows[0].payee, "transactions.payee") ?? "");
    if (stored === name) return;
    await rememberPayee(userId, dek, name, categoryId);
  } catch (e) {
    console.warn("[payees] remember-on-edit failed:", e instanceof Error ? e.message : e);
  }
}

/**
 * One-time fill from the user's existing transactions (typed or recorded by
 * an assistant, not transfers). Needs the key, so it runs the first time the
 * list is read with one. Counted per payee; the newest use sets the category.
 */
async function backfillIfNeeded(userId: string, dek: Buffer): Promise<void> {
  const done = await db
    .select({ value: schema.settings.value })
    .from(schema.settings)
    .where(and(eq(schema.settings.userId, userId), eq(schema.settings.key, BACKFILL_KEY)))
    .limit(1);
  if (done.length) return;

  const res: RowsResult<{ payee: string | null; category_id: number | null; date: string }> = await db.execute(sql`
    SELECT payee, category_id, date
      FROM transactions
     WHERE user_id = ${userId}
       AND source IN ('manual', 'mcp_http', 'mcp_stdio')
       AND link_id IS NULL
       AND payee IS NOT NULL AND payee <> ''
     ORDER BY date ASC, id ASC
  `);
  const agg = new Map<string, { name: string; count: number; categoryId: number | null }>();
  for (const r of rowsOf<{ payee: string | null; category_id: number | null; date: string }>(res)) {
    const name = cleanPayeeName(tryDecryptField(dek, r.payee, "transactions.payee") ?? "");
    if (!name) continue;
    const lookup = nameLookup(dek, name);
    const cur = agg.get(lookup);
    const cat = r.category_id != null ? Number(r.category_id) : null;
    if (cur) {
      cur.count += 1;
      if (cat != null) cur.categoryId = cat; // rows are oldest first: the newest wins
    } else {
      agg.set(lookup, { name, count: 1, categoryId: cat });
    }
  }
  const entries = [...agg.entries()];
  for (let i = 0; i < entries.length; i += 500) {
    await db
      .insert(schema.payees)
      .values(entries.slice(i, i + 500).map(([lookup, v]) => ({
        userId,
        nameCt: encryptField(dek, v.name) as string,
        nameLookup: lookup,
        useCount: v.count,
        lastCategoryId: v.categoryId,
      })))
      .onConflictDoNothing({ target: [schema.payees.userId, schema.payees.nameLookup] });
  }
  await db
    .insert(schema.settings)
    .values({ userId, key: BACKFILL_KEY, value: new Date().toISOString() })
    .onConflictDoNothing();
}

/** The user's payees, most used first. Empty without a key. */
export async function listPayees(userId: string, dek: Buffer | null): Promise<PayeeOption[]> {
  if (!dek) return [];
  try {
    await backfillIfNeeded(userId, dek);
  } catch (e) {
    // The list still works from whatever is already stored.
    console.warn("[payees] backfill failed:", e instanceof Error ? e.message : e);
  }
  const rows = await db
    .select()
    .from(schema.payees)
    .where(eq(schema.payees.userId, userId))
    .orderBy(desc(schema.payees.useCount), desc(schema.payees.lastUsedAt))
    .limit(MAX_PAYEES_LISTED);
  const out: PayeeOption[] = [];
  for (const r of rows) {
    const name = tryDecryptField(dek, r.nameCt, "payees.name_ct");
    if (!name) continue; // written under another key: not usable here
    out.push({ id: r.id, name, count: r.useCount, categoryId: r.lastCategoryId });
  }
  return out;
}

/** Take a payee out of the suggestions. Using it again adds it back. */
export async function forgetPayee(userId: string, id: number): Promise<{ removed: number }> {
  const gone = await db
    .delete(schema.payees)
    .where(and(eq(schema.payees.userId, userId), eq(schema.payees.id, id)))
    .returning({ id: schema.payees.id });
  return { removed: gone.length };
}
