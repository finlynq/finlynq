import { NextRequest, NextResponse } from "next/server";
import { getAccounts, createAccount, updateAccount, deleteAccount } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { buildNameFields, decryptNamedRows } from "@/lib/crypto/encrypted-columns";

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  group: z.string(),
  currency: z.string(),
  note: z.string().optional(),
  alias: z.string().max(64).trim().optional(),
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
    const { alias, ...rest } = parsed.data;
    const normalizedAlias = alias ? alias : null;
    const enc = buildNameFields(auth.context.dek, { name: rest.name, alias: normalizedAlias });
    const account = await createAccount(auth.context.userId, { ...rest, alias: normalizedAlias, ...enc });
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
    const { id, alias, ...data } = parsed.data;
    const normalized = alias === undefined ? data : { ...data, alias: alias ? alias : null };
    // Only encrypt fields that were actually supplied on the PATCH.
    const toEncrypt: Record<string, string | null | undefined> = {};
    if ("name" in normalized && normalized.name !== undefined) toEncrypt.name = normalized.name;
    if ("alias" in normalized) toEncrypt.alias = normalized.alias ?? null;
    const enc = buildNameFields(auth.context.dek, toEncrypt);
    const account = await updateAccount(id, auth.context.userId, { ...normalized, ...enc });
    if (!account) return NextResponse.json({ error: "Account not found" }, { status: 404 });
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
