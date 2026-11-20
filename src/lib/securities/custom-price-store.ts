/**
 * Manual price marks (`custom_security_prices`) — the ONE place that reads and
 * writes them. SERVER ONLY.
 *
 * Shared by REST `/api/securities/prices` (the Manage prices dialog) and MCP
 * `manage_security_prices` (GH #394: an assistant reads quotes from another
 * source, such as a broker's own MCP server, and hands the marks to Finlynq).
 *
 * A mark is an effective-from `(date, price)` point in the SECURITY's currency
 * (taken from the securities row, never the caller); the price at date D is the
 * latest mark on or before D, and before the first mark the holding values at 0.
 * Marks are used only while the security's `price_source` is 'manual'.
 *
 * Plain numbers, like price_cache: no DEK. Every query is owner-scoped.
 *
 * Net-worth history is stored (`portfolio_snapshots`), so a change to the marks
 * of a manually priced security stamps `portfolio_snapshot_dirty` from the
 * earliest date it affects; the next chart load rebuilds from there. Marks on an
 * auto-priced security change nothing a chart shows, so they stamp nothing.
 */

import { and, asc, desc, eq, inArray, sql } from "drizzle-orm";

import { db, schema, withDbTransaction } from "@/db";
import { markSnapshotsDirty } from "@/lib/portfolio/snapshots/dirty";
import { isReasonableAmount } from "@/lib/utils/number";

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Most marks one call may write or delete. */
export const MAX_MARKS_PER_CALL = 1000;

export type PriceSource = "auto" | "manual";

export interface PricedSecurity {
  id: number;
  currency: string;
  priceSource: PriceSource;
}

export interface CustomPriceMark {
  id: number;
  date: string;
  price: number;
  currency: string;
}

export class CustomPriceError extends Error {
  constructor(
    public readonly code: "not_found" | "invalid",
    message: string,
  ) {
    super(message);
    this.name = "CustomPriceError";
  }
}

/** The caller's security, or null (unknown id or another user's). */
export async function findUserSecurity(
  userId: string,
  securityId: number,
): Promise<PricedSecurity | null> {
  const row = await db
    .select({
      id: schema.securities.id,
      currency: schema.securities.currency,
      priceSource: schema.securities.priceSource,
    })
    .from(schema.securities)
    .where(and(eq(schema.securities.id, securityId), eq(schema.securities.userId, userId)))
    .get();
  if (!row) return null;
  return { id: row.id, currency: row.currency, priceSource: row.priceSource === "manual" ? "manual" : "auto" };
}

async function requireSecurity(userId: string, securityId: number): Promise<PricedSecurity> {
  const sec = await findUserSecurity(userId, securityId);
  if (!sec) throw new CustomPriceError("not_found", "Security not found");
  return sec;
}

/** A security's marks, newest first (all of them, or the newest `limit`). */
export async function listCustomPrices(
  userId: string,
  securityId: number,
  opts: { limit?: number; order?: "asc" | "desc" } = {},
): Promise<CustomPriceMark[]> {
  const base = db
    .select({
      id: schema.customSecurityPrices.id,
      date: schema.customSecurityPrices.date,
      price: schema.customSecurityPrices.price,
      currency: schema.customSecurityPrices.currency,
    })
    .from(schema.customSecurityPrices)
    .where(
      and(
        eq(schema.customSecurityPrices.userId, userId),
        eq(schema.customSecurityPrices.securityId, securityId),
      ),
    )
    .orderBy(
      opts.order === "asc"
        ? asc(schema.customSecurityPrices.date)
        : desc(schema.customSecurityPrices.date),
    );
  const rows = opts.limit ? await base.limit(opts.limit) : await base;
  return rows.map((r) => ({ ...r, price: Number(r.price) }));
}

/** The security a mark belongs to (owner-scoped), or null. */
export async function securityIdForMark(userId: string, markId: number): Promise<number | null> {
  const row = await db
    .select({ securityId: schema.customSecurityPrices.securityId })
    .from(schema.customSecurityPrices)
    .where(and(eq(schema.customSecurityPrices.id, markId), eq(schema.customSecurityPrices.userId, userId)))
    .get();
  return row?.securityId ?? null;
}

/** First and last mark dates and the mark count, per security (for a summary). */
export async function summarizeCustomPrices(
  userId: string,
): Promise<Map<number, { count: number; firstDate: string; lastDate: string }>> {
  const rows = await db
    .select({
      securityId: schema.customSecurityPrices.securityId,
      count: sql<number>`count(*)::int`,
      firstDate: sql<string>`min(${schema.customSecurityPrices.date})`,
      lastDate: sql<string>`max(${schema.customSecurityPrices.date})`,
    })
    .from(schema.customSecurityPrices)
    .where(eq(schema.customSecurityPrices.userId, userId))
    .groupBy(schema.customSecurityPrices.securityId);
  return new Map(rows.map((r) => [r.securityId, { count: Number(r.count), firstDate: r.firstDate, lastDate: r.lastDate }]));
}

/**
 * Check marks before anything is written: real YYYY-MM-DD dates, finite
 * non-negative prices in range, no date twice. Throws `CustomPriceError`
 * naming the first bad mark, so a batch is all-or-nothing.
 */
