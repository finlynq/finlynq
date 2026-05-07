import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  runWealthPositionReconciliation,
  insertOpeningBalanceAdjustment,
} from "@/lib/external-import/reconciliation";
import { WealthPositionApiError } from "@finlynq/import-connectors/wealthposition";
import { OwnershipError } from "@/lib/verify-ownership";

export async function GET(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  const date = request.nextUrl.searchParams.get("date");
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json(
      { error: "Missing or malformed `date` query parameter (expected YYYY-MM-DD)." },
      { status: 400 },
    );
  }

  try {
    const result = await runWealthPositionReconciliation(auth.userId, auth.dek, date);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof WealthPositionApiError) {
      const status = err.httpStatus === 401 || err.code === "AUTHENTICATION_ERROR" ? 401 : 502;
      return NextResponse.json({ error: err.message, code: err.code }, { status });
    }
    const message = err instanceof Error ? err.message : "Reconciliation failed";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}

const adjustmentSchema = z.object({
  finlynqAccountId: z.number().int().positive(),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  amount: z.number().finite(),
  categoryId: z.number().int().nullable().optional(),
});

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const parsed = adjustmentSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "Invalid adjustment request", details: parsed.error.flatten() },
      { status: 400 },
    );
  }

  try {
    const result = await insertOpeningBalanceAdjustment(auth.userId, auth.dek, parsed.data);
    return NextResponse.json(result);
  } catch (err) {
    if (err instanceof OwnershipError) {
      return NextResponse.json({ error: "Not found" }, { status: 404 });
    }
    throw err;
  }
}
