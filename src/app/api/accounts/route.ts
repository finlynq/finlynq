import { NextRequest, NextResponse } from "next/server";
import { getAccounts, createAccount } from "@/lib/queries";

export async function GET() {
  const data = getAccounts();
  return NextResponse.json(data);
}

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const account = createAccount(body);
    return NextResponse.json(account, { status: 201 });
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to create account";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
