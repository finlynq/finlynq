/**
 * POST /api/feedback — submit in-app feedback (bug report / idea / question).
 *
 * Any authenticated user. The DB row is the source of truth (reviewable at
 * /admin/feedback); a maintainer email notification is fire-and-forget so a
 * missing SMTP config never 500s the submit. Rate-limited per user.
 *
 * Feedback is stored PLAINTEXT (see schema-pg.ts) — it must be readable by the
 * maintainer, and the user's per-user DEK is unreadable by an admin.
 */

import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { db, schema } from "@/db";
import { requireAuth } from "@/lib/auth/require-auth";
import { validateBody, safeErrorMessage } from "@/lib/validate";
import { checkRateLimit } from "@/lib/rate-limit";
import { sendEmail, feedbackNotificationEmail } from "@/lib/email";
import { getUserById } from "@/lib/auth/queries";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  type: z.enum(["bug", "idea", "question", "other"]),
  message: z.string().trim().min(1, "Message is required").max(4000),
  pageUrl: z.string().max(500).optional(),
  appVersion: z.string().max(50).optional(),
});

// Best-effort maintainer notification — resolve a friendly user label, then
// fire the email. Any failure (no SMTP, DB hiccup) is swallowed by the caller.
async function notifyMaintainer(
  userId: string,
  d: z.infer<typeof bodySchema>,
): Promise<void> {
  let userLabel: string | null = null;
  try {
    const user = await getUserById(userId);
    userLabel = user?.username || user?.email || null;
  } catch {
    /* fall back to userId in the template */
  }
  await sendEmail(
    feedbackNotificationEmail({
      feedbackType: d.type,
      message: d.message,
      userId,
      userLabel,
      pageUrl: d.pageUrl ?? null,
      appVersion: d.appVersion ?? null,
    }),
  );
}

export async function POST(request: NextRequest) {
  const auth = await requireAuth(request);
  if (!auth.authenticated) return auth.response;
  const { userId } = auth.context;

  // Per-user rate limit: 10 submissions per hour.
  const rl = checkRateLimit(`feedback:${userId}`, 10, 60 * 60 * 1000);
  if (!rl.allowed) {
    return NextResponse.json(
      { error: "Too many submissions. Please try again later." },
      { status: 429 },
    );
  }

  try {
    const body = await request.json();
    const parsed = validateBody(body, bodySchema);
    if (parsed.error) return parsed.error;
    const d = parsed.data;

    const [row] = await db
      .insert(schema.feedback)
      .values({
        userId,
        type: d.type,
        message: d.message,
        pageUrl: d.pageUrl ?? null,
        appVersion: d.appVersion ?? "web",
      })
      .returning({ id: schema.feedback.id });

    // Fire-and-forget: never block the response or 500 on email failure.
    void notifyMaintainer(userId, d).catch((err) => {
      // eslint-disable-next-line no-console
      console.error("[feedback-email] notify failed", err);
    });

    return NextResponse.json({ ok: true, id: row.id }, { status: 201 });
  } catch (e) {
    return NextResponse.json(
      { error: safeErrorMessage(e, "Failed to submit feedback.") },
      { status: 500 },
    );
  }
}
