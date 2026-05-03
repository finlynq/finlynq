import { NextRequest, NextResponse } from "next/server";
import { getAccounts, getAccountById, createAccount, updateAccount, deleteAccount } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";
import { backfillInvestmentAccount } from "@/lib/investment-account";

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  group: z.string(),
  currency: z.string(),
  note: z.string().optional(),
  alias: z.string().max(64).trim().optional(),
  isInvestment: z.boolean().optional(),
});

const putSchema = z.object({
  id: z.number(),
  name: z.string().optional(),
  type: z.string().optional(),
  group: z.string().optional(),
  currency: z.string().optional(),
  note: z.string().optional(),
  archived: z.boolean().optional(),
  alias: z.string().max(64).trim().nullable().optional(),
  isInvestment: z.boolean().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const includeArchived = request.nextUrl.searchParams.get("includeArchived") === "1";
    const rows = await getAccounts(auth.context.userId, { includeArchived });
    // Stream D: decrypt name + alias from *_ct columns when a DEK is in cache,
    // else fall back to plaintext columns (pre-backfill or degraded session).
    const data = decryptNamedRows(rows, auth.context.dek, {
      nameCt: "name",
      aliasCt: "alias",
    });
    return NextResponse.json(data);
  } catch (error: unknown) {
    await logApiError("GET", "/api/accounts", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load accounts") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const { alias, name, ...rest } = parsed.data;
    const normalizedAlias = alias ? alias : null;
    const enc = buildNameFields(auth.context.dek, { name, alias: normalizedAlias });
    // Stream D Phase 4 — plaintext `name`/`alias` columns dropped. Only the
    // `*_ct`/`*_lookup` siblings get persisted via `enc`.
    const account = await createAccount(auth.context.userId, { ...rest, ...enc });
    // When the user creates an account already flagged investment, ensure
    // the per-account Cash holding exists so the constraint is satisfiable
    // out of the gate. No transactions to reassign on a fresh account.
    if (rest.isInvestment === true && account?.id != null) {
      try {
        await backfillInvestmentAccount(auth.context.userId, account.id, auth.context.dek);
      } catch (e) {
        // Backfill failure shouldn't undo the account creation — log only.
        await logApiError("POST-backfill", "/api/accounts", e, auth.context.userId);
      }
    }
    return NextResponse.json(account, { status: 201 });
  } catch (error: unknown) {
    await logApiError("POST", "/api/accounts", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create account") }, { status: 500 });
  }
}

export async function PUT(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, putSchema);
    if (parsed.error) return parsed.error;
    const { id, alias, name, ...data } = parsed.data;
    // Stream D Phase 4 — plaintext `name`/`alias` are NOT in the schema.
    // Strip them from the update set; only the encrypted siblings persist.
    const normalizedAlias = alias === undefined ? undefined : (alias ? alias : null);
    const toEncrypt: Record<string, string | null | undefined> = {};
    if (name !== undefined) toEncrypt.name = name;
    if (normalizedAlias !== undefined) toEncrypt.alias = normalizedAlias;
    const enc = buildNameFields(auth.context.dek, toEncrypt);
    const normalized = data;
    // Detect false → true flip on isInvestment so we can run the backfill
    // (Cash holding + null-FK reassignment) in the same request.
    let needsInvestmentBackfill = false;
    if (normalized.isInvestment === true) {
      const before = await getAccountById(id, auth.context.userId);
      if (before && before.isInvestment === false) needsInvestmentBackfill = true;
    }
    const account = await updateAccount(id, auth.context.userId, { ...normalized, ...enc });
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
    if (needsInvestmentBackfill) {
      try {
        await backfillInvestmentAccount(auth.context.userId, id, auth.context.dek);
      } catch (e) {
        // Surface the backfill failure rather than leaving the user with a
        // freshly-flagged account whose existing rows still violate the
        // constraint. The flag flip already committed; the error tells
        // them to retry or investigate.
        await logApiError("PUT-backfill", "/api/accounts", e, auth.context.userId);
        return NextResponse.json(
          {
            error: "Account flagged as investment, but the cash-holding backfill failed. Existing transactions in this account may not yet satisfy the constraint — retry the toggle or contact support.",
          },
          { status: 500 },
        );
      }
    }
    return NextResponse.json(account);
  } catch (error: unknown) {
    await logApiError("PUT", "/api/accounts", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to update account") }, { status: 500 });
  }
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const idParam = request.nextUrl.searchParams.get("id");
    const id = idParam ? Number(idParam) : NaN;
    if (!Number.isFinite(id)) return NextResponse.json({ error: "id is required" }, { status: 400 });
    await deleteAccount(id, auth.context.userId);
    return NextResponse.json({ ok: true });
  } catch (error: unknown) {
    // PG foreign_key_violation — account still referenced by transactions,
    // splits, holdings, loans, goals, snapshots, subscriptions, or recurring.
    if (typeof error === "object" && error !== null && (error as { code?: string }).code === "23503") {
      return NextResponse.json(
        { error: "This account still has transactions or other records linked to it. Archive it instead, or remove the related records first." },
        { status: 409 },
      );
    }
    await logApiError("DELETE", "/api/accounts", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to delete account") }, { status: 500 });
  }
}
