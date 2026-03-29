import { NextRequest, NextResponse } from "next/server";
import { getAccounts, createAccount } from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";

const postSchema = z.object({
  name: z.string(),
  type: z.string(),
  group: z.string(),
  currency: z.string(),
  note: z.string().optional(),
});

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const data = getAccounts();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;
    const account = createAccount(parsed.data);
    return NextResponse.json(account, { status: 201 });
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to create account") }, { status: 500 });
  }
}
