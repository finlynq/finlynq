/**
 * GET /api/auth/registration: whether this server accepts new accounts
 * (GH #435). Public and unauthenticated: the sign-in page reads it to decide
 * whether to show Create Account and the demo link. Hand-rolled like the other
 * auth routes.
 *
 * Response: { open: boolean }
 */
import { NextResponse } from "next/server";
import { isRegistrationOpen } from "@/lib/auth/registration";

export const dynamic = "force-dynamic";

export async function GET() {
  return NextResponse.json({ open: isRegistrationOpen() }, { headers: { "Cache-Control": "no-store" } });
}
