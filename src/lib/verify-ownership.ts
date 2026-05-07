// Single source of truth for cross-tenant FK validation.
//
// SECURITY_REVIEW_2026-05-06 / finding H-1 — Postgres FK constraints are
// satisfied by global serial PKs, so a write that quotes another user's
// account_id / category_id / portfolio_holding_id will succeed at the SQL
// layer and silently attribute the row to the attacker. Every POST/PUT/PATCH
// that accepts FK ids from the client body must call `verifyOwnership` to
// reject cross-tenant references before the write fires.
//
// Modeled on the inline patterns in:
//   - `src/app/api/goals/route.ts` `verifyAccountOwnership`
//   - `src/app/api/holding-accounts/route.ts` `assertOwnership`
//
// The thrown `OwnershipError` carries `kind` so the route boundary can map it
// to a 404 (preferred over 403 — same shape as "not found", avoids leaking
// the existence of another user's row to a probe).

import { db, schema } from "@/db";
import { and, eq, inArray } from "drizzle-orm";

export type OwnedKind =
  | "account"
  | "category"
  | "holding"
  | "goal"
  | "loan"
  | "subscription"
  | "rule";

export class OwnershipError extends Error {
  readonly kind: OwnedKind;
  readonly missingIds: number[];
  constructor(kind: OwnedKind, missingIds: number[]) {
    super(`${kind} id(s) not owned by user: ${missingIds.join(", ")}`);
    this.name = "OwnershipError";
    this.kind = kind;
    this.missingIds = missingIds;
  }
}

export interface OwnershipRefs {
  accountIds?: (number | null | undefined)[];
  categoryIds?: (number | null | undefined)[];
  holdingIds?: (number | null | undefined)[];
  goalIds?: (number | null | undefined)[];
  loanIds?: (number | null | undefined)[];
  subscriptionIds?: (number | null | undefined)[];
  ruleIds?: (number | null | undefined)[];
}

function compactIds(ids: (number | null | undefined)[] | undefined): number[] {
  if (!ids || ids.length === 0) return [];
  // Filter out null / undefined / non-positive (e.g. 0 sentinel from a UI
  // form that never made a selection — those are caller bugs, not a
  // cross-tenant attack, but the SELECT below would correctly find nothing
  // and we'd raise OwnershipError. Better to skip them so the route's own
  // zod schema can return its specific "Please pick a category" error.)
  const out = new Set<number>();
  for (const id of ids) {
    if (id == null) continue;
    if (!Number.isFinite(id) || id <= 0) continue;
    out.add(id);
  }
  return Array.from(out);
}

async function verifyTable(
  userId: string,
  kind: OwnedKind,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  table: any,
  ids: number[],
): Promise<void> {
  if (ids.length === 0) return;
  const owned = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.userId, userId), inArray(table.id, ids)));
  if (owned.length === ids.length) return;
  const ownedSet = new Set(owned.map((r: { id: number }) => r.id));
  const missing = ids.filter((id) => !ownedSet.has(id));
  throw new OwnershipError(kind, missing);
}

/**
 * Verify every FK id supplied by the caller belongs to `userId`. Throws
 * `OwnershipError` on the first table with a missing id. Skips empty / null
 * / undefined entries cleanly.
 *
 * Pass into every POST/PUT/PATCH that accepts FK ids from the request body.
 * Map the caught error to HTTP 404 (preferred — anti-enumeration) at the
 * route boundary.
 */
export async function verifyOwnership(
  userId: string,
  refs: OwnershipRefs,
): Promise<void> {
  const accountIds = compactIds(refs.accountIds);
  const categoryIds = compactIds(refs.categoryIds);
  const holdingIds = compactIds(refs.holdingIds);
  const goalIds = compactIds(refs.goalIds);
  const loanIds = compactIds(refs.loanIds);
  const subscriptionIds = compactIds(refs.subscriptionIds);
  const ruleIds = compactIds(refs.ruleIds);

  // Sequential — small N (typically 1-3 ids per write), and any single
  // missing id is a hard fail anyway. Parallelizing would buy nothing.
  await verifyTable(userId, "account", schema.accounts, accountIds);
  await verifyTable(userId, "category", schema.categories, categoryIds);
  await verifyTable(userId, "holding", schema.portfolioHoldings, holdingIds);
  await verifyTable(userId, "goal", schema.goals, goalIds);
  await verifyTable(userId, "loan", schema.loans, loanIds);
  await verifyTable(userId, "subscription", schema.subscriptions, subscriptionIds);
  await verifyTable(userId, "rule", schema.transactionRules, ruleIds);
}

/**
 * Convenience wrapper: catches `OwnershipError`, returns true on success,
 * false on cross-tenant. Use when the caller wants to return its own custom
 * 404 response.
 */
export async function isOwnedByUser(
  userId: string,
  refs: OwnershipRefs,
): Promise<boolean> {
  try {
    await verifyOwnership(userId, refs);
    return true;
  } catch (e) {
    if (e instanceof OwnershipError) return false;
    throw e;
  }
}
