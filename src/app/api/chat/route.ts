import { NextRequest, NextResponse } from "next/server";
import { processMessage } from "@/lib/chat-engine";

export async function POST(request: NextRequest) {
  try {
    const body = await request.json();
    const message = body.message;

    if (!message || typeof message !== "string") {
      return NextResponse.json({ error: "Message is required" }, { status: 400 });
    }

    const response = processMessage(message.trim());
    return NextResponse.json(response);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : "Failed to process message";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
