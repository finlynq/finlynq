/**
 * SimpleFIN sync outcome → persisted status + auto-sync retry decision.
 *
 * Pure and DB-free so it can be unit-tested in isolation. The orchestrator
 * stores the status this module builds under a PLAINTEXT settings key, so the
 * message is assembled ONLY from static text, HTTP codes and counts — never an
 * account name (DEK-encrypted at rest; `syncSimpleFin`'s per-account errors
 * embed it), a bank name, or a provider response body.
 *
 * Retry policy for the login-triggered auto-sync (12h throttle):
 *   - success, or a sync that ran but reported per-account problems → the
 *     throttle stands (re-pulling immediately would not fix a bank-side issue
 *     and spends the user's SimpleFIN request quota).
 *   - a transient whole-sync failure (timeout, 5xx, network, DB) → retry
 *     allowed after AUTO_SYNC_RETRY_BACKOFF_MS instead of burning 12h.
 *   - a failure that needs the USER to act (rejected/invalid credentials,
 *     not connected) → the throttle stands; retrying cannot succeed.
 */
import { simplefin } from "@finlynq/import-connectors";
import type { SimplefinSyncResult } from "./simplefin-orchestrator";

/** Min gap between login-triggered auto-syncs per user. */
export const AUTO_SYNC_MIN_INTERVAL_MS = 12 * 60 * 60 * 1000;
/** After a transient failure, the next login may retry once this has passed. */
export const AUTO_SYNC_RETRY_BACKOFF_MS = 60 * 60 * 1000;

export type SimplefinSyncTrigger = "auto" | "manual";

/** Outcome of the most recent SimpleFIN sync (auto or manual). */
export interface SimplefinSyncStatus {
  ok: boolean;
  /** The sync ran, but one or more accounts reported problems. */
  partial: boolean;
  trigger: SimplefinSyncTrigger;
  /** ISO timestamp of the attempt. */
  at: string;
  /** Safe-to-store summary, present only when ok is false. */
  message?: string;
}

export type SimplefinSyncOutcome =
  | { result: Pick<SimplefinSyncResult, "errors"> }
  | { error: unknown };

export interface SummarizedOutcome {
  status: SimplefinSyncStatus;
  /** Auto-sync only: re-open the throttle after the short backoff. */
  retrySooner: boolean;
}

function describeError(err: unknown): { message: string; retrySooner: boolean } {
  if (err instanceof simplefin.SimpleFinApiError) {
    const code = err.httpStatus;
    if (code === 401 || code === 403) {
      return {
        message: `SimpleFIN rejected the saved connection (HTTP ${code}). Reconnect the bank feed.`,
        retrySooner: false,
      };
    }
    if (code === 0) {
      return {
        message: "The saved SimpleFIN connection is invalid. Reconnect the bank feed.",
        retrySooner: false,
      };
    }
    if (code === 504) {
      return {
        message: "SimpleFIN took too long to respond. Your bank may be mid-sync.",
        retrySooner: true,
      };
    }
    return { message: `SimpleFIN returned an error (HTTP ${code}).`, retrySooner: true };
  }
  // Matched by name: the class lives in the orchestrator, which imports this
  // module, so a runtime import would be circular.
  if (err instanceof Error && err.name === "SimplefinNotConnectedError") {
    return { message: "SimpleFIN is not connected.", retrySooner: false };
  }
  return { message: "The sync failed before any account was processed.", retrySooner: true };
}

export function summarizeSimplefinSyncOutcome(
  outcome: SimplefinSyncOutcome,
  trigger: SimplefinSyncTrigger,
  now: Date = new Date(),
): SummarizedOutcome {
  const at = now.toISOString();
  if ("result" in outcome) {
    const n = outcome.result.errors.length;
    if (n === 0) {
      return { status: { ok: true, partial: false, trigger, at }, retrySooner: false };
    }
    return {
      status: {
        ok: false,
        partial: true,
        trigger,
        at,
        message: `${n} problem${n === 1 ? " was" : "s were"} reported during the sync.`,
      },
      retrySooner: false,
    };
  }
  const { message, retrySooner } = describeError(outcome.error);
  return { status: { ok: false, partial: false, trigger, at, message }, retrySooner };
}

/**
 * The throttle timestamp to store after a transient auto-sync failure: back-
 * dated so that `now - stamp` reaches AUTO_SYNC_MIN_INTERVAL_MS exactly when
 * the backoff has elapsed.
 */
export function retryStampIso(now: Date): string {
  return new Date(now.getTime() - AUTO_SYNC_MIN_INTERVAL_MS + AUTO_SYNC_RETRY_BACKOFF_MS).toISOString();
}

/** Parse a stored status; anything malformed reads as "no status". */
export function parseSyncStatus(raw: string | null | undefined): SimplefinSyncStatus | null {
  if (!raw) return null;
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!v || typeof v !== "object") return null;
  const o = v as Record<string, unknown>;
  if (typeof o.ok !== "boolean" || typeof o.at !== "string") return null;
  return {
    ok: o.ok,
    partial: o.partial === true,
    trigger: o.trigger === "manual" ? "manual" : "auto",
    at: o.at,
    ...(typeof o.message === "string" ? { message: withoutLegacyHint(o.message) } : {}),
  };
}

