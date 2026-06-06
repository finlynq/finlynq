/**
 * Email-import rule transforms (2026-06-16) — PURE.
 *
 * Applies a rule's field mapping (flip-sign / date-source / payee-override) and
 * any per-email manual overrides to a parsed body candidate, producing the
 * effective { date, amount, payee } that the single materialize path
 * (recordEmailInboxRow) hashes + writes to the ledger.
 *
 * No DB / clock / network — same posture as parse-body.ts. The transformed
 * values feed generateImportHash(date, accountId, amount, payee), so the
 * bank-ledger dedup keys on what the user actually recorded (a flipped /
 * renamed / date-shifted re-send dedups against the transformed identity).
 *
 * Precedence, PER FIELD: explicit per-email override > rule transform > raw
 * candidate. A per-email `amountOverride` is the FINAL signed amount — flip is
 * deliberately NOT re-applied on top of it (the UI shows the flipped preview
 * before the user hand-edits, so a manual edit is authoritative).
 */

export interface EmailTransform {
  /** Rule-level: multiply the parsed amount by -1 (0 stays +0). */
  flipSign?: boolean;
  /** Rule-level: 'parsed' = body-parsed date (default), 'received' = email date. */
  dateSource?: "parsed" | "received";
  /** Rule-level: force a fixed payee regardless of the parsed value. */
  payeeOverride?: string | null;
  /** Per-email manual: final signed amount (authoritative; flip not re-applied). */
  amountOverride?: number | null;
  /** Per-email manual: YYYY-MM-DD. */
  dateOverride?: string | null;
  /** Per-email manual: fixed payee (beats the rule-level payeeOverride). */
  payeeOverridePerEmail?: string | null;
}

export interface TransformInput {
  date: string;
  amount: number;
  payee: string;
}

export type TransformOutput = TransformInput;

/** Flip a signed amount, keeping +0 as +0 (never produce -0). Mirrors the knob
 *  in excel-parser.ts / column-mapping-dialog.tsx. */
export function flipAmountSign(amount: number): number {
  return amount === 0 ? 0 : -amount;
}

function nonEmpty(s: string | null | undefined): string | null {
  return typeof s === "string" && s.trim() !== "" ? s : null;
}

/**
 * Compute the effective candidate from the raw parsed candidate + transforms.
 * `receivedDate` (YYYY-MM-DD, from email_inbox.received_at) is used only when
 * dateSource === 'received'; a null receivedDate falls back to the candidate
 * date so a missing date never breaks hashing.
 */
export function applyEmailTransform(
  cand: TransformInput,
  t: EmailTransform,
  receivedDate: string | null,
): TransformOutput {
  // amount: explicit per-email override is final; else rule flip; else raw.
  const amount =
    t.amountOverride != null
      ? t.amountOverride
      : t.flipSign
        ? flipAmountSign(cand.amount)
        : cand.amount;

  // date: explicit per-email override; else 'received' (when available); else raw.
  const date =
    nonEmpty(t.dateOverride) ??
    (t.dateSource === "received" ? receivedDate ?? cand.date : cand.date);

  // payee: per-email override beats the rule-level override beats raw.
  const payee =
    nonEmpty(t.payeeOverridePerEmail) ?? nonEmpty(t.payeeOverride) ?? cand.payee;

  return { date, amount, payee };
}
