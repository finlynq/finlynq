import { NextRequest, NextResponse } from "next/server";
import { processMessage } from "@/lib/chat-engine";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { requireAuth } from "@/lib/auth/require-auth";
import { getDEK } from "@/lib/crypto/dek-cache";
import { requireDevMode } from "@/lib/require-dev-mode";

const MAX_MESSAGE_LEN = 2000;

const postSchema = z.object({
  message: z.string().min(1).max(MAX_MESSAGE_LEN, `Message exceeds ${MAX_MESSAGE_LEN} character limit`),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const devGuard = await requireDevMode(request);
  if (devGuard) return devGuard;
  const { userId, sessionId } = auth.context;
  const dek = sessionId ? getDEK(sessionId, userId) : null;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;

    const response = await processMessage(parsed.data.message.trim(), userId, dek);
    return NextResponse.json(response);
  } catch (error: unknown) {
    await logApiError("POST", "/api/chat", error, userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to process message") }, { status: 500 });
  }
}
