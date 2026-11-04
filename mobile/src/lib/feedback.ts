// "Your feedback" wording for the thread list and thread screens. Pure, so the
// screens only render what these return. The text mirrors the web's /feedback
// page (src/app/(app)/feedback/page.tsx): keep in sync.
//
// Attachments are shown by name with a link to the website, not opened here:
// the serve route needs the app's session, which a browser opened from the
// phone does not have, so a direct link would answer 401. Replying with a file
// stays on the web.
import { syncTimeLabel } from "./bank-feed";
import type {
  FeedbackAttachmentMeta,
  FeedbackMessage,
  FeedbackStatus,
  FeedbackThread,
  FeedbackThreadSummary,
  FeedbackType,
} from "../../../shared/types";

export const FEEDBACK_LIST_HINT = "Track your reports and follow up on replies from the team.";
export const FEEDBACK_EMPTY_TEXT = "You haven't sent any feedback yet.";
export const FEEDBACK_LIST_ERROR = "Failed to load your feedback.";
export const FEEDBACK_THREAD_ERROR = "Failed to load this thread.";
export const FEEDBACK_THREAD_HINT =
  "Replies from the team appear here. Please don't include sensitive financial details.";
export const FEEDBACK_REPLY_ERROR = "Failed to send reply.";
export const FEEDBACK_NETWORK_ERROR = "Could not reach the server. Try again in a moment.";

const TYPE_LABELS: Record<FeedbackType, string> = {
  bug: "Bug",
  idea: "Idea",
  question: "Question",
  other: "Other",
};

const STATUS_LABELS: Record<FeedbackStatus, string> = {
  new: "New",
  triaged: "Triaged",
  resolved: "Resolved",
};

export function feedbackTypeLabel(type: FeedbackType): string {
  return TYPE_LABELS[type] ?? type;
}

export function feedbackStatusLabel(status: FeedbackStatus): string {
  return STATUS_LABELS[status] ?? status;
}

export function threadTitle(thread: Pick<FeedbackThread, "type"> | null): string {
  return thread ? `${feedbackTypeLabel(thread.type)} feedback` : "Feedback";
}

/** Null for a thread with no replies yet (the seed is not a reply). */
export function replyCountLabel(count: number): string | null {
  if (count <= 0) return null;
  return `${count} ${count === 1 ? "reply" : "replies"}`;
}

/** The "New reply" badge on the More row, like the web nav's. */
export function countUnreadThreads(threads: FeedbackThreadSummary[]): number {
  return threads.filter((t) => t.unread).length;
}

export function feedbackMeta(author: "user" | "admin", at: string, now: Date = new Date()): string {
  return `${author === "user" ? "You" : "Finlynq team"} · ${syncTimeLabel(at, now)}`;
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

export function attachmentLabel(a: FeedbackAttachmentMeta): string {
  const name = a.filename ?? "attachment";
  return a.size == null ? name : `${name} (${formatBytes(a.size)})`;
}

/** The website's page for these threads (it asks a signed-out browser to sign in). */
export function feedbackWebUrl(serverUrl: string): string {
  return `${serverUrl}/feedback`;
}

/**
 * What to show for a refused reply. The server's own message is kept ("Too many
 * replies…"), but request() words a dropped connection for the log and falls back
 * to a bare status when a response has no message, neither of which says anything.
 */
export function replyErrorText(error: string | undefined): string {
  if (!error || /^HTTP \d+$/.test(error)) return FEEDBACK_REPLY_ERROR;
  return error.startsWith("Network error") ? FEEDBACK_NETWORK_ERROR : error;
}

export function withReply(thread: FeedbackThread, message: FeedbackMessage): FeedbackThread {
  return {
    ...thread,
    messages: [...thread.messages, message],
    messageCount: thread.messageCount + 1,
  };
}
