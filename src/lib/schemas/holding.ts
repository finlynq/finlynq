/**
 * Shared Zod schemas for portfolio_holdings CRUD.
 *
 * Issue #100: This file is the SINGLE SOURCE OF TRUTH for the holding
 * create/update payload shape and the canonical-row predicate. Imported
 * from BOTH:
 *   - src/app/api/portfolio/route.ts            (server validation)
 *   - src/components/holdings/holding-edit-form.tsx  (client validation + UX)
 *
 * Why a shared module: before this issue the form lived inline in
 * /portfolio/page.tsx and the API hand-rolled its own copies of the same
 * schema + canonical predicate. Two surfaces drifting silently was the
 * load-bearing risk that motivated the extraction (PR #77 had to disable
 * the Name field on canonical rows; making /settings/investments host a
 * second copy of the form would have guaranteed they got out of sync).
 *
 * The canonical predicate is also mirrored in
 * src/lib/crypto/stream-d-canonicalize-portfolio.ts (the runtime helper
 * that rewrites names back to canonical form on next login). Keep all
 * three classifiers in sync — the predicate here, the canonicalize
 * helper, and the API route's call site that uses this module.
 */

import { z } from "zod";
import { isSupportedCurrency, isMetalCurrency } from "@/lib/fx/supported-currencies";

// Currency: any 3-4 letter ISO 4217 / metal code, normalized to uppercase.
// Was previously z.enum(["CAD","USD"]) which silently rejected EUR/GBP/BTC
// etc. — fixed 2026-04-27 alongside the holding-currency redesign.
export const currencyCode = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z]{3,4}$/, "Currency must be a 3-4 letter ISO 4217 code");

export const holdingCreateSchema = z.object({
  name: z.string().min(1).max(200),
  accountId: z.number().int(),
  symbol: z.string().max(50).nullable().optional(),
  currency: currencyCode.optional(),
  isCrypto: z.boolean().optional(),
  note: z.string().max(500).optional(),
});

export const holdingUpdateSchema = z.object({
  id: z.number(),
  name: z.string().min(1).max(200).optional(),
  symbol: z.string().max(50).nullable().optional(),
  currency: currencyCode.optional(),
  // PUT accepts the legacy 0/1 int form (matches the existing API contract).
  isCrypto: z.number().int().min(0).max(1).optional(),
  note: z.string().max(500).optional(),
});

export type HoldingCreateInput = z.infer<typeof holdingCreateSchema>;
export type HoldingUpdateInput = z.infer<typeof holdingUpdateSchema>;

/**
 * A row is "canonical" (its display name is auto-managed) when:
 *   - it has a non-empty symbol that isn't a currency code → tickered;
 *     canonical name = uppercased symbol.
 *   - it has a currency-code symbol (CAD/USD/XAU/etc.) → cash-as-currency;
 *     canonical name = "Cash <SYMBOL>".
 *   - name === "Cash" with no symbol → cash sleeve; canonical name = "Cash".
 *
 * Editing the Name on these rows is a no-op (the canonicalize helper would
 * rewrite it on next login) and confuses the user, so we reject it at the
 * API and disable the input on the client. Symbol / currency / isCrypto /
 * note remain editable; renaming a tickered position is done by changing
 * its symbol.
 *
 * Mirrors the classifier in src/lib/crypto/stream-d-canonicalize-portfolio.ts.
 */
export function isCanonicalHolding(name: string | null, symbol: string | null): boolean {
  const sym = (symbol ?? "").trim().toUpperCase();
  const nm = (name ?? "").trim();
  if (sym && /^[A-Z]{3,4}$/.test(sym) && (isSupportedCurrency(sym) || isMetalCurrency(sym))) return true;
  if (sym) return true;
  if (!sym && nm.toLowerCase() === "cash") return true;
  return false;
}
