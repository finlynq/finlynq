import { NextRequest, NextResponse } from "next/server";
import { getTransactions, getTransactionCount, createTransaction, updateTransaction, deleteTransaction } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import { getDEK } from "@/lib/crypto/dek-cache";
import { encryptTxWrite, decryptTxRows, filterDecryptedBySearch } from "@/lib/crypto/encrypted-columns";
import { invalidateUser as invalidateUserTxCache } from "@/lib/mcp/user-tx-cache";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";

const postSchema = z.object({
  date: z.string(),
  amount: z.number(),
  accountId: z.number(),
  categoryId: z.number(),
  currency: z.string(),
  payee: z.string().optional(),
  quantity: z.number().optional(),
  portfolioHolding: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  isBusiness: z.number().optional(),
  splitPerson: z.string().optional(),
  splitRatio: z.number().optional(),
});

const putSchema = z.object({
  id: z.number(),
  date: z.string().optional(),
  amount: z.number().optional(),
  accountId: z.number().optional(),
  categoryId: z.number().optional(),
  currency: z.string().optional(),
  payee: z.string().optional(),
  quantity: z.number().optional(),
  portfolioHolding: z.string().optional(),
  note: z.string().optional(),
  tags: z.string().optional(),
  isBusiness: z.number().optional(),
  splitPerson: z.string().optional(),
  splitRatio: z.number().optional(),
});

export async function GET(request: NextRequest) {
  // GET must stay accessible even when the session has no cached DEK
  // (e.g. first request after a server restart). `decryptTxRows` passes
  // rows through unchanged when dek is null — encrypted rows surface as
  // `v1:...` ciphertext, which is ugly but recoverable (re-login
  // repopulates the DEK cache), whereas 423-ing the whole transactions
  // page blocks the user entirely.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId) : null;

  const params = request.nextUrl.searchParams;
  const search = params.get("search") ?? undefined;
  const filters = {
    startDate: params.get("startDate") ?? undefined,
    endDate: params.get("endDate") ?? undefined,
    accountId: params.get("accountId") ? parseInt(params.get("accountId")!) : undefined,
    categoryId: params.get("categoryId") ? parseInt(params.get("categoryId")!) : undefined,
    // Search is applied after decryption, so don't push it into the SQL filter.
    limit: params.get("limit") ? parseInt(params.get("limit")!) : 100,
    offset: params.get("offset") ? parseInt(params.get("offset")!) : 0,
  };

  const rawRows = await getTransactions(userId, filters);
  let decrypted = decryptTxRows(dek, rawRows as Array<Parameters<typeof decryptTxRows>[1][number]>);

  if (search) {
    decrypted = filterDecryptedBySearch(decrypted, search);
  }

  // Count mirrors the filtered set; legacy callers use this for pagination UI.
  const total = search
    ? decrypted.length
    : await getTransactionCount(userId, filters);

  return NextResponse.json({ data: decrypted, total });
}

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const encrypted = encryptTxWrite(auth.dek, parsed.data);
    const tx = await createTransaction(auth.userId, encrypted);
    invalidateUserTxCache(auth.userId);
    return NextResponse.json(tx, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/transactions", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create transaction") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, ...data } = parsed.data;
    const encrypted = encryptTxWrite(auth.dek, data);
    const tx = await updateTransaction(id, auth.userId, encrypted);
    invalidateUserTxCache(auth.userId);
    return NextResponse.json(tx);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/transactions", error, auth.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update transaction") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  // DELETE doesn't need the DEK — IDs and user-scope only.
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const params = request.nextUrl.searchParams;
  const id = parseInt(params.get("id") ?? "0");
  if (!id) return NextResponse.json({ error: "Missing id" }, { status: 400 });
  await deleteTransaction(id, auth.context.userId);
  invalidateUserTxCache(auth.context.userId);
  return NextResponse.json({ success: true });
}
