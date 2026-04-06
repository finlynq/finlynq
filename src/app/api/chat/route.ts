import { NextRequest, NextResponse } from "next/server";
import { processMessage } from "@/lib/chat-engine";
import { z } from "zod";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { requireAuth } from "@/lib/auth/require-auth";
import { requireDevMode } from "@/lib/require-dev-mode";

const postSchema = z.object({
  message: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request); if (devGuard) return devGuard;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;

    const response = processMessage(parsed.data.message.trim());
    return NextResponse.json(response);
  } catch (error: unknown) {
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to process message") }, { status: 500 });
  }
}
