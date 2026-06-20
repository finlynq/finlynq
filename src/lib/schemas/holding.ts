/**
 * Shared Zod schemas for portfolio_holdings CRUD.
 *
 * Issue #100: This file is the SINGLE SOURCE OF TRUTH for the holding
 * create/update payload shape. Imported from BOTH:
 *   - src/app/api/portfolio/route.ts            (server validation)
 *   - src/components/holdings/holding-edit-form.tsx  (client validation + UX)
 *
 * Why a shared module: before this issue the form lived inline in
 * /portfolio/page.tsx and the API hand-rolled its own copy of the same
 * schema. Two surfaces drifting silently was the load-bearing risk that
 * motivated the extraction (making /settings/investments host a second
 * copy of the form would have guaranteed they got out of sync).
 *
 * FINLYNQ-198 (2026-06-18): the former `isCanonicalHolding` predicate (and
 * the matching login canonicalizer + per-position Name-field lock) were
 * retired here — superseded by the securities master. Display names now
 * come from the `securities` row (read-flip + copy-on-rename), so the old
 * per-position "name = symbol" auto-management no longer governs anything.
 */

import { z } from "zod";

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
