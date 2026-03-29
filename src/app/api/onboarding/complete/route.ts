import { NextResponse } from "next/server";
import { requireUnlock } from "@/lib/require-unlock";

export async function POST() {
  const locked = requireUnlock();
  if (locked) return locked;

  // Onboarding complete — this endpoint exists so the wizard can signal
  // completion. Future use: persist an onboarding-completed flag in settings.
  return NextResponse.json({ success: true });
}
