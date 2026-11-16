/**
 * Admin notification for in-app feedback activity (new submissions + user
 * replies on a thread) AND new user signups.
 *
 * Recipients are resolved at send time from the actual admin account(s) in the
 * DB (users.role = 'admin'), unioned with the optional `FEEDBACK_EMAIL`
 * operator override. There is NO hardcoded fallback address — if no admin has
 * an email and the override is unset, nothing is sent (the DB feedback row is
 * the source of truth, reviewable at /admin/feedback).
 *
 * Everything here is best-effort: callers fire-and-forget so a missing SMTP
 * config / unreachable admin never blocks (or 500s) the user's submit/reply.
 */

import { listAdminEmails, getUserById, getUserCount } from "@/lib/auth/queries";
import {
  sendEmail,
  feedbackNotificationEmail,
  feedbackReplyNotificationEmail,
  newSignupNotificationEmail,
} from "@/lib/email";

/**
 * Admin email recipients for feedback notifications: admin account emails
 * from the DB ∪ the `FEEDBACK_EMAIL` override (when set), deduped. Empty when
 * nothing is configured.
 */
export async function getFeedbackNotificationRecipients(): Promise<string[]> {
  const recipients = new Set<string>();
  try {
    for (const email of await listAdminEmails()) {
      recipients.add(email);
    }
  } catch (err) {
    console.error("[feedback-email] failed to resolve admin emails", err);
  }
  const override = (process.env.FEEDBACK_EMAIL ?? "").trim();
  if (override) recipients.add(override);
  return [...recipients];
}

/** Resolve a friendly "username or email" label for the maintainer's context. */
async function resolveUserLabel(userId: string): Promise<string | null> {
  try {
    const user = await getUserById(userId);
    return user?.username || user?.email || null;
  } catch {
    return null;
  }
}

/** Send one message per recipient; isolate per-recipient failures. */
async function fanOut(
  recipients: string[],
  build: (to: string) => Parameters<typeof sendEmail>[0],
): Promise<void> {
  await Promise.allSettled(recipients.map((to) => sendEmail(build(to))));
}

/** Notify admins of a NEW feedback submission. */
export async function notifyAdminsNewFeedback(opts: {
  userId: string;
  feedbackType: string;
  message: string;
  pageUrl?: string | null;
  appVersion?: string | null;
}): Promise<void> {
  const recipients = await getFeedbackNotificationRecipients();
  if (recipients.length === 0) return;
  const userLabel = await resolveUserLabel(opts.userId);
  await fanOut(recipients, (to) =>
    feedbackNotificationEmail({
      to,
      feedbackType: opts.feedbackType,
      message: opts.message,
      userId: opts.userId,
      userLabel,
      pageUrl: opts.pageUrl ?? null,
      appVersion: opts.appVersion ?? null,
    }),
  );
}

/**
 * Notify admins of a NEW user signup so the maintainer can monitor growth
 * without logging into /admin. Best-effort + fire-and-forget by the caller.
 */
export async function notifyAdminsNewSignup(opts: {
  userId: string;
  username: string;
  email?: string | null;
}): Promise<void> {
  const recipients = await getFeedbackNotificationRecipients();
  if (recipients.length === 0) return;
  let totalUsers: number | null = null;
  try {
    totalUsers = await getUserCount();
  } catch {
    totalUsers = null;
  }
  await fanOut(recipients, (to) =>
    newSignupNotificationEmail({
      to,
      userId: opts.userId,
      username: opts.username,
      email: opts.email ?? null,
      totalUsers,
    }),
  );
}

/** Notify admins of a user REPLY on an existing feedback thread. */
export async function notifyAdminsFeedbackReply(opts: {
  userId: string;
  feedbackId: number;
  feedbackType?: string | null;
  body: string;
  /** The reply moved the ticket from resolved to reopened. */
  reopened?: boolean;
}): Promise<void> {
  const recipients = await getFeedbackNotificationRecipients();
  if (recipients.length === 0) return;
  const userLabel = await resolveUserLabel(opts.userId);
  await fanOut(recipients, (to) =>
    feedbackReplyNotificationEmail({
      to,
      feedbackId: opts.feedbackId,
      feedbackType: opts.feedbackType ?? null,
      body: opts.body,
      userId: opts.userId,
      userLabel,
      reopened: opts.reopened,
    }),
  );
}
