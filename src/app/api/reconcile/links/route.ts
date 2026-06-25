/**
 * POST   /api/reconcile/links — create a transaction ↔ bank-row link
 * DELETE /api/reconcile/links — remove one
 *
 * Both routes are session-auth'd, gated by `requireEncryption()` (writes;
 * 423 if no DEK), and delegate the structural work to
 * `linkTransactionToBank` / `unlinkTransactionFromBank` in
 * `pf-app/src/lib/reconcile/links.ts`. That helper owns the dual-write
 * between the join table and the legacy `transactions.bank_transaction_id`
 * FK so the rule lives in one place.
 *
 * "User edits always win" — these routes NEVER mutate the transaction's
 * date / amount / payee / category. They are structural only.
 *
 * Cross-tenant attacks surface as 404 (link helper raises `LinkError`
 * with `code: 'not_found'` when ownership fails). Mirrors the rest of
 * the staging surface — no existence leak.
 *
 * The default linkType is `'extra'`; the API caller MUST opt into
 * `'primary'` explicitly. Rationale: callers that don't think about
 * link types should default to the non-destructive option (extra link
 * never modifies the FK).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { validateBody } from "@/lib/validate";
import {
  linkTransactionToBank,
  unlinkTransactionFromBank,
  LinkError,
} from "@/lib/reconcile/links";

export const dynamic = "force-dynamic";

const linkBodySchema = z.object({
  transactionId: z.number().int().positive(),
  bankTransactionId: z.string().uuid(),
  linkType: z.enum(["primary", "extra"]).default("extra"),
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
  const parsed = validateBody(body, linkBodySchema);
  if (parsed.error) return parsed.error;

  try {
    const result = await linkTransactionToBank({
      userId,
      transactionId: parsed.data.transactionId,
      bankTransactionId: parsed.data.bankTransactionId,
      linkType: parsed.data.linkType,
      source: "manual",
    });
    return NextResponse.json({ success: true, data: result });
  } catch (e) {
    if (e instanceof LinkError) {
      if (e.code === "cross_account") {
        return NextResponse.json(
          {
            error:
              "Transaction and bank row belong to different accounts. A transfer leg can only be linked to a bank row in its own account.",
          },
          { status: 400 },
        );
      }
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw e;
  }
}

const unlinkBodySchema = z.object({
  transactionId: z.number().int().positive(),
  bankTransactionId: z.string().uuid(),
});

export async function DELETE(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  const { userId } = auth;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = validateBody(body, unlinkBodySchema);
  if (parsed.error) return parsed.error;

  const result = await unlinkTransactionFromBank({
    userId,
    transactionId: parsed.data.transactionId,
    bankTransactionId: parsed.data.bankTransactionId,
  });
  return NextResponse.json({ success: true, data: result });
}
