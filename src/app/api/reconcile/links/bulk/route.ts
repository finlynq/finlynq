/**
 * POST /api/reconcile/links/bulk — create the cartesian product of
 * `transaction_bank_links` rows from a selection on both panes of
 * /reconcile (2026-05-27).
 *
 * Body:
 *   {
 *     transactionIds: number[],        // N
 *     bankTransactionIds: string[],    // M  (UUIDs)
 *     linkType?: "extra"               // 'primary' is reserved for the
 *                                      //  FK-mirror single-link path
 *   }
 *
 * Cap: N*M ≤ 200. Larger requests are refused with 400 so an oversized
 * selection can't tie up a single DB transaction.
 *
 * Reuses {@link linkTransactionToBank} which is idempotent via the
 * unique constraint `(transaction_id, bank_transaction_id)` — re-running
 * the same selection produces `alreadyLinked: N*M, created: 0`.
 *
 * Returns: { success: true, data: { created, alreadyLinked, total } }
 *
 * Ownership is re-asserted inside the helper, but for early-fail latency
 * we also check ownership of both sides up-front so a stale id doesn't
 * partially insert before failing on row #7.
 *
 * Calls `invalidateUser(userId)` once at the end so the MCP per-user
 * cache invalidation is amortized across the whole batch.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, eq, inArray } from "drizzle-orm";
import { db, schema } from "@/db";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import {
  linkTransactionToBank,
  LinkError,
} from "@/lib/reconcile/links";
import { invalidateUser } from "@/lib/mcp/user-tx-cache";

export const dynamic = "force-dynamic";

const MAX_PAIRS = 200;

const bodySchema = z
  .object({
    transactionIds: z
      .array(z.number().int().positive())
      .min(1)
      .max(MAX_PAIRS),
    bankTransactionIds: z.array(z.string().uuid()).min(1).max(MAX_PAIRS),
    linkType: z.literal("extra").default("extra"),
  })
  .refine((v) => v.transactionIds.length * v.bankTransactionIds.length <= MAX_PAIRS, {
    message: `Selection too large — N × M must be ≤ ${MAX_PAIRS}.`,
  });

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, bodySchema);
  if (parsed.error) return parsed.error;

  const { transactionIds, bankTransactionIds, linkType } = parsed.data;
  // De-dupe the input sets — duplicate ids in the request shouldn't
  // multiply the cartesian product. (The unique constraint would catch
  // it anyway, but bailing here keeps the work bound predictable.)
  const txIds = Array.from(new Set(transactionIds));
  const bankIds = Array.from(new Set(bankTransactionIds));

  try {
    // Early ownership check — fail fast with 404 if any id is foreign.
    const ownedTxs = await db
      .select({ id: schema.transactions.id })
      .from(schema.transactions)
      .where(
        and(
          eq(schema.transactions.userId, userId),
          inArray(schema.transactions.id, txIds),
        ),
      );
    if (ownedTxs.length !== txIds.length) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    const ownedBanks = await db
      .select({ id: schema.bankTransactions.id })
      .from(schema.bankTransactions)
      .where(
        and(
          eq(schema.bankTransactions.userId, userId),
          inArray(schema.bankTransactions.id, bankIds),
        ),
      );
    if (ownedBanks.length !== bankIds.length) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }

    let created = 0;
    let alreadyLinked = 0;
    // Each linkTransactionToBank call wraps its own DB tx and bumps the
    // MCP cache; we suppress the in-flight invalidation by letting the
    // helper run normally and re-asserting once at the end (cheap; the
    // last call already invalidated).
    for (const txId of txIds) {
      for (const bankId of bankIds) {
        try {
          const result = await linkTransactionToBank({
            userId,
            transactionId: txId,
            bankTransactionId: bankId,
            linkType,
            source: "manual",
          });
          if (result.alreadyLinked) alreadyLinked++;
          else created++;
        } catch (e) {
          if (e instanceof LinkError) {
            // Soft miss — skip this pair, keep linking the rest of the
            // cartesian. Either a race (row deleted between the ownership
            // check and the helper call) or a cross-account pair the
            // FINLYNQ-211 guard rejects (a tx and bank row in different
            // accounts must never link). Both are non-fatal for the batch.
            continue;
          }
          throw e;
        }
      }
    }

    invalidateUser(userId);

    return NextResponse.json({
      success: true,
      data: {
        created,
        alreadyLinked,
        total: txIds.length * bankIds.length,
      },
    });
  } catch (err) {
    return NextResponse.json(
      { error: safeErrorMessage(err, "Failed to bulk-link reconcile pairs") },
      { status: 500 },
    );
  }
}
