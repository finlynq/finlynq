import { NextRequest, NextResponse } from "next/server";
import { getAccounts, createAccount } from "@/lib/queries";
import { requireUnlock } from "@/lib/require-unlock";

export async function GET() {
  const locked = requireUnlock(); if (locked) return locked;
  const data = getAccounts();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  const locked = requireUnlock(); if (locked) return locked;
  try {
    const body = await request.json();
    const account = createAccount(body);
    return NextResponse.json(account, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create account";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
