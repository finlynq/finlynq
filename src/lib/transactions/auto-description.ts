/**
 * Where the app's own description of a transaction goes (2026-11-24, owner
 * request): in the NOTE, never the payee. The payee is for who was paid;
 * "Transfer to Savings" is not a payee, and putting it there filled the
 * payee list and its suggestions with app-made text. Pure, client-safe.
 *
 * Writers: transfers (createTransferPair / updateTransferPair and their
 * ViaSql twins in lib/transfer.ts), swaps (lib/portfolio/operations.ts),
 * opening balances and loan interest entries (payee left empty: their notes
 * already describe them). File importers keep their own payee text, since
 * their duplicate fingerprint is computed over it.
 */

export function transferDescription(direction: "out" | "in", otherAccountName: string | null): string {
  const other = otherAccountName ?? "another account";
  return direction === "out" ? `Transfer to ${other}` : `Transfer from ${other}`;
}

/**
 * The note of each leg of a transfer. A note the person wrote goes on both
 * legs unchanged. With no note of their own, each leg describes the transfer
 * from its side ("Transfer to Savings" / "Transfer from Chequing").
 *
 * On an EDIT, pass the accounts the transfer had before: a note that is
 * still the old automatic text (the edit dialog sends it back) counts as no
 * note, so it follows a change of account instead of going stale.
 */
export function transferLegNotes(
  userNote: string | null | undefined,
  fromName: string | null,
  toName: string | null,
  previous?: { fromName: string | null; toName: string | null },
): { source: string; dest: string } {
  const n = (userNote ?? "").trim();
  const isAuto =
    n === "" ||
    (previous != null &&
      (n === transferDescription("out", previous.toName) || n === transferDescription("in", previous.fromName)));
  if (!isAuto) return { source: userNote as string, dest: userNote as string };
  return { source: transferDescription("out", toName), dest: transferDescription("in", fromName) };
}

/**
 * The note after moving a payee's text into it (Settings → Payees & tags,
 * "Move to note"): the payee alone when there was no note, unchanged when the
 * note already says it, else payee first, then the note.
 */
export function noteWithPayee(payee: string, note: string | null | undefined): string {
  const p = payee.trim();
  const n = (note ?? "").trim();
  if (!n) return p;
  if (n.toLowerCase().includes(p.toLowerCase())) return n;
  return `${p} · ${n}`;
}
