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
        message: `${n} problem${n === 1 ? "" : "s"} reported during the sync. Run a sync from this page to see the details.`,
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
    ...(typeof o.message === "string" ? { message: o.message } : {}),
  };
}
