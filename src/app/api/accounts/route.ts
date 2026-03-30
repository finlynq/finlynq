import { NextRequest, NextResponse } from "next/server";
import { getAccounts, createAccount } from "@/lib/queries";
import { requireAuth } from "@/lib/auth/require-auth";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  group: z.string(),
  currency: z.string(),
  note: z.string().optional(),
});

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const data = getAccounts(auth.context.userId);
    return NextResponse.json(data);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to load accounts") }, { status: 500 });
  }
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const account = createAccount(auth.context.userId, parsed.data);
    return NextResponse.json(account, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create account") }, { status: 500 });
  }
}
