/**
 * GET /api/settings/bank-feeds/simplefin/pending (FINLYNQ-249)
 *
 * Returns the caller's CURRENT SimpleFIN pending-charges snapshot, decrypted:
 *   { success: true, data: { pending: PendingChargeRow[] } }
 *
 * This is a LIVE snapshot (not history) — `replacePendingTransactions` refreshes
 * each account's rows on every sync. Holds / not-yet-posted charges are NOT in
 * the ledger; this is a read-only report.
 *
 * Owner-scoped (`user_id` predicate in listPendingTransactions). Uses
 * apiHandler({ auth: "encryption" }) so payee/description decrypt with the
 * session DEK and a request without a DEK is refused with 423 (never ciphertext),
 * and so the FINLYNQ-261 api-handler-adoption guardrail passes. The new
 * Bank-feeds "Pending charges" panel is the only consumer → the default
 * envelope is safe (no bare-shape mobile/legacy consumer).
 */

import { apiHandler } from "@/lib/api-handler";
import { listPendingTransactions } from "@/lib/external-import/simplefin-pending";

export const dynamic = "force-dynamic";

export const GET = apiHandler({ auth: "encryption" }, async ({ userId, dek }) => {
  // dek is guaranteed non-null under auth: "encryption" (the 423 gate).
  const pending = await listPendingTransactions(userId, dek as Buffer);
  return { pending };
});
