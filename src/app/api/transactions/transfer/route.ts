/**
 * /api/transactions/transfer — atomic transfer-pair CRUD.
 *
 * POST   create a new transfer pair (auto-creates Transfer category if missing)
 * PUT    update an existing pair atomically (both legs in one DB transaction)
 * DELETE delete an existing pair atomically (both legs in one statement)
 *
 * All three are gated by `requireEncryption()` — the same rule the existing
 * /api/transactions POST/PUT use, because we'll be encrypting payee/note/tags
 * with the user's session DEK on every leg.
 *
 * The `linkId` is server-generated on POST and never accepted from the
 * client. PUT/DELETE accept either `linkId` or any one transaction id from
 * the pair (the helper resolves the other side).
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  createTransferPair,
  updateTransferPair,
  deleteTransferPair,
  type TransferPairResult,
} from "@/lib/transfer";
import { logApiError, safeErrorMessage, validateBody } from "@/lib/validate";

// ─── Zod schemas ────────────────────────────────────────────────────────────

const postSchema = z.object({
  fromAccountId: z.number().int().positive(),
  toAccountId: z.number().int().positive(),
  // 0 is allowed for pure in-kind transfers (holdingName + quantity supplied).
  enteredAmount: z.number().nonnegative(),
  date: z.string().optional(),
  receivedAmount: z.number().nonnegative().optional(),
  // In-kind side. Both must be set together; partial → invalid-holding-spec.
  // destHoldingName + destQuantity are optional — default server-side to
  // holdingName + quantity. destQuantity > 0 captures asymmetric in-kind
  // events (stock split, merger, share-class conversion).
  holdingName: z.string().min(1).optional(),
  destHoldingName: z.string().min(1).optional(),
  quantity: z.number().positive().optional(),
  destQuantity: z.number().positive().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
});

const putSchema = z
  .object({
    linkId: z.string().uuid().optional(),
    transactionId: z.number().int().positive().optional(),
    fromAccountId: z.number().int().positive().optional(),
    toAccountId: z.number().int().positive().optional(),
    enteredAmount: z.number().nonnegative().optional(),
    date: z.string().optional(),
    receivedAmount: z.number().nonnegative().optional(),
    // Pass holdingName + quantity to (re)bind the in-kind side; both null
    // to clear it; omit both to leave untouched. destHoldingName binds the
    // destination leg to a different label (defaults to holdingName).
    holdingName: z.union([z.string().min(1), z.null()]).optional(),
    destHoldingName: z.union([z.string().min(1), z.null()]).optional(),
    quantity: z.union([z.number().positive(), z.null()]).optional(),
    destQuantity: z.union([z.number().positive(), z.null()]).optional(),
    note: z.string().optional(),
    tags: z.string().optional(),
  })
  .refine((d) => d.linkId != null || d.transactionId != null, {
    message: "Either linkId or transactionId is required",
  });

const deleteSchema = z
  .object({
    linkId: z.string().uuid().optional(),
    transactionId: z.coerce.number().int().positive().optional(),
  })
  .refine((d) => d.linkId != null || d.transactionId != null, {
    message: "Either linkId or transactionId is required",
  });

// ─── Common error mapper ───────────────────────────────────────────────────

/**
 * Translate a `TransferPairResult` failure into a NextResponse with the same
 * shape the rest of the codebase uses (`{ error, code, ... }`). The 409
 * fx-currency-needs-override path mirrors `/api/transactions` so the UI's
 * existing handler picks it up unchanged — and we add a `side` discriminator
 * so the unified edit view can highlight the offending leg.
 */
function errorResponse(result: Extract<TransferPairResult, { ok: false }>): NextResponse {
  const status =
    result.code === "fx-currency-needs-override"
      ? 409
      : result.code === "transfer-not-found" || result.code === "not-a-transfer-pair"
        ? 404
        : result.code === "account-not-found"
          ? 404
          : 422;

  return NextResponse.json(
    {
      error: result.message,
      code: result.code,
      ...(result.currency ? { currency: result.currency } : {}),
      ...(result.side ? { side: result.side } : {}),
    },
    { status },
  );
}

// ─── Handlers ──────────────────────────────────────────────────────────────

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const data = parsed.data;

    const result = await createTransferPair({
      userId: auth.userId,
      dek: auth.dek,
      fromAccountId: data.fromAccountId,
      toAccountId: data.toAccountId,
      enteredAmount: data.enteredAmount,
      date: data.date,
      receivedAmount: data.receivedAmount,
      holdingName: data.holdingName,
      destHoldingName: data.destHoldingName,
      quantity: data.quantity,
      destQuantity: data.destQuantity,
      note: data.note,
      tags: data.tags,
    });

    if (!result.ok) return errorResponse(result);
    return NextResponse.json(result, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/transactions/transfer", error, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to create transfer") },
      { status: 500 },
    );
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const data = parsed.data;

    const result = await updateTransferPair({
      userId: auth.userId,
      dek: auth.dek,
      linkId: data.linkId,
      transactionId: data.transactionId,
      fromAccountId: data.fromAccountId,
      toAccountId: data.toAccountId,
      enteredAmount: data.enteredAmount,
      date: data.date,
      receivedAmount: data.receivedAmount,
      holdingName: data.holdingName,
      destHoldingName: data.destHoldingName,
      quantity: data.quantity,
      destQuantity: data.destQuantity,
      note: data.note,
      tags: data.tags,
    });

    if (!result.ok) return errorResponse(result);
    return NextResponse.json(result);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/transactions/transfer", error, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to update transfer") },
      { status: 500 },
    );
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const params = request.nextUrl.searchParams;
    const parsed = deleteSchema.safeParse({
      linkId: params.get("linkId") ?? undefined,
      transactionId: params.get("transactionId") ?? undefined,
    });
    if (!parsed.success) {
      return NextResponse.json(
        { error: parsed.error.issues[0]?.message ?? "Invalid query params" },
        { status: 400 },
      );
    }

    const result = await deleteTransferPair({
      userId: auth.userId,
      linkId: parsed.data.linkId,
      transactionId: parsed.data.transactionId,
    });

    if (!result.ok) return errorResponse(result);
    return NextResponse.json(result);
  } catch (error: unknown) {
    await logApiError("DELETE", "/api/transactions/transfer", error, auth.userId);
    return NextResponse.json(
      { error: safeErrorMessage(error, "Failed to delete transfer") },
      { status: 500 },
    );
  }
}