export function validateMarks(marks: ReadonlyArray<{ date: string; price: number }>): void {
  if (marks.length === 0) throw new CustomPriceError("invalid", "Give at least one price");
  if (marks.length > MAX_MARKS_PER_CALL) {
    throw new CustomPriceError("invalid", `At most ${MAX_MARKS_PER_CALL} prices per call`);
  }
  const seen = new Set<string>();
  for (const m of marks) {
    const real = ISO_DATE.test(m.date) && !Number.isNaN(Date.parse(`${m.date}T00:00:00Z`)) &&
      new Date(`${m.date}T00:00:00Z`).toISOString().slice(0, 10) === m.date;
    if (!real) throw new CustomPriceError("invalid", `"${m.date}" is not a date (use YYYY-MM-DD)`);
    if (!Number.isFinite(m.price) || !isReasonableAmount(m.price)) {
      throw new CustomPriceError("invalid", `The price for ${m.date} is out of range`);
    }
    if (m.price < 0) throw new CustomPriceError("invalid", `The price for ${m.date} cannot be negative`);
    if (seen.has(m.date)) throw new CustomPriceError("invalid", `${m.date} is given twice`);
    seen.add(m.date);
  }
}

const earliest = (dates: string[]) => dates.reduce((a, b) => (b < a ? b : a));

/**
 * Upsert marks (one per date: a repeat date replaces that day's price), all in
 * one transaction. Returns the security so a caller can say when the marks are
 * not in use (an auto-priced security).
 */
export async function upsertCustomPrices(
  userId: string,
  securityId: number,
  marks: ReadonlyArray<{ date: string; price: number }>,
): Promise<{ security: PricedSecurity; written: number; ids: number[] }> {
  validateMarks(marks);
  const security = await requireSecurity(userId, securityId);
  const ids = await withDbTransaction(async () => {
    const out: number[] = [];
    for (const m of marks) {
      const inserted = await db
        .insert(schema.customSecurityPrices)
        .values({ userId, securityId, date: m.date, price: m.price, currency: security.currency })
        .onConflictDoUpdate({
          target: [
            schema.customSecurityPrices.userId,
            schema.customSecurityPrices.securityId,
            schema.customSecurityPrices.date,
          ],
          set: { price: m.price, currency: security.currency, updatedAt: new Date() },
        })
        .returning({ id: schema.customSecurityPrices.id });
      const id = Array.isArray(inserted) ? inserted[0]?.id : undefined;
      if (id != null) out.push(id);
    }
    return out;
  });
  if (security.priceSource === "manual") {
    await markSnapshotsDirty(userId, earliest(marks.map((m) => m.date)));
  }
  return { security, written: ids.length, ids };
}

/**
 * Delete marks by id and/or by date (owner- and security-scoped). Returns how
 * many went.
 */
export async function deleteCustomPrices(
  userId: string,
  securityId: number,
  target: { ids?: number[]; dates?: string[] },
): Promise<{ security: PricedSecurity; deleted: number }> {
  const ids = target.ids ?? [];
  const dates = target.dates ?? [];
  if (ids.length === 0 && dates.length === 0) {
    throw new CustomPriceError("invalid", "Give the ids or dates of the prices to delete");
  }
  if (ids.length + dates.length > MAX_MARKS_PER_CALL) {
    throw new CustomPriceError("invalid", `At most ${MAX_MARKS_PER_CALL} prices per call`);
  }
  const security = await requireSecurity(userId, securityId);
  const scope = and(
    eq(schema.customSecurityPrices.userId, userId),
    eq(schema.customSecurityPrices.securityId, securityId),
  );
  const which =
    ids.length > 0 && dates.length > 0
      ? sql`(${inArray(schema.customSecurityPrices.id, ids)} OR ${inArray(schema.customSecurityPrices.date, dates)})`
      : ids.length > 0
        ? inArray(schema.customSecurityPrices.id, ids)
        : inArray(schema.customSecurityPrices.date, dates);
  const removed = await db
    .delete(schema.customSecurityPrices)
    .where(and(scope, which))
    .returning({ date: schema.customSecurityPrices.date });
  const gone = Array.isArray(removed) ? removed : [];
  if (gone.length > 0 && security.priceSource === "manual") {
    await markSnapshotsDirty(userId, earliest(gone.map((r) => r.date)));
  }
  return { security, deleted: gone.length };
}

/**
 * Stamp history dirty after a security's price source changed: from its first
 * mark (before it the holding values at 0 either way), or nothing when it has
 * no marks. Shared by REST PATCH /api/securities and MCP.
 */
export async function markPriceSourceChanged(userId: string, securityId: number): Promise<void> {
  const first = await listCustomPrices(userId, securityId, { limit: 1, order: "asc" });
  if (first.length > 0) await markSnapshotsDirty(userId, first[0].date);
}

/** Switch a security between Yahoo/CoinGecko prices ('auto') and its marks ('manual'). */
export async function setSecurityPriceSource(
  userId: string,
  securityId: number,
  source: PriceSource,
): Promise<{ security: PricedSecurity; changed: boolean }> {
  const security = await requireSecurity(userId, securityId);
  if (security.priceSource === source) return { security, changed: false };
  await db
    .update(schema.securities)
    .set({ priceSource: source, updatedAt: sql`NOW()` })
    .where(and(eq(schema.securities.id, securityId), eq(schema.securities.userId, userId)));
  await markPriceSourceChanged(userId, securityId);
  return { security: { ...security, priceSource: source }, changed: true };
}
