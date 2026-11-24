/**
 * The external id of a transaction (GH #450): the id another system gave the
 * same charge, stored in `transactions.external_id` so a tool that records
 * from that system can tell what it has already recorded. Pure, client-safe.
 *
 * At most one transaction per account carries a given id (partial unique
 * index `uq_transactions_external_id`).
 */

export const EXTERNAL_ID_MAX_LENGTH = 200;

export type ExternalIdResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

/**
 * Trim and check an id from a caller. `undefined`, `null` and a blank string
 * all mean "no id" (value null). Control characters are refused so the id
 * always shows on one line.
 */
export function normalizeExternalId(raw: unknown): ExternalIdResult {
  if (raw === undefined || raw === null) return { ok: true, value: null };
  if (typeof raw !== "string") return { ok: false, message: "external_id must be a string." };
  const v = raw.trim();
  if (!v) return { ok: true, value: null };
  if (v.length > EXTERNAL_ID_MAX_LENGTH) {
    return {
      ok: false,
      message: `external_id is too long (${v.length} characters; the limit is ${EXTERNAL_ID_MAX_LENGTH}).`,
    };
  }
  for (let i = 0; i < v.length; i++) {
    const c = v.charCodeAt(i);
    if (c < 32 || c === 127) {
      return { ok: false, message: "external_id cannot contain line breaks or control characters." };
    }
  }
  return { ok: true, value: v };
}
