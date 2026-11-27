/**
 * GH #464 — merchant category codes (MCC, ISO 18245) on transactions.
 *
 * A bank feed (SimpleFIN `mcc`) sends a four-digit code describing the kind of
 * merchant (5812 = restaurants). It used to be turned into an `mcc:<code>` tag;
 * it now lives in its own `merchant_category_code` column on staged rows,
 * bank-ledger rows and transactions. Pure and client-safe.
 *
 * `normalizeMerchantCategoryCode` has a copy in
 * packages/import-connectors/src/simplefin/transform.ts (that package is
 * zero-dependency and can't import from here). Keep the two in sync.
 */

/** Prefix of the legacy tag form (`mcc:5812`). */
export const MERCHANT_CODE_TAG_PREFIX = "mcc:";

/**
 * Trim, require exactly four digits, and treat `0000` (the "no merchant
 * category" value some banks send) as none. Anything else → null.
 */
export function normalizeMerchantCategoryCode(raw: unknown): string | null {
  if (raw == null) return null;
  const s = String(raw).trim();
  if (!/^\d{4}$/.test(s)) return null;
  if (s === "0000") return null;
  return s;
}

/** Split a comma-separated tags string into trimmed, non-empty tags. */
function splitTags(tags: string | null | undefined): string[] {
  return (tags ?? "")
    .split(",")
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

const MCC_TAG_RE = /^mcc:\s*(\d{1,6})$/i;

/** True when a single tag is the legacy `mcc:<digits>` form. */
export function isMerchantCodeTag(tag: string): boolean {
  return MCC_TAG_RE.test(tag.trim());
}

/**
 * The tags string a rule's `tags` condition is evaluated against: the row's
 * own tags plus a virtual `mcc:<code>` tag when the row carries a code, so a
 * rule written as `tags contains mcc:5812` (the #419 advice) still matches a
 * row whose code now lives in the column. Never stored.
 */
export function tagsWithMerchantCodeTag(
  tags: string | null | undefined,
  code: string | null | undefined,
): string {
  const base = tags ?? "";
  const mcc = normalizeMerchantCategoryCode(code);
  if (!mcc) return base;
  const virtual = `${MERCHANT_CODE_TAG_PREFIX}${mcc}`;
  if (splitTags(base).some((t) => t.toLowerCase() === virtual)) return base;
  return base.trim() === "" ? virtual : `${base}, ${virtual}`;
}

/**
 * Pull every `mcc:<code>` tag out of a tags string. `code` is the first valid
 * code found (`0000` and malformed codes are dropped, not kept), `tags` is
 * what is left, joined with ", ". `found` is false when there was nothing to
 * move, so a caller can leave the row untouched.
 */
export function extractMerchantCodeTags(tags: string | null | undefined): {
  found: boolean;
  code: string | null;
  tags: string;
} {
  const parts = splitTags(tags);
  let found = false;
  let code: string | null = null;
  const kept: string[] = [];
  for (const t of parts) {
    const m = MCC_TAG_RE.exec(t);
    if (m) {
      found = true;
      if (code == null) code = normalizeMerchantCategoryCode(m[1]);
      continue;
    }
    kept.push(t);
  }
  return { found, code, tags: kept.join(", ") };
}

/** Rule condition ops for the `merchant_category_code` field. */
export type MerchantCodeOp = "is" | "starts_with" | "in";

/** The codes listed in an `in` condition value ("5812, 5813 5814"). */
export function parseMerchantCodeList(value: string): string[] {
  return value
    .split(/[\s,;]+/)
    .map((v) => v.trim())
    .filter((v) => v !== "");
}

/**
 * Evaluate a `merchant_category_code` rule condition. A row with no code
 * never matches. `starts_with` lets "581" cover 5811–5814.
 */
export function matchesMerchantCodeCondition(
  code: string | null | undefined,
  op: MerchantCodeOp,
  value: string,
): boolean {
  const mcc = normalizeMerchantCategoryCode(code);
  if (!mcc) return false;
  const v = value.trim();
  if (op === "is") return mcc === v;
  if (op === "starts_with") return v !== "" && mcc.startsWith(v);
  if (op === "in") return parseMerchantCodeList(v).includes(mcc);
  return false;
}
