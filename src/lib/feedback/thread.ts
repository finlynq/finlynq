/**
 * Feedback reply-thread helpers — shared by the user routes (GET /api/feedback,
 * /api/feedback/[id]) and the admin routes (list + /[id]).
 *
 * The original feedback submission is the immutable thread SEED
 * (`feedback.message`), NOT a feedback_messages row. A thread renders as
 * [seed bubble] + feedback_messages in chronological order.
 *
 * Unread is two-sided and keyed on the OTHER role: a side is never unread from
 * its own messages. NULL last-read = never opened → epoch.
 */

import type {
  FeedbackMessage,
  FeedbackStatus,
  FeedbackThreadSummary,
  FeedbackType,
} from "@shared/types";

export interface FeedbackRowForThread {
  id: number;
  type: string;
  status: string;
  message: string;
  createdAt: Date;
  updatedAt: Date;
  userLastReadAt: Date | null;
  adminLastReadAt: Date | null;
}

export interface FeedbackMessageRow {
  id: number;
  feedbackId: number;
  authorRole: string;
  authorId: string;
  body: string;
  createdAt: Date;
  // FINLYNQ-228 — optional per-message attachment (nullable on older rows).
  attachmentPath?: string | null;
  attachmentFilename?: string | null;
  attachmentMime?: string | null;
  attachmentSize?: number | null;
}

const iso = (d: Date) => new Date(d).toISOString();
const ms = (d: Date | null) => (d ? new Date(d).getTime() : 0);

/** Build the list-summary fields for one thread, from the POV of `side`. */
export function buildThreadSummary(
  fb: FeedbackRowForThread,
  msgs: FeedbackMessageRow[],
  side: "user" | "admin",
): FeedbackThreadSummary {
  const ordered = [...msgs].sort(
    (a, z) => new Date(a.createdAt).getTime() - new Date(z.createdAt).getTime(),
  );
  const last = ordered[ordered.length - 1];
  const lastBody = last ? last.body : fb.message;
  const lastAt = last ? last.createdAt : fb.createdAt;

  // Unread = a message from the OTHER role, newer than this side's last-read.
  const otherRole = side === "user" ? "admin" : "user";
  const readMs = ms(side === "user" ? fb.userLastReadAt : fb.adminLastReadAt);
  const unread = ordered.some(
    (m) => m.authorRole === otherRole && new Date(m.createdAt).getTime() > readMs,
  );

  return {
    id: fb.id,
    type: fb.type as FeedbackType,
    status: fb.status as FeedbackStatus,
    seed: fb.message,
    createdAt: iso(fb.createdAt),
    updatedAt: iso(fb.updatedAt),
    lastMessageAt: iso(lastAt),
    lastMessagePreview: lastBody.slice(0, 140),
    messageCount: ordered.length,
    unread,
  };
}

/** Map a stored message row → API shape, flagging the viewer's own messages. */
export function toFeedbackMessage(
  m: FeedbackMessageRow,
  viewerId: string,
): FeedbackMessage {
  return {
    id: m.id,
    feedbackId: m.feedbackId,
    authorRole: m.authorRole === "admin" ? "admin" : "user",
    body: m.body,
    createdAt: iso(m.createdAt),
    mine: m.authorId === viewerId,
    attachment: m.attachmentFilename
      ? {
          filename: m.attachmentFilename,
          mime: m.attachmentMime ?? null,
          size: m.attachmentSize ?? null,
        }
      : null,
  };
}
