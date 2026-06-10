/**
 * Imported-email retention policy (FINLYNQ-138).
 *
 * Per-user, user-configurable window governing how long raw imported emails
 * (the `email_inbox` table — encrypted from/subject/body of each forwarded
 * email) are kept before the cleanup sweep hard-deletes them.
 *
 * Scope: this policy governs `email_inbox` ONLY. The derived
 * `staged_imports` / `staged_transactions` rows keep their own 14-day pending
 * TTL (see cleanup.ts) — they are NOT governed by this setting.
 *
 * Mechanism (user decision, 2026-06-09): the window is evaluated at SWEEP
 * TIME against the live per-user setting (the sweep JOINs the settings table).
 * A settings change immediately governs ALL existing emails — there is no
 * re-stamp pass. `email_inbox.expires_at` is still stamped at insert for the
 * "next purge" UI display, but the sweep MUST NOT treat it as the source of
 * truth; it evaluates `received_at + window < now` from the live setting.
 *
 * Bounded windows only — no keep-forever sentinel (privacy-hardening posture +
 * storage growth). Default = 60 days, which preserves the pre-FINLYNQ-138
 * behavior for users who never touch the setting.
 */

/** Settings key in the `settings` key/value table. */
export const EMAIL_RETENTION_SETTING_KEY = "email_retention_days";

/** Allowed retention windows, in days. Bounded — no keep-forever option. */
export const EMAIL_RETENTION_OPTIONS = [7, 30, 60, 90] as const;

export type EmailRetentionDays = (typeof EMAIL_RETENTION_OPTIONS)[number];

/** Default window when the user has no setting row. Preserves legacy 60-day TTL. */
export const DEFAULT_EMAIL_RETENTION_DAYS: EmailRetentionDays = 60;

/**
 * Validate a candidate retention window. Returns the value when it is one of
 * the bounded options, else `null`. Rejects out-of-range numbers AND any
 * keep-forever sentinel (0, -1, Infinity, etc.) — the caller turns `null` into
 * an HTTP 400.
 */
export function parseRetentionDays(value: unknown): EmailRetentionDays | null {
  const n = typeof value === "number" ? value : Number(value);
  if (!Number.isInteger(n)) return null;
  return (EMAIL_RETENTION_OPTIONS as readonly number[]).includes(n)
    ? (n as EmailRetentionDays)
    : null;
}

/**
 * Coerce a raw stored settings value (always a string in the `settings` table,
 * or `undefined` when unset) into an effective window. Unknown / unset / junk
 * values fall back to the 60-day default so a malformed row can never disable
 * the sweep.
 */
export function resolveRetentionDays(
  storedValue: string | null | undefined,
): EmailRetentionDays {
  if (storedValue == null) return DEFAULT_EMAIL_RETENTION_DAYS;
  return parseRetentionDays(storedValue) ?? DEFAULT_EMAIL_RETENTION_DAYS;
}

/**
 * Pure expiry predicate, single-sourced for the sweep + the "next purge" UI.
 * An email is expired when `received_at + windowDays <= now`.
 */
export function isInboxRowExpired(
  receivedAt: Date,
  windowDays: number,
  now: Date,
): boolean {
  const expiryMs = receivedAt.getTime() + windowDays * 24 * 60 * 60 * 1000;
  return expiryMs <= now.getTime();
}

/**
 * The scheduled purge date for a single email, derived from the live window
 * (NOT the stamped `expires_at`). Drives the inbox "next purge" indicator.
 */
export function nextPurgeAt(receivedAt: Date, windowDays: number): Date {
  return new Date(receivedAt.getTime() + windowDays * 24 * 60 * 60 * 1000);
}
