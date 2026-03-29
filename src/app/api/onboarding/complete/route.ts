import { NextRequest, NextResponse } from "next/server";
import { requireAuth } from "@/lib/auth/require-auth";

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;

  // Onboarding complete — this endpoint exists so the wizard can signal
  // completion. Future use: persist an onboarding-completed flag in settings.
  return NextResponse.json({ success: true });
}
