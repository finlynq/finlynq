/**
 * parseSaveError — client-side helper for turning a failed mutating-fetch
 * `Response` into a user-facing message (FINLYNQ-142).
 *
 * Money pages (goals/budgets/subscriptions) historically had ZERO `res.ok`
 * checks, so a failed save silently closed the dialog and discarded input.
 * This helper centralizes the two cases the UI must distinguish:
 *
 *   - **423 Locked** — `requireEncryption` refused because the session has
 *     no DEK. This is NOT a generic failure; the user just needs to unlock
 *     their data (sign in again). Always surfaces the dedicated message so
 *     callers never bury it under a generic "save failed".
 *   - **everything else** — prefer the server's parsed `{ error }` / `{ message }`
 *     body, falling back to the caller-supplied generic message.
 *
 * The caller owns keeping the dialog open + rendering the returned string.
 */

export const DEK_LOCKED_MESSAGE = "Unlock your data to make changes";

export async function parseSaveError(
  res: Response,
  fallback = "Something went wrong. Please try again.",
): Promise<string> {
  // 423 = requireEncryption refused (no DEK). Never a generic failure.
  if (res.status === 423) return DEK_LOCKED_MESSAGE;
  const body = await res.json().catch(() => null);
  return body?.error || body?.message || fallback;
}
