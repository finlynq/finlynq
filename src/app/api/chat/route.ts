import { NextRequest, NextResponse } from "next/server";
import { processMessage } from "@/lib/chat-engine";
import { z } from "zod";
import { validateBody, safeErrorMessage, logApiError } from "@/lib/validate";
import { requireAuth } from "@/lib/auth/require-auth";

const postSchema = z.object({
  message: z.string().min(1),
});

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request); if (!auth.authenticated) return auth.response;
  try {
    const body = await request.json();
    const parsed = validateBody(body, postSchema);
    if (parsed.error) return parsed.error;

    const response = await processMessage(parsed.data.message.trim());
    return NextResponse.json(response);
  } catch (error: unknown) {
    await logApiError("POST", "/api/chat", error, auth.context.userId);
    return NextResponse.json({ error: safeErrorMessage(error, "Failed to process message") }, { status: 500 });
  }
}
