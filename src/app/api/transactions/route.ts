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
  // `portfolioHolding` is ciphertext-at-rest (AES-GCM with random IV), so it
  // can't be filtered in SQL. We fetch the account-scoped set and match on
  // plaintext after decryption — same pattern as `search`. Passing the
  // account + holding pair from /portfolio → /transactions deep-links the
  // user to every leg that touched a specific position.
  const portfolioHolding = params.get("portfolioHolding") ?? undefined;
  // Tag is an in-memory exact-match filter on the comma-split list. The
  // column is ciphertext-at-rest so SQL LIKE won't work, and substring
  // match on decrypted text would false-match (e.g. `source:X` in one tag
  // shouldn't match `source:XY` in another). Split then exact-compare each.
  const tag = params.get("tag") ?? undefined;
  const postDecryptFilter = search || portfolioHolding || tag;
  const filters = {
    startDate: params.get("startDate") ?? undefined,
    endDate: params.get("endDate") ?? undefined,
    accountId: params.get("accountId") ? parseInt(params.get("accountId")!) : undefined,
    categoryId: params.get("categoryId") ? parseInt(params.get("categoryId")!) : undefined,
    // Search is applied after decryption, so don't push it into the SQL filter.
    // Pull a wider page when any post-decrypt filter is set so the in-memory
    // pass doesn't paginate an empty window. The client still honors the
    // original limit.
    limit: postDecryptFilter ? 1000 : (params.get("limit") ? parseInt(params.get("limit")!) : 100),
    offset: postDecryptFilter ? 0 : (params.get("offset") ? parseInt(params.get("offset")!) : 0),
  };

  const rawRows = await getTransactions(userId, filters);
  let decrypted = decryptTxRows(dek, rawRows as Array<Parameters<typeof decryptTxRows>[1][number]>);

  if (search) {
    decrypted = filterDecryptedBySearch(decrypted, search);
  }

  if (portfolioHolding) {
    decrypted = decrypted.filter((r) => r.portfolioHolding === portfolioHolding);
  }

  if (tag) {
    decrypted = decrypted.filter((r) => {
      if (!r.tags) return false;
      return r.tags.split(",").map((t) => t.trim()).includes(tag);
    });
  }

  // Re-apply client-requested pagination after in-memory filters so the
  // chip-filtered view doesn't spill into an empty page.
  let total: number;
  if (postDecryptFilter) {
    total = decrypted.length;
    const clientLimit = params.get("limit") ? parseInt(params.get("limit")!) : 100;
    const clientOffset = params.get("offset") ? parseInt(params.get("offset")!) : 0;
    decrypted = decrypted.slice(clientOffset, clientOffset + clientLimit);
  } else {
    total = await getTransactionCount(userId, filters);
  }

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
