"use client";

import { useSearchParams } from "next/navigation";

/**
 * useAccountParam — parses the optional `?account=<id>` pre-select used by the
 * account-detail quick-actions (FINLYNQ-227).
 *
 * The portfolio op forms already seed their account field from `?editId=` in
 * edit mode (via {@link useEditId}/{@link usePortfolioFormData}); this is the
 * parallel new-entry read. The `/accounts/[id]` page deep-links into a form
 * (e.g. `/portfolio/new?op=buy&account=12`) so the chosen account is already
 * selected when the form mounts.
 *
 * Two-account forms (Deposit / Withdrawal / Transfer) have the account on
 * either the source or the dest side depending on which page launched the
 * action. `accountField` ("source" | "dest", default "source") tells the form
 * which of its two account setters to seed; single-account forms ignore it.
 *
 * Returns `null` when the param is absent or not a positive integer — the form
 * then behaves exactly as it does today.
 */
export type AccountField = "source" | "dest";

export function useAccountParam(): {
  accountId: number | null;
  accountField: AccountField;
} {
  const searchParams = useSearchParams();
  const raw = searchParams.get("account");
  const parsed = raw ? Number(raw) : null;
  const accountId =
    parsed != null && Number.isFinite(parsed) && parsed > 0 ? parsed : null;
  const accountField: AccountField =
    searchParams.get("accountField") === "dest" ? "dest" : "source";
  return { accountId, accountField };
}
