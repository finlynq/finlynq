/**
 * GH #428 (2026-11-21) — payees the user marked "Not a subscription".
 *
 * SERVER ONLY (reaches the db). One store behind REST
 * /api/subscriptions/dismissals and MCP manage_subscriptions
 * (dismiss_suggestion / undismiss_suggestion / list_dismissed), and read by
 * every place that builds the detected list (GET /api/recurring, the REST
 * `detect` action, MCP detect_subscriptions), so a dismissal holds
 * everywhere: web, phone, calendar and assistants.
 *
 * A dismissal is keyed by the payee alone (any amount, cadence or currency),
 * matching how a tracked subscription hides a suggestion (`isTrackedPayee`).
 * It is NOT removed when a subscription with that name is deleted, so the
 * "track, cancel, delete" workaround no longer brings a rejected suggestion
 * back.
 */
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { encryptField, tryDecryptField } from "@/lib/crypto/envelope";
import { nameLookup } from "@/lib/crypto/encrypted-columns";

export const MAX_DISMISSALS_PER_CALL = 200;

export interface Dismissal {
  id: number;
  /** null when this key can't decrypt the row. */
  payee: string | null;
  createdAt: string;
}

export class DismissalError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DismissalError";
  }
}

/** The lookup hashes of every dismissed payee. No DEK needed. */
export async function dismissedLookups(userId: string): Promise<Set<string>> {
  const rows = await db
    .select({ lookup: schema.subscriptionDismissals.payeeLookup })
    .from(schema.subscriptionDismissals)
    .where(eq(schema.subscriptionDismissals.userId, userId));
  return new Set(rows.map((r) => r.lookup));
}

/**
 * Drop rows whose payee the user dismissed. Without a DEK nothing can be
 * hashed, so the rows come back unchanged (they are ciphertext then and the
 * detector found nothing anyway).
 */
export function withoutDismissed<T>(
  rows: T[],
  payeeOf: (row: T) => string | null | undefined,
  lookups: Set<string>,
  dek: Buffer | null,
): T[] {
  if (!dek || lookups.size === 0) return rows;
  return rows.filter((r) => {
    const p = payeeOf(r);
    return !p || !lookups.has(nameLookup(dek, p));
  });
}

export async function listDismissals(userId: string, dek: Buffer | null): Promise<Dismissal[]> {
  const rows = await db
    .select()
    .from(schema.subscriptionDismissals)
    .where(eq(schema.subscriptionDismissals.userId, userId))
    .orderBy(schema.subscriptionDismissals.createdAt);
  return rows.map((r) => ({
    id: r.id,
    payee: dek ? tryDecryptField(dek, r.payeeCt, "subscription_dismissals.payee_ct") : null,
    createdAt: r.createdAt.toISOString(),
  }));
}

/**
 * Dismiss one or more payees. Idempotent: a payee already dismissed is left as
 * it is. Returns how many were newly dismissed.
 */
export async function dismissPayees(userId: string, dek: Buffer, payees: string[]): Promise<{ added: number }> {
  // One row per payee; the FIRST spelling given is the one shown later.
  const byLookup = new Map<string, string>();
  for (const raw of payees) {
    const p = typeof raw === "string" ? raw.trim() : "";
    if (!p) continue;
    const lookup = nameLookup(dek, p);
    if (!byLookup.has(lookup)) byLookup.set(lookup, p);
  }
  const clean = [...byLookup.entries()];
  if (clean.length === 0) throw new DismissalError("Name at least one payee to dismiss.");
  if (clean.length > MAX_DISMISSALS_PER_CALL) {
    throw new DismissalError(`At most ${MAX_DISMISSALS_PER_CALL} payees can be dismissed at once.`);
  }
  const inserted = await db
    .insert(schema.subscriptionDismissals)
    .values(clean.map(([lookup, payee]) => ({
      userId,
      payeeLookup: lookup,
      payeeCt: encryptField(dek, payee) as string,
    })))
    .onConflictDoNothing({
      target: [schema.subscriptionDismissals.userId, schema.subscriptionDismissals.payeeLookup],
    })
    .returning({ id: schema.subscriptionDismissals.id });
  return { added: inserted.length };
}

/**
 * Undo dismissals, by row id or by payee name (a name needs the DEK).
 * Returns how many were removed.
 */
export async function undismiss(
  userId: string,
  dek: Buffer | null,
  by: { ids?: number[]; payees?: string[] },
): Promise<{ removed: number }> {
  const ids = (by.ids ?? []).filter((n) => Number.isInteger(n) && n > 0);
  const payees = (by.payees ?? []).map((p) => p.trim()).filter(Boolean);
  if (ids.length === 0 && payees.length === 0) throw new DismissalError("Name a dismissal to undo.");
  if (payees.length > 0 && !dek) throw new DismissalError("Unlock your data to undo a dismissal by name.");
  let removed = 0;
  if (ids.length > 0) {
    const r = await db
      .delete(schema.subscriptionDismissals)
      .where(and(eq(schema.subscriptionDismissals.userId, userId), inArray(schema.subscriptionDismissals.id, ids)))
      .returning({ id: schema.subscriptionDismissals.id });
    removed += r.length;
  }
  if (payees.length > 0 && dek) {
    const lookups = payees.map((p) => nameLookup(dek, p));
    const r = await db
      .delete(schema.subscriptionDismissals)
      .where(and(
        eq(schema.subscriptionDismissals.userId, userId),
        inArray(schema.subscriptionDismissals.payeeLookup, lookups),
      ))
      .returning({ id: schema.subscriptionDismissals.id });
    removed += r.length;
  }
  return { removed };
}
