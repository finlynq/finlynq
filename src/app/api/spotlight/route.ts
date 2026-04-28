import { NextRequest, NextResponse } from "next/server";
import { getSpotlightItems } from "@/lib/spotlight";
import { requireAuth } from "@/lib/auth/require-auth";

export async function GET(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const items = await getSpotlightItems(auth.context.userId);
  return NextResponse.json({ items });
}
