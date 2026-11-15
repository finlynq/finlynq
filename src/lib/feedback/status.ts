/**
 * Feedback ticket statuses and the rules that move a ticket between them.
 * Pure and client-safe: the admin page, the user page and the API routes all
 * read the list and the rules from here.
 *
 *   new       submitted, nobody has looked at it yet
 *   reopened  it was resolved, then the user wrote again
 *   triaged   the maintainer is on it (an admin reply puts it here)
 *   resolved  done
 *
 * A user reply on a resolved ticket reopens it, so a follow-up never sits
 * unseen in the Resolved bucket. A user reply on any other status changes
 * nothing. An admin reply moves new and reopened tickets to triaged, and never
 * resolves or demotes one.
 */

import type { FeedbackStatus } from "@shared/types";

export const FEEDBACK_STATUSES = [
  "new",
  "reopened",
  "triaged",
  "resolved",
] as const satisfies readonly FeedbackStatus[];

// Compile-time check that the list above names every FeedbackStatus.
type MissingStatus = Exclude<FeedbackStatus, (typeof FEEDBACK_STATUSES)[number]>;
const _everyStatusListed: MissingStatus extends never ? true : never = true;
void _everyStatusListed;

/** The status a user reply reopens, and the status it reopens it to. */
export const REOPENS_ON_USER_REPLY = "resolved" satisfies FeedbackStatus;
export const REOPENED_STATUS = "reopened" satisfies FeedbackStatus;

export function isFeedbackStatus(value: unknown): value is FeedbackStatus {
  return (
    typeof value === "string" &&
    (FEEDBACK_STATUSES as readonly string[]).includes(value)
  );
}

/** Status after the ticket's owner posts a reply. */
export function statusAfterUserReply(status: FeedbackStatus): FeedbackStatus;
export function statusAfterUserReply(status: string): string;
export function statusAfterUserReply(status: string): string {
  return status === REOPENS_ON_USER_REPLY ? REOPENED_STATUS : status;
}

/** Status after the maintainer posts a reply. */
export function statusAfterAdminReply(status: FeedbackStatus): FeedbackStatus;
export function statusAfterAdminReply(status: string): string;
export function statusAfterAdminReply(status: string): string {
  return status === "new" || status === REOPENED_STATUS ? "triaged" : status;
}
