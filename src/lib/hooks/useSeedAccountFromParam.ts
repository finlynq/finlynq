"use client";

import { useEffect, useRef } from "react";
import { useAccountParam, type AccountField } from "./useAccountParam";

/**
 * useSeedAccountFromParam — one-shot pre-select of a portfolio-form account
 * field from the `?account=<id>` URL param (FINLYNQ-227).
 *
 * Each portfolio op form calls this with the setter for the account field the
 * param should seed (`setAccountId` for single-account forms, or the
 * source/dest setter chosen by `field` for Deposit/Withdrawal/Transfer) and the
 * set of valid account ids for that field. It seeds the field EXACTLY ONCE
 * (guarded ref), and only:
 *   - when NOT in edit mode (`isEdit === false` — edit data wins),
 *   - when the param's `accountField` matches `field` (two-account forms),
 *   - when the param id is one of `validIds` (so a stale / wrong-side id is
 *     ignored and the user just picks manually, same as today).
 *
 * Idempotent and side-effect-free when the param is absent — the form behaves
 * exactly as it did before.
 */
export function useSeedAccountFromParam({
  isEdit,
  field,
  validIds,
  setValue,
}: {
  isEdit: boolean;
  /** Which side this setter fills. Single-account forms pass "source". */
  field: AccountField;
  /** Account ids legal for this field (e.g. investment-only). */
  validIds: ReadonlyArray<number>;
  setValue: (next: string) => void;
}): void {
  const { accountId, accountField } = useAccountParam();
  const seededRef = useRef(false);

  useEffect(() => {
    if (seededRef.current) return;
    if (isEdit) return;
    if (accountId == null) return;
    if (accountField !== field) return;
    if (!validIds.includes(accountId)) return;
    seededRef.current = true;
    setValue(String(accountId));
    // validIds arrives after the async accounts fetch, so this effect re-runs
    // until the list is populated; the ref makes the actual seed one-shot.
  }, [isEdit, accountId, accountField, field, validIds, setValue]);
}
