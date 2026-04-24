import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireEncryption } from "@/lib/auth/require-encryption";
import {
  saveConnectorCredentials,
  hasConnectorCredentials,
  deleteConnectorCredentials,
} from "@/lib/external-import/credentials";

const CONNECTOR_ID = "wealthposition";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const present = await hasConnectorCredentials(auth.context.userId, CONNECTOR_ID);
  return NextResponse.json({ present });
}

export async function POST(request: NextRequest) {
  const auth = await requireEncryption(request);
  if (!auth.ok) return auth.response;
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }
  const apiKey = (body as { apiKey?: unknown })?.apiKey;
  if (typeof apiKey !== "string" || apiKey.length < 20 || apiKey.length > 500) {
    return NextResponse.json(
      { error: "apiKey must be a string between 20 and 500 characters" },
      { status: 400 },
    );
  }
  await saveConnectorCredentials(auth.userId, CONNECTOR_ID, auth.dek, { apiKey });
  return NextResponse.json({ ok: true });
}

export async function DELETE(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  await deleteConnectorCredentials(auth.context.userId, CONNECTOR_ID);
  return NextResponse.json({ ok: true });
}