/**
 * Statuses stored before 2026-10-18 end with a sentence promising details the
 * page never showed. The page now adds its own call to action, so the old
 * sentence is dropped on read rather than shown twice.
 */
const LEGACY_DETAILS_HINT = " Run a sync from this page to see the details.";
function withoutLegacyHint(message: string): string {
  return message.endsWith(LEGACY_DETAILS_HINT)
    ? message.slice(0, -LEGACY_DETAILS_HINT.length)
    : message;
}

/** Longest error text shown as-is for one account; longer means internals. */
const MAX_ACCOUNT_ERROR_LENGTH = 200;

/**
 * The line shown to the user when one account fails while being staged. This
 * text goes back to the user's own browser (never into the plaintext status),
 * so it may name the account, but a raw database error is replaced: Drizzle's
 * "Failed query: …" carries the SQL and its parameters (ciphertext included).
 */
export function accountProblemMessage(accountName: string, err: unknown): string {
  const raw = err instanceof Error ? err.message.trim() : "";
  const usable =
    raw !== "" && raw.length <= MAX_ACCOUNT_ERROR_LENGTH && !/^failed query/i.test(raw);
  return usable
    ? `Account "${accountName}": ${raw}`
    : `Account "${accountName}": could not be imported because of a server error.`;
}

// ─── How far back each sync asks SimpleFIN for (2026-11-15) ─────────────────
//
// Measured against SimpleFIN's developer demo: a 44-day request comes back
// clean; 45 to 89 days return the data plus "Requested date range exceeds
// recommended range of 45 days. In the future, this may be capped."; 90 days is
// cut to 90 with "...exceeds limit of 90 days and was capped." We used to ask
// for 90 days every time, so EVERY sync reported one SimpleFIN problem and a
// real one (a bank connection needing a new sign-in) looked the same.

/** The longest window SimpleFIN answers without a warning. */
export const SIMPLEFIN_RECOMMENDED_WINDOW_DAYS = 44;
/** The longest window under SimpleFIN's hard 90-day limit. */
export const SIMPLEFIN_MAX_WINDOW_DAYS = 89;
/** Days re-read before the last fetch, for transactions that post late. */
export const SIMPLEFIN_OVERLAP_DAYS = 7;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * When the last sync actually fetched from SimpleFIN: the stored status's time
 * when it ran (cleanly or with per-account problems), null when it failed
 * before fetching or there is none.
 */
export function lastFetchAt(status: SimplefinSyncStatus | null): string | null {
  if (!status) return null;
  return status.ok || status.partial ? status.at : null;
}

/**
 * Days to ask SimpleFIN for: the recommended 44 while the last fetch (plus a
 * week of overlap) fits inside it, else as much as SimpleFIN keeps, so a first
 * sync or a long gap misses nothing. Re-reading days already fetched is
 * harmless: staging skips rows the ledger already has.
 */
export function simplefinWindowDays(lastFetchIso: string | null, now: Date = new Date()): number {
  if (!lastFetchIso) return SIMPLEFIN_MAX_WINDOW_DAYS;
  const last = new Date(lastFetchIso).getTime();
  if (!Number.isFinite(last)) return SIMPLEFIN_MAX_WINDOW_DAYS;
  const daysSince = Math.max(0, (now.getTime() - last) / DAY_MS);
  return daysSince + SIMPLEFIN_OVERLAP_DAYS <= SIMPLEFIN_RECOMMENDED_WINDOW_DAYS
    ? SIMPLEFIN_RECOMMENDED_WINDOW_DAYS
    : SIMPLEFIN_MAX_WINDOW_DAYS;
}

/**
 * SimpleFIN's note about the requested date range. Expected whenever a long
 * window is needed, and not a problem with the user's bank, so it is never
 * counted or shown as one.
 */
export function isSimplefinRangeNotice(message: string): boolean {
  return /^requested date range exceeds\b/i.test(message.trim());
}

// ─── Auto-sync when the app is opened (2026-11-15) ──────────────────────────
//
// The 12h auto-sync used to run only from the login route. The web and phone
// apps keep people signed in for days, so it rarely ran and users pressed
// Sync now instead (in-app feedback #29). Opening the app (GET /api/auth/session,
// called on every web page load and tab focus and on every phone start and
// resume) now offers the same throttled sync. This in-process gate stops those
// frequent calls from
// reaching the database more than once per interval per user; the 12h slot
// itself is still claimed atomically in the database.

/** Min gap between app-open checks of the 12h slot, per user, per process. */
export const APP_OPEN_CHECK_INTERVAL_MS = 10 * 60 * 1000;
/** Forget the oldest checks past this many users, so the map can't grow forever. */
const APP_OPEN_MAX_TRACKED = 5000;

/** True when this user's app-open check should run now; records the check. */
export function takeAppOpenCheck(
  checks: Map<string, number>,
  userId: string,
  nowMs: number = Date.now(),
): boolean {
  const last = checks.get(userId);
  if (last !== undefined && nowMs - last < APP_OPEN_CHECK_INTERVAL_MS) return false;
  if (checks.size >= APP_OPEN_MAX_TRACKED && !checks.has(userId)) {
    const oldest = checks.keys().next().value;
    if (oldest !== undefined) checks.delete(oldest);
  }
  checks.delete(userId); // re-insert so Map order stays oldest-first
  checks.set(userId, nowMs);
  return true;
}
